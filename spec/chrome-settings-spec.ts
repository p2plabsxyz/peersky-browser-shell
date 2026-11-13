import { expect } from 'chai'

import { BrowsingDataAPI, parseOrigin } from '../src/browser/api/browsing-data'
import { ContentSettingsAPI, parseContentPattern } from '../src/browser/api/content-settings'
import { FontSettingsAPI } from '../src/browser/api/font-settings'
import { PrivacyAPI } from '../src/browser/api/privacy'
import { last, settingsHarness, tick } from './settings-harness'

describe('chrome.privacy', () => {
  const setup = (state: Record<string, unknown> = {}) => {
    const h = settingsHarness(state)
    const api = new PrivacyAPI(h.ctx)
    const a = h.extension('ext-a', ['privacy'])
    const b = h.extension('ext-b', ['privacy'])
    const none = h.extension('ext-none', [])
    return { ...h, api, a, b, none }
  }
  const dnt = 'privacy.websites.doNotTrackEnabled'

  it("gives Chrome's defaults and levels of control between two extensions", async () => {
    const h = setup()
    await h.load(h.a)
    await h.load(h.b)
    expect(await h.call(`${dnt}.get`, h.a, {})).to.deep.equal({ levelOfControl: 'controllable_by_this_extension', value: false })
    await h.call(`${dnt}.set`, h.a, { value: true })
    expect(await h.call(`${dnt}.get`, h.a, {})).to.deep.equal({ levelOfControl: 'controlled_by_this_extension', value: true })
    // b was installed after a, so it may take over.
    expect((await h.call(`${dnt}.get`, h.b, {})).levelOfControl).to.equal('controllable_by_this_extension')
    await h.call(`${dnt}.set`, h.b, { value: false })
    expect(await h.call(`${dnt}.get`, h.a, {})).to.deep.equal({ levelOfControl: 'controlled_by_other_extensions', value: false })
    // a's own value is kept and counts again once b lets go.
    await h.call(`${dnt}.clear`, h.b, {})
    expect(await h.call(`${dnt}.get`, h.b, {})).to.deep.equal({ levelOfControl: 'controllable_by_this_extension', value: true })
  })

  it('tells each extension with the permission its own view, and nobody else', async () => {
    const h = setup()
    await h.load(h.a)
    await h.load(h.b)
    await h.load(h.none)
    await h.call(`${dnt}.set`, h.a, { value: true })
    const changes = h.events.filter((e) => e.name === `${dnt}.onChange`)
    expect(changes.map((e) => [e.extensionId, e.args[0]])).to.deep.equal([
      ['ext-a', { levelOfControl: 'controlled_by_this_extension', value: true }],
      ['ext-b', { levelOfControl: 'controllable_by_this_extension', value: true }],
    ])
    // Setting the same value again changes nothing, so nobody hears of it.
    await h.call(`${dnt}.set`, h.a, { value: true })
    expect(h.events.filter((e) => e.name === `${dnt}.onChange`)).to.have.length(2)
    expect(h.emitted.find((e) => e.name === 'privacy-setting-changed')?.payload).to.deep.equal({
      name: 'websites.doNotTrackEnabled',
      value: true,
      controlledBy: 'ext-a',
    })
  })

  it('keeps settings across a restart and stops counting an unloaded extension', async () => {
    const state = {}
    const h = setup(state)
    await h.load(h.a)
    await h.call('privacy.network.webRTCIPHandlingPolicy.set', h.a, { value: 'disable_non_proxied_udp' })
    await h.unload(h.a)
    expect(h.api.get('network.webRTCIPHandlingPolicy')).to.equal('default')

    const after = setup(state)
    expect(after.api.get('network.webRTCIPHandlingPolicy')).to.equal('default')
    await after.load(after.a)
    expect(after.api.get('network.webRTCIPHandlingPolicy')).to.equal('disable_non_proxied_udp')
    expect(after.api.getAll().network.webRTCIPHandlingPolicy).to.equal('disable_non_proxied_udp')
  })

  it('adds DNT and drops Referer on the requests the bridge passes it', async () => {
    const h = setup()
    expect(h.api.requestHeadersFor({ Accept: '*/*' })).to.equal(undefined)
    await h.call(`${dnt}.set`, h.a, { value: true })
    await h.call('privacy.websites.referrersEnabled.set', h.a, { value: false })
    expect(h.api.requestHeadersFor({ Accept: '*/*', referer: 'https://a.example/' })).to.deep.equal({
      Accept: '*/*',
      DNT: '1',
    })
  })

  it('refuses what Chrome refuses, with its messages', async () => {
    const h = setup()
    const np = 'privacy.network.networkPredictionEnabled'
    const cases: Array<[string, any[], string]> = [
      [`${np}.set`, [{ value: 'yes' }], 'Invalid invocation'],
      [`${np}.set`, [{ value: true, foo: 1 }], 'Invalid invocation'],
      [`${np}.set`, [{ value: true, scope: 'bogus' }], 'Invalid invocation'],
      [`${np}.set`, [], 'Error in invocation of types.ChromeSetting.set(object details, optional function callback): No matching signature.'],
      [`${np}.set`, [{ value: true, scope: 'incognito_session_only' }], 'You do not have permission to access incognito preferences.'],
      [`${np}.get`, [{ incognito: true }], 'You do not have permission to access incognito preferences.'],
      ['privacy.websites.topicsEnabled.set', [{ value: true }], 'Extensions aren’t allowed to enable Privacy Sandbox APIs.'],
      ['privacy.services.autofillSettings.set', [{ value: ['payments'] }], 'Invalid invocation'],
    ]
    for (const [name, args, message] of cases) {
      expect(await h.errorOf(h.call(name, h.a, ...args)), `${name} ${JSON.stringify(args)}`).to.equal(message)
    }
    // An incognito clear is taken and changes nothing, as in Chrome.
    expect(await h.errorOf(h.call(`${np}.clear`, h.a, { scope: 'incognito_persistent' }))).to.equal(undefined)
    expect(h.events).to.have.length(0)
  })

  it('treats autofillEnabled as the address setting, as Chrome does', async () => {
    const h = setup()
    await h.call('privacy.services.autofillEnabled.set', h.a, { value: false })
    expect(await h.call('privacy.services.autofillAddressEnabled.get', h.a, {})).to.deep.equal({
      levelOfControl: 'controlled_by_this_extension',
      value: false,
    })
    expect(h.api.get('services.autofillCreditCardEnabled')).to.equal(true)
  })

  it('keeps regular_only apart from regular', async () => {
    const h = setup()
    const np = 'privacy.network.networkPredictionEnabled'
    await h.call(`${np}.set`, h.a, { value: false, scope: 'regular_only' })
    await h.call(`${np}.set`, h.a, { value: true })
    expect((await h.call(`${np}.get`, h.a, {})).value).to.equal(false)
    await h.call(`${np}.clear`, h.a, { scope: 'regular_only' })
    expect((await h.call(`${np}.get`, h.a, {})).value).to.equal(true)
    await tick()
  })
})

describe('chrome.contentSettings', () => {
  const setup = (state: Record<string, unknown> = {}) => {
    const h = settingsHarness(state)
    const api = new ContentSettingsAPI(h.ctx)
    const a = h.extension('ext-a', ['contentSettings'])
    const b = h.extension('ext-b', ['contentSettings'])
    const set = (ext: any, type: string, details: any) => h.call('contentSettings.set', ext, type, details)
    const get = (ext: any, type: string, details: any) => h.call('contentSettings.get', ext, type, details)
    return { ...h, api, a, b, set, get }
  }

  it("parses patterns with Chrome's rules and messages", () => {
    const errorOf = (p: string) => {
      try {
        parseContentPattern(p)
        return 'ok'
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(errorOf('<all_urls>')).to.equal('ok')
    expect(errorOf('*://*/*')).to.equal('ok')
    expect(errorOf('https://*.a.example/*')).to.equal('ok')
    expect(errorOf('file:///tmp/x.html')).to.equal('ok')
    expect(errorOf('http://[::1]:8080/*')).to.equal('ok')
    expect(errorOf('not a pattern')).to.equal('Missing scheme separator.')
    expect(errorOf('chrome://settings/*')).to.equal('Invalid scheme.')
    expect(errorOf('peersky://settings/*')).to.equal('Invalid scheme.')
    expect(errorOf('http:/x/*')).to.equal('Wrong scheme type.')
    expect(errorOf('http://a.example')).to.equal('Empty path.')
    expect(errorOf('http:///*')).to.equal('Host can not be empty.')
    expect(errorOf('http://*foo/*')).to.equal('Invalid host wildcard.')
    expect(errorOf('http://a.example:99999/*')).to.equal('Invalid port.')
    expect(errorOf('http://a.example/path')).to.equal('Specific paths are not allowed.')
    expect(errorOf('file:///tmp/*')).to.equal('Path wildcards in file URL patterns are not allowed.')
    expect(errorOf('http://*.127.0.0.1/*')).to.equal('The pattern "*" is invalid.')
    expect(parseContentPattern('HTTP://A.Example/*').key).to.equal(parseContentPattern('http://a.example/*').key)
    expect(parseContentPattern('<all_urls>').key).to.equal(parseContentPattern('*://*/*').key)
  })

  it('picks the most specific rule of the most recently installed extension', async () => {
    const h = setup()
    await h.load(h.a)
    await h.load(h.b)
    await h.set(h.a, 'javascript', { primaryPattern: '<all_urls>', setting: 'block' })
    await h.set(h.a, 'javascript', { primaryPattern: 'https://*.a.example/*', setting: 'allow' })
    expect(h.api.getContentSetting('javascript', 'https://x.a.example/')).to.equal('allow')
    expect(h.api.getContentSetting('javascript', 'https://b.example/')).to.equal('block')
    // b is newer: any rule of its that matches wins over a's.
    await h.set(h.b, 'javascript', { primaryPattern: '*://*/*', setting: 'allow' })
    expect(h.api.getContentSetting('javascript', 'https://b.example/')).to.equal('allow')
    // b's clear removes only b's rules.
    await h.call('contentSettings.clear', h.b, 'javascript', {})
    expect(h.api.getContentSetting('javascript', 'https://b.example/')).to.equal('block')
    await h.unload(h.a)
    expect(h.api.getContentSetting('javascript', 'https://b.example/')).to.equal('allow')
  })

  it('never blocks browser or extension pages for what they need', async () => {
    const h = setup()
    await h.set(h.a, 'javascript', { primaryPattern: '<all_urls>', setting: 'block' })
    await h.set(h.a, 'notifications', { primaryPattern: '<all_urls>', setting: 'block' })
    expect(h.api.getContentSetting('javascript', 'peersky://settings/')).to.equal('allow')
    expect(h.api.getContentSetting('javascript', 'chrome-extension://ext-b/page.html')).to.equal('allow')
    expect(h.api.getContentSetting('javascript', 'file:///tmp/x.html')).to.equal('block')
    expect(h.api.getContentSetting('notifications', 'chrome-extension://ext-b/page.html')).to.equal('block')
  })

  it("falls back to the host's own setting, then Chrome's default", async () => {
    const h = setup()
    h.ctx.store.impl.getContentSetting = ({ type, primaryUrl }: any) =>
      type === 'notifications' && primaryUrl.startsWith('https://allowed.example') ? 'allow' : 'nonsense'
    expect(h.api.getContentSetting('notifications', 'https://allowed.example/')).to.equal('allow')
    expect(h.api.getContentSetting('notifications', 'https://other.example/')).to.equal('ask')
    expect(h.api.getContentSetting('popups', 'https://other.example/')).to.equal('block')
    expect(h.api.getContentSetting('bogus', 'https://other.example/')).to.equal(undefined)
    expect(h.api.getContentSetting('javascript', 'not a url')).to.equal(undefined)
  })

  it('keeps rules across a restart', async () => {
    const state = {}
    const h = setup(state)
    await h.load(h.a)
    await h.set(h.a, 'images', { primaryPattern: 'https://a.example/*', setting: 'block' })
    const after = setup(state)
    await after.load(after.a)
    expect(after.api.getContentSetting('images', 'https://a.example/x')).to.equal('block')
  })

  it("refuses what Chrome refuses, with its messages", async () => {
    const h = setup()
    const cases: Array<[string, any, string]> = [
      ['cookies', { primaryPattern: '<all_urls>', setting: 'sometimes' }, "Invalid invocation: Error at property 'setting': Value must be one of allow, block, session_only."],
      ['javascript', { primaryPattern: '<all_urls>', setting: 5 }, "Invalid invocation: Error at property 'setting': Invalid type: expected contentSettings.JavascriptContentSetting, found integer."],
      ['javascript', { setting: 'block' }, "Error in invocation of contentSettings.ContentSetting.set(object details, optional function callback): Error at parameter 'details': Missing required property 'primaryPattern'."],
      ['javascript', { primaryPattern: 'http://a.example/*', secondaryPattern: 'https://b.example/*', setting: 'block' }, 'Embedded patterns are not supported for this setting.'],
      ['camera', { primaryPattern: '<all_urls>', setting: 'allow' }, "'allow' is not supported as the default setting of camera."],
      ['autoVerify', { primaryPattern: 'http://a.example/*', setting: 'block' }, "Site-specific settings are not allowed for this type. The URL pattern must be '<all_urls>'."],
      ['javascript', { primaryPattern: '<all_urls>', setting: 'block', scope: 'incognito_session_only' }, 'You do not have permission to access incognito preferences.'],
      ['bogus', { primaryPattern: '<all_urls>', setting: 'block' }, 'Invalid invocation'],
    ]
    for (const [type, details, message] of cases) {
      expect(await h.errorOf(h.set(h.a, type, details)), `${type} ${JSON.stringify(details)}`).to.equal(message)
    }
    expect(await h.errorOf(h.get(h.a, 'javascript', { primaryUrl: 'not a url' }))).to.equal('The URL "not a url" is invalid.')
    expect(await h.errorOf(h.get(h.a, 'javascript', { primaryUrl: 'https://a.example/', incognito: true }))).to.equal(
      'You do not have permission to access incognito preferences.',
    )
    expect(h.api.getContentSetting('javascript', 'http://a.example/')).to.equal('allow')
  })

  it('stops scripts and images on blocked pages with a policy, and leaves other responses alone', async () => {
    const h = setup()
    await h.set(h.a, 'javascript', { primaryPattern: 'https://a.example/*', setting: 'block' })
    await h.set(h.a, 'images', { primaryPattern: 'https://a.example/*', setting: 'block' })
    const html = { 'Content-Type': ['text/html'], 'content-security-policy': ["default-src 'self'"] }
    const out = h.api.responseHeadersFor({ url: 'https://a.example/', resourceType: 'mainFrame' } as any, html)!
    expect(out['content-security-policy'][0]).to.equal("default-src 'self'")
    expect(out['content-security-policy'][1]).to.match(/^sandbox allow-downloads .*allow-same-origin.*; img-src 'none'$/)
    expect(out['content-security-policy'][1]).to.not.include('allow-scripts')
    expect(h.api.responseHeadersFor({ url: 'https://b.example/', resourceType: 'mainFrame' } as any, html)).to.equal(undefined)
    expect(h.api.responseHeadersFor({ url: 'https://a.example/x.js', resourceType: 'script' } as any, html)).to.equal(undefined)
    // A PDF keeps working; only the images rule applies to it.
    const pdf = h.api.responseHeadersFor({ url: 'https://a.example/x.pdf', resourceType: 'mainFrame' } as any, { 'Content-Type': ['application/pdf'] })!
    expect(pdf['Content-Security-Policy']).to.deep.equal(["img-src 'none'"])
  })

  it('keeps cookies out for blocked sites and makes them end with the session', async () => {
    const h = setup()
    await h.set(h.a, 'cookies', { primaryPattern: 'https://blocked.example/*', setting: 'block' })
    await h.set(h.a, 'cookies', { primaryPattern: 'https://session.example/*', setting: 'session_only' })
    const req = h.api.requestHeadersFor({ url: 'https://blocked.example/' } as any, { Cookie: 'a=1', Accept: '*/*' })
    expect(req).to.deep.equal({ Accept: '*/*' })
    expect(h.api.requestHeadersFor({ url: 'https://other.example/' } as any, { Cookie: 'a=1' })).to.equal(undefined)
    const blocked = h.api.responseHeadersFor({ url: 'https://blocked.example/', resourceType: 'xhr' } as any, { 'set-cookie': ['a=1'] })
    expect(blocked).to.deep.equal({})
    const session = h.api.responseHeadersFor({ url: 'https://session.example/', resourceType: 'xhr' } as any, {
      'Set-Cookie': ['a=1; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=999; Secure'],
    })
    expect(session).to.deep.equal({ 'Set-Cookie': ['a=1; Path=/; Secure'] })
  })

  it('mutes a tab on a page with sound blocked and unmutes only what it muted', async () => {
    const h = setup()
    let muted = false
    const listeners: Record<string, Function> = {}
    const tab: any = {
      isDestroyed: () => false,
      getURL: () => 'https://loud.example/',
      isAudioMuted: () => muted,
      setAudioMuted: (m: boolean) => (muted = m),
      on: (name: string, fn: Function) => (listeners[name] = fn),
    }
    h.ctx.store.tabs.add(tab)
    h.ctx.store.emit('tab-added', tab)
    await h.set(h.a, 'sound', { primaryPattern: 'https://loud.example/*', setting: 'block' })
    expect(muted).to.equal(true)
    await h.call('contentSettings.clear', h.a, 'sound', {})
    expect(muted).to.equal(false)
  })
})

describe('chrome.fontSettings', () => {
  const setup = (state: Record<string, unknown> = {}) => {
    const h = settingsHarness(state)
    const api = new FontSettingsAPI(h.ctx)
    const a = h.extension('ext-a', ['fontSettings'])
    return { ...h, api, a }
  }

  it("gives Chrome's sizes, keeps what is set across a restart, and tells the host", async () => {
    const state = {}
    const h = setup(state)
    await h.load(h.a)
    expect(await h.call('fontSettings.getDefaultFontSize', h.a)).to.deep.equal({ pixelSize: 16, levelOfControl: 'controllable_by_this_extension' })
    expect((await h.call('fontSettings.getDefaultFixedFontSize', h.a)).pixelSize).to.equal(13)
    expect((await h.call('fontSettings.getMinimumFontSize', h.a)).pixelSize).to.equal(0)
    await h.call('fontSettings.setDefaultFontSize', h.a, { pixelSize: 20 })
    await h.call('fontSettings.setFont', h.a, { genericFamily: 'sansserif', fontId: 'Verdana' })
    expect(h.events.find((e) => e.name === 'fontSettings.onDefaultFontSizeChanged')?.args[0]).to.deep.equal({
      pixelSize: 20,
      levelOfControl: 'controlled_by_this_extension',
    })
    expect(h.events.find((e) => e.name === 'fontSettings.onFontChanged')?.args[0]).to.deep.equal({
      fontId: 'Verdana',
      genericFamily: 'sansserif',
      script: 'Zyyy',
      levelOfControl: 'controlled_by_this_extension',
    })
    const prefs = last(h.emitted.filter((e) => e.name === 'font-settings-changed'))!.payload
    expect(prefs.defaultFontSize).to.equal(20)
    expect(prefs.defaultFontFamily.sansSerif).to.equal('Verdana')

    const after = setup(state)
    await after.load(after.a)
    expect(after.api.getWebPreferences().defaultFontSize).to.equal(20)
    expect((await after.call('fontSettings.getFont', after.a, { genericFamily: 'sansserif' })).fontId).to.equal('Verdana')
    await after.call('fontSettings.clearFont', after.a, { genericFamily: 'sansserif' })
    expect((await after.call('fontSettings.getFont', after.a, { genericFamily: 'sansserif' })).levelOfControl).to.equal(
      'controllable_by_this_extension',
    )
  })

  it("refuses bad details with Chrome's messages", async () => {
    const h = setup()
    expect(await h.errorOf(h.call('fontSettings.getFont', h.a, { genericFamily: 'bogus' }))).to.equal(
      "Error in invocation of fontSettings.getFont(object details, optional function callback): Error at parameter 'details': Error at property 'genericFamily': Value must be one of cursive, fantasy, fixed, math, sansserif, serif, standard.",
    )
    expect(await h.errorOf(h.call('fontSettings.setDefaultFontSize', h.a, { pixelSize: 1.5 }))).to.equal(
      "Error in invocation of fontSettings.setDefaultFontSize(object details, optional function callback): Error at parameter 'details': Error at property 'pixelSize': Invalid type: expected integer, found number.",
    )
    expect(await h.errorOf(h.call('fontSettings.getDefaultFontSize', h.a, { foo: 1 }))).to.equal(
      "Error in invocation of fontSettings.getDefaultFontSize(optional object details, optional function callback): Error at parameter 'details': Unexpected property: 'foo'.",
    )
    expect(await h.errorOf(h.call('fontSettings.getFont', h.a, { genericFamily: 'serif', script: 'Xxxx' }))).to.match(
      /Error at property 'script': Value must be one of Afak, /,
    )
  })

  it('lists installed fonts as { fontId, displayName }, sorted', async function () {
    this.timeout(20000)
    const h = setup()
    const list = await h.call('fontSettings.getFontList', h.a)
    expect(list).to.be.an('array')
    if (process.platform === 'darwin') expect(list.length).to.be.greaterThan(10)
    for (const font of list.slice(0, 20)) {
      expect(Object.keys(font).sort()).to.deep.equal(['displayName', 'fontId'])
      expect(font.fontId).to.be.a('string').and.not.equal('')
    }
    const names = list.map((f: any) => f.displayName)
    expect(names).to.deep.equal([...names].sort((x: string, y: string) => x.localeCompare(y)))
  })
})

describe('chrome.browsingData', () => {
  const setup = () => {
    const h = settingsHarness()
    new BrowsingDataAPI(h.ctx)
    const a = h.extension('ext-a', ['browsingData'])
    const b = h.extension('ext-b', ['browsingData'])
    return { ...h, a, b }
  }

  it('reads origins as Chrome does', () => {
    expect(parseOrigin('https://a.example/path')).to.equal('https://a.example')
    expect(parseOrigin('HTTPS://A.EXAMPLE')).to.equal('https://a.example')
    expect(parseOrigin('file:///tmp')).to.equal('file://')
    expect(parseOrigin('chrome-extension://abc')).to.equal('chrome-extension://abc')
    for (const bad of ['a.example', 'https://', 'https://a.example:99999', 'data:text/plain,x', 'about:blank', 5]) {
      expect(parseOrigin(bad), String(bad)).to.equal(undefined)
    }
  })

  it("keeps every extension's data, the browser's own pages and the history it does not own", async () => {
    const h = setup()
    await h.load(h.a)
    await h.load(h.b)
    h.ctx.store.impl.getProtectedOrigins = () => ['peersky://settings/']
    const history: any[] = []
    h.ctx.store.on('clear-history', (e: any) => history.push(e))

    await h.call('browsingData.remove', h.a, { since: 1000 }, { localStorage: true, indexedDB: true, history: true, passwords: true })
    expect(h.clearDataCalls).to.deep.equal([
      {
        dataTypes: ['indexedDB', 'localStorage'],
        excludeOrigins: ['chrome-extension://ext-a', 'chrome-extension://ext-b', 'peersky://settings'],
      },
    ])
    expect(history).to.deep.equal([{ since: 1000 }])
    expect(last(h.emitted)).to.deep.equal({
      name: 'browsing-data-removed',
      payload: { extensionId: 'ext-a', since: 1000, dataTypes: ['history', 'indexedDB', 'localStorage'] },
    })

    // An extension may ask for its own origin, never another's.
    h.clearDataCalls.length = 0
    await h.call('browsingData.removeLocalStorage', h.a, {
      originTypes: { extension: true },
      origins: ['chrome-extension://ext-b', 'chrome-extension://ext-a'],
    })
    expect(h.clearDataCalls).to.deep.equal([{ dataTypes: ['localStorage'], origins: ['chrome-extension://ext-a'] }])
    h.clearDataCalls.length = 0
    await h.call('browsingData.removeLocalStorage', h.a, { origins: ['chrome-extension://ext-b'] })
    expect(h.clearDataCalls).to.deep.equal([])

    // The HTTP cache alone, unless a list of origins needs Electron's filter;
    // Cache Storage never takes extensions' with it.
    await h.call('browsingData.removeCache', h.a, {})
    await h.call('browsingData.removeCache', h.a, { origins: ['https://a.example'] })
    await h.call('browsingData.removeCacheStorage', h.a, {})
    await h.call('browsingData.removeCacheStorage', h.a, { origins: ['https://a.example'] })
    expect(h.clearDataCalls).to.deep.equal([
      'clearCache',
      { dataTypes: ['cache'], origins: ['https://a.example'] },
      { dataTypes: ['cache'], excludeOrigins: ['chrome-extension://ext-a', 'chrome-extension://ext-b', 'peersky://settings'] },
    ])
    expect(h.clearStorageCalls).to.deep.equal([{ origin: 'https://a.example', storages: ['cachestorage'] }])
  })

  it("refuses what Chrome refuses, with its messages", async () => {
    const h = setup()
    const o = 'https://a.example'
    expect(await h.errorOf(h.call('browsingData.remove', h.a, { origins: [o], excludeOrigins: [o] }, { cookies: true }))).to.equal(
      "Don't set both 'origins' and 'excludeOrigins' at the same time.",
    )
    expect(await h.errorOf(h.call('browsingData.remove', h.a, { origins: [o] }, { downloads: true }))).to.equal(
      "At least one data type doesn't support filtering by origin.",
    )
    expect(await h.errorOf(h.call('browsingData.removeCookies', h.a, { origins: ['nope'] }))).to.equal("'nope' is not a valid origin.")
    expect(await h.errorOf(h.call('browsingData.removePasswords', h.a, {}))).to.equal('Requested data type is deprecated.')
    expect(await h.errorOf(h.call('browsingData.remove', h.a, {}))).to.equal(
      'Error in invocation of browsingData.remove(browsingData.RemovalOptions options, browsingData.DataTypeSet dataToRemove, optional function callback): No matching signature.',
    )
    expect(await h.errorOf(h.call('browsingData.removeCookies', h.a, { origins: [] }))).to.equal(
      "Error in invocation of browsingData.removeCookies(browsingData.RemovalOptions options, optional function callback): Error at parameter 'options': Error at property 'origins': Array must have at least 1 items; found 0.",
    )
    expect(h.clearDataCalls).to.have.length(0)
  })

  it('removes only cookies set since `since`, and from the sites asked', async () => {
    const h = setup()
    const cookie = (name: string, domain: string) => ({ name, domain, path: '/', value: '1', secure: true, sameSite: 'lax' }) as any
    const old = cookie('old', '.a.example')
    h.setCookies([old])
    // Cookies seen being set from here on have a time.
    const start = Date.now()
    await new Promise((r) => setTimeout(r, 5))
    const fresh = cookie('fresh', 'www.a.example')
    const other = cookie('other', 'b.example')
    h.ctx.session.cookies.emit('changed', {}, fresh, 'explicit', false)
    h.ctx.session.cookies.emit('changed', {}, other, 'explicit', false)
    h.setCookies([old, fresh, other])

    await h.call('browsingData.removeCookies', h.a, { since: start + 1, origins: ['https://a.example'] })
    expect(h.removedCookies).to.deep.equal([{ url: 'https://www.a.example/', name: 'fresh' }])
    // since 0 leaves the matching to Chromium.
    await h.call('browsingData.removeCookies', h.a, { excludeOrigins: ['https://b.example'] })
    expect(last(h.clearDataCalls)).to.deep.equal({ dataTypes: ['cookies'], excludeOrigins: ['https://b.example'] })
  })

  it("reports Chrome's settings for a new profile", async () => {
    const h = setup()
    const s = await h.call('browsingData.settings', h.a)
    expect(s.options.originTypes).to.deep.equal({ unprotectedWeb: true, protectedWeb: false, extension: false })
    expect(Math.round((Date.now() - s.options.since) / 60000)).to.equal(60)
    expect(s.dataToRemove.formData).to.equal(false)
    expect(s.dataToRemove.cookies).to.equal(true)
    expect(Object.values(s.dataRemovalPermitted).every((v) => v === true)).to.equal(true)
  })
})
