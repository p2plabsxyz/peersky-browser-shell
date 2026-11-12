import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { CookiesAPI } from '../src/browser/api/cookies'
import { DeclarativeNetRequestAPI } from '../src/browser/api/declarative-net-request'
import { DownloadsAPI } from '../src/browser/api/downloads'
import { DebuggerAPI } from '../src/browser/api/debugger'
import { ScriptingAPI } from '../src/browser/api/scripting'
import { UserScriptsAPI } from '../src/browser/api/user-scripts'
import { WebRequestAPI } from '../src/browser/api/web-request'
import { ExtensionPermissions } from '../src/browser/permissions'
import { mayBacktrackBadly } from '../src/browser/api/lib/guarded-regexp'
import { prepareNavigationUrl } from '../src/browser/api/tabs'

// Unit specs for the network and page APIs: the security rules and the
// state kept across restarts, which the parity probe cannot reach.

type Ext = { id: string; name: string; path: string; manifest: any }

const extension = (id: string, manifest: any, dir = os.tmpdir()): Ext => ({
  id,
  name: id,
  path: dir,
  manifest: { manifest_version: 3, name: id, version: '1', ...manifest },
})

/** A fake ctx, with real permissions, a state store that outlives an API instance, and recorded events. */
function makeCtx(opts: { extensions?: Ext[]; state?: Record<string, unknown>; impl?: any; cookies?: any } = {}) {
  const handlers = new Map<string, Function>()
  const events: { extensionId: string | undefined; name: string; args: any[] }[] = []
  const contextInfoProviders: Function[] = []
  const state = opts.state ?? {}
  const extensions = new Map((opts.extensions ?? []).map((e) => [e.id, e]))
  const sessionExtensions: any = new EventEmitter()
  sessionExtensions.getExtension = (id: string) => extensions.get(id)
  sessionExtensions.getAllExtensions = () => [...extensions.values()]
  const stateStore = {
    whenHydrated: async () => {},
    getNamespace: (name: string, fallback: any) => (state[name] as any) ?? fallback,
    setNamespace: (name: string, value: unknown) => {
      state[name] = value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    },
    flush: async () => {},
  }
  const permissions = new ExtensionPermissions({
    stateStore,
    sendEvent: () => {},
    prompt: async () => false,
  })
  const session: any = new EventEmitter()
  session.extensions = sessionExtensions
  session.cookies = opts.cookies
  session.downloadURL = () => {}
  const store: any = new EventEmitter()
  Object.assign(store, {
    tabs: new Set(),
    impl: opts.impl ?? {},
    hasUserGesture: () => false,
    getTabById: (id: number) => [...store.tabs].find((t: any) => t.id === id),
    getDocumentId: () => undefined,
    newDocumentId: () => 'DOC',
    resolveByDocumentId: () => undefined,
  })
  const router = {
    apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
    addContextInfoProvider: (provider: Function) => contextInfoProviders.push(provider),
    sendEvent: (extensionId: string | undefined, name: string, ...args: any[]) => events.push({ extensionId, name, args }),
    broadcastEvent: (name: string, ...args: any[]) => events.push({ extensionId: undefined, name, args }),
    hasListener: () => false,
  }
  const ctx: any = { router, session, store, stateStore, permissions }
  const call = (name: string, ext: Ext, ...args: any[]) =>
    Promise.resolve().then(() => handlers.get(name)!({ extension: ext, type: 'service-worker', sender: { scope: `chrome-extension://${ext.id}/` } }, ...args))
  return { ctx, handlers, events, state, call, contextInfoProviders }
}

describe('network and page APIs', () => {
  describe('cookies', () => {
    const store = () => {
      const cookies: any[] = []
      const emitter: any = new EventEmitter()
      emitter.get = async (filter: any) =>
        cookies.filter((c) => (!filter.name || c.name === filter.name) && (!filter.url || new URL(filter.url).hostname.endsWith(c.domain.replace(/^\./, ''))))
      emitter.set = async (details: any) => {
        cookies.push({ name: details.name, value: details.value, domain: new URL(details.url).hostname, path: details.path ?? '/', hostOnly: true, session: true, secure: false, httpOnly: false, sameSite: details.sameSite })
      }
      emitter.remove = async () => {}
      return { emitter, cookies }
    }
    const probe = extension('cookie-probe', { permissions: ['cookies'], host_permissions: ['https://a.example/*'] })
    const other = extension('cookie-other', { permissions: ['cookies'], host_permissions: ['https://b.example/*'] })

    it('refuses a url the extension has no host access to, with Chrome\'s message', async () => {
      const { emitter } = store()
      const h = makeCtx({ extensions: [probe], cookies: emitter })
      new CookiesAPI(h.ctx)
      await expect(h.call('cookies.set', probe, { url: 'https://b.example/', name: 'x', value: '1' })).to.be.rejectedWith(
        'No host permissions for cookies at url: "https://b.example/".',
      )
      await expect(h.call('cookies.get', probe, { url: 'https://b.example/', name: 'x' })).to.be.rejectedWith(
        'No host permissions for cookies at url: "https://b.example/".',
      )
      await expect(h.call('cookies.set', probe, { url: 'not a url', name: 'x' })).to.be.rejectedWith('Invalid url: "not a url".')
    })

    it('lists only cookies the extension may see, and tells only those extensions of a change', async () => {
      const { emitter, cookies } = store()
      cookies.push(
        { name: 'mine', value: '1', domain: 'a.example', path: '/', hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: 'lax' },
        { name: 'theirs', value: '2', domain: 'b.example', path: '/', hostOnly: true, session: true, secure: true, httpOnly: false, sameSite: 'lax' },
      )
      const h = makeCtx({ extensions: [probe, other], cookies: emitter })
      new CookiesAPI(h.ctx)
      const all = await h.call('cookies.getAll', probe, {})
      expect(all.map((c: any) => c.name)).to.deep.equal(['mine'])
      emitter.emit('changed', {}, cookies[1], 'inserted', false)
      const sent = h.events.filter((e) => e.name === 'cookies.onChanged')
      expect(sent.map((e) => e.extensionId)).to.deep.equal(['cookie-other'])
      expect(sent[0].args[0].cause).to.equal('explicit')
    })

    it('sets a cookie with Chrome\'s sameSite default, not Electron\'s lax', async () => {
      const { emitter, cookies } = store()
      const h = makeCtx({ extensions: [probe], cookies: emitter })
      new CookiesAPI(h.ctx)
      const cookie = await h.call('cookies.set', probe, { url: 'https://a.example/', name: 'n', value: 'v' })
      expect(cookies[0].sameSite).to.equal('unspecified')
      expect(cookie).to.include({ name: 'n', value: 'v', sameSite: 'unspecified', storeId: '0' })
      expect(await h.call('cookies.remove', probe, { url: 'https://a.example/', name: 'gone' })).to.deep.equal({
        url: 'https://a.example/',
        name: 'gone',
        storeId: '0',
      })
      await expect(h.call('cookies.get', probe, { url: 'https://a.example/', name: 'n', storeId: '1' })).to.be.rejectedWith(
        'No cookie store found with id: 1.',
      )
    })
  })

  describe('webRequest', () => {
    const watcher = extension('wr-watcher', { permissions: ['webRequest'], host_permissions: ['https://site.example/*'] })
    const request = (extra: any = {}) =>
      ({
        id: Math.floor(Math.random() * 1e9),
        url: 'https://site.example/data',
        method: 'GET',
        resourceType: 'xhr',
        timestamp: Date.now(),
        referrer: '',
        ...extra,
      }) as any

    const setup = () => {
      const h = makeCtx({ extensions: [watcher] })
      const api = new WebRequestAPI(h.ctx)
      return { ...h, api }
    }

    it('shows a request only with host access to its URL and to the page that made it', async () => {
      const { api, call, events } = setup()
      await call('webRequest.addOnSendHeadersListener', watcher, { urls: ['<all_urls>'] }, [])
      await api.notifyOnSendHeaders(request({ initiatorOrigin: 'https://site.example' }))
      await api.notifyOnSendHeaders(request({ url: 'https://elsewhere.example/', initiatorOrigin: 'https://site.example' }))
      await api.notifyOnSendHeaders(request({ initiatorOrigin: 'https://elsewhere.example' }))
      await api.notifyOnSendHeaders(request({ initiatorOrigin: 'chrome-extension://another-extension' }))
      // A top-level navigation is shown whoever started it.
      await api.notifyOnSendHeaders(request({ resourceType: 'mainFrame', initiatorOrigin: 'https://elsewhere.example' }))
      // A request the browser makes for itself has neither page nor origin.
      await api.notifyOnSendHeaders(request({}))
      const seen = events.filter((e) => e.name === 'webRequest.onSendHeaders').map((e) => e.args[0].type)
      expect(seen).to.deep.equal(['xmlhttprequest', 'main_frame'])
    })

    it('gives each event Chrome\'s keys, and the id of the listener it is for', async () => {
      const { api, call, events } = setup()
      const id = await call('webRequest.addOnCompletedListener', watcher, { urls: ['https://site.example/*'] }, [])
      await api.notifyOnCompleted(request({ initiatorOrigin: 'https://site.example', statusCode: 200, statusLine: 'HTTP/1.1 200 OK', fromCache: false, responseHeaders: { A: ['1'] } }))
      const [details] = events.find((e) => e.name === 'webRequest.onCompleted')!.args
      expect(details.listenerId).to.equal(id)
      expect(Object.keys(details).sort()).to.deep.equal(
        ['frameId', 'fromCache', 'initiator', 'listenerId', 'method', 'parentFrameId', 'requestId', 'statusCode', 'statusLine', 'tabId', 'timeStamp', 'type', 'url'],
      )
    })

    it('keeps two identical listeners of one context, and lets a restarted worker replace its own', async () => {
      const { api, call, events } = setup()
      const filter = { urls: ['https://site.example/*'] }
      const first = await call('webRequest.addOnSendHeadersListener', watcher, filter, [], 0)
      const second = await call('webRequest.addOnSendHeadersListener', watcher, filter, [], 1)
      expect(first).to.not.equal(second)
      // The worker starts again and adds its first listener anew.
      const again = await call('webRequest.addOnSendHeadersListener', watcher, filter, [], 0)
      await api.notifyOnSendHeaders(request({ initiatorOrigin: 'https://site.example' }))
      const ids = events.filter((e) => e.name === 'webRequest.onSendHeaders').map((e) => e.args[0].listenerId)
      expect(ids.sort()).to.deep.equal([second, again].sort())
    })

    it('needs webRequestBlocking for a blocking listener', async () => {
      const { call } = setup()
      expect(await call('webRequest.addOnBeforeRequestListener', watcher, { urls: ['<all_urls>'] }, ['blocking'])).to.equal(undefined)
    })

    // Another extension could answer for a request it cannot even see, with
    // listener ids of its choosing, and redirect a page anywhere.
    it('takes a blocking answer only from the listener the request went to, and only its first', async () => {
      const blocker = extension('wr-blocker', { permissions: ['webRequest', 'webRequestBlocking'], host_permissions: ['https://site.example/*'] })
      const intruder = extension('wr-intruder', { permissions: ['webRequest', 'webRequestBlocking'] })
      const h = makeCtx({ extensions: [blocker, intruder] })
      const api = new WebRequestAPI(h.ctx)
      const id = await h.call('webRequest.addOnBeforeRequestListener', blocker, { urls: ['<all_urls>'] }, ['blocking'])
      const pending = api.notifyOnBeforeRequest(request({ id: 7, resourceType: 'mainFrame' }))
      const respond = (ext: any, listenerId: any, result: any) => h.call('webRequest.onBeforeRequest.response', ext, '7', listenerId, result)
      for (let n = 0; n < 50; n++) await respond(intruder, `wr-${n}`, { redirectUrl: 'https://attacker.example/' })
      await respond(intruder, id, { cancel: true })
      await respond(intruder, { redirectUrl: 'https://attacker.example/' }, undefined)
      await respond(blocker, id, {})
      await respond(blocker, id, { cancel: true })
      expect(await pending).to.deep.equal({})
    })
  })

  // Chrome's RE2 cannot backtrack; JavaScript's engine can, for minutes, in
  // the main process, on every request.
  describe('regular expressions from extensions', () => {
    it('tells the patterns that could backtrack for long', () => {
      for (const risky of ['^https?://[^/]+/(a+)+$', '(a|aa)*$', '([a-z0-9]+)*x', '(?:[a-z]+\\.)+example\\.com', '.*a.*b.*c.*d', '((ab)*)+']) {
        expect(mayBacktrackBadly(risky), risky).to.equal(true)
      }
      for (const plain of ['^https?://ads\\.example\\.com/', '^https?://[^/]+/[a-z]+\\.js$', '(a|b)?c', '[(+*]+x', '(abc){2}', '\\(a+\\)+', '^https://(www\\.)?example\\.com/.*']) {
        expect(mayBacktrackBadly(plain), plain).to.equal(false)
      }
    })

    it('a declarativeNetRequest rule cannot hold up the browser, and no other rule stops blocking', async () => {
      const blocker = extension('dnr-regex', { permissions: ['declarativeNetRequest'] })
      const h = makeCtx({ extensions: [blocker] })
      const dnr = new DeclarativeNetRequestAPI(h.ctx)
      await h.call('declarativeNetRequest.updateDynamicRules', blocker, {
        addRules: [
          { id: 1, action: { type: 'block' }, condition: { regexFilter: '^https?://[^/]+/(a+)+$' } },
          { id: 2, action: { type: 'block' }, condition: { regexFilter: '^https?://ads\\.example/' } },
          { id: 3, action: { type: 'block' }, condition: { regexFilter: '^https?://(?:[a-z0-9-]+\\.)+tracker\\.example/' } },
        ],
      })
      const request = (url: string) => dnr.evaluateOnBeforeRequest({ url, method: 'GET', tabId: 1, type: 'xmlhttprequest' } as any)
      const started = Date.now()
      expect(request(`https://site.example/${'a'.repeat(40)}!`)).to.equal(null)
      expect(Date.now() - started).to.be.lessThan(1000)
      // The rule that hung is out; the others, a pattern like it among them,
      // keep blocking however many requests come.
      for (let i = 0; i < 3000; i++) {
        expect(request(`https://cdn${i}.tracker.example/p.js`)).to.deep.equal({ cancel: true })
      }
      expect(request('https://ads.example/x')).to.deep.equal({ cancel: true })
      const again = Date.now()
      expect(request(`https://site.example/${'a'.repeat(40)}!`)).to.equal(null)
      expect(Date.now() - again).to.be.lessThan(50)
    })
  })

  // <all_urls> never reaches local files without Chrome's "Allow access to
  // file URLs". Chrome still lets the extension open one in a tab; it only
  // cannot read it or script it.
  describe('local files', () => {
    const everywhere = extension('files-ext', { permissions: ['scripting', 'tabs'], host_permissions: ['<all_urls>', 'file:///*'] })
    const permissions = (allowed: boolean) =>
      new ExtensionPermissions({
        stateStore: { whenHydrated: async () => {}, getNamespace: (_n: string, f: any) => f, setNamespace: () => {} },
        sendEvent: () => {},
        prompt: async () => false,
        isFileAccessAllowed: () => allowed,
      } as any)

    it('needs file access as well as the pattern', () => {
      expect(permissions(false).hasHostAccess(everywhere as any, 'file:///etc/hosts')).to.equal(false)
      expect(permissions(false).hasHostAccess(everywhere as any, 'https://site.example/')).to.equal(true)
      expect(permissions(true).hasHostAccess(everywhere as any, 'file:///etc/hosts')).to.equal(true)
    })

    it('opens a file in a tab without file access, as Chrome does', () => {
      expect(prepareNavigationUrl('file:///etc/hosts', everywhere as any, permissions(false) as any)).to.equal('file:///etc/hosts')
    })
  })

  describe('declarativeNetRequest', () => {
    const blocker = extension('dnr-blocker', { permissions: ['declarativeNetRequest'] })
    const redirector = extension('dnr-redirector', {
      permissions: ['declarativeNetRequest'],
      host_permissions: ['https://allowed.example/*'],
      web_accessible_resources: [{ resources: ['public.html'], matches: ['https://allowed.example/*'] }],
    })
    const details = (url: string, initiator?: string) => ({ url, method: 'GET', tabId: 1, type: 'xmlhttprequest', initiator })

    it('refuses invalid rules with Chrome\'s messages, and adds none of them', async () => {
      const h = makeCtx({ extensions: [blocker] })
      new DeclarativeNetRequestAPI(h.ctx)
      const update = (rules: any[]) => h.call('declarativeNetRequest.updateDynamicRules', blocker, { addRules: rules })
      await expect(update([{ id: 0, action: { type: 'block' }, condition: {} }])).to.be.rejectedWith(
        'Rule with id 0 has an invalid value for id key. This should be greater than or equal to 1.',
      )
      await expect(update([{ id: 3, action: { type: 'block' }, condition: { urlFilter: '' } }])).to.be.rejectedWith(
        'Rule with id 3 cannot have an empty value for urlFilter key.',
      )
      await expect(update([{ id: 4, action: { type: 'block' }, condition: { regexFilter: '(?=x)' } }])).to.be.rejectedWith(
        'Rule with id 4 specifies an incorrect value for the "regexFilter" key.',
      )
      await expect(
        update([
          { id: 5, action: { type: 'block' }, condition: { urlFilter: 'a' } },
          { id: 5, action: { type: 'block' }, condition: { urlFilter: 'b' } },
        ]),
      ).to.be.rejectedWith('Rule with id 5 does not have a unique ID.')
      await expect(update([{ id: 6, action: { type: 'redirect' }, condition: {} }])).to.be.rejectedWith(
        'Rule with id 6 does not specify the value for "action.redirect" key. This is required for redirect rules.',
      )
      expect(await h.call('declarativeNetRequest.getDynamicRules', blocker)).to.deep.equal([])
      await expect(h.call('declarativeNetRequest.updateEnabledRulesets', blocker, { enableRulesetIds: ['nope'] })).to.be.rejectedWith(
        'Invalid ruleset id: nope.',
      )
      expect(await h.call('declarativeNetRequest.isRegexSupported', blocker, { regex: '(' })).to.deep.equal({
        isSupported: false,
        reason: 'syntaxError',
      })
    })

    it('keeps dynamic rules for the next run, and session rules only for this one', async () => {
      const state: Record<string, unknown> = {}
      const first = makeCtx({ extensions: [blocker], state })
      new DeclarativeNetRequestAPI(first.ctx)
      const rule = { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }
      await first.call('declarativeNetRequest.updateDynamicRules', blocker, { addRules: [rule] })
      await first.call('declarativeNetRequest.updateSessionRules', blocker, { addRules: [{ ...rule, id: 2 }] })

      const second = makeCtx({ extensions: [blocker], state })
      const dnr = new DeclarativeNetRequestAPI(second.ctx)
      expect((await second.call('declarativeNetRequest.getDynamicRules', blocker)).map((r: any) => r.id)).to.deep.equal([1])
      expect(await second.call('declarativeNetRequest.getSessionRules', blocker)).to.deep.equal([])
      expect(dnr.evaluateOnBeforeRequest(details('https://ads.example/x.js'))).to.deep.equal({ cancel: true })
    })

    it('redirects only with host access, and only to resources the page may load', async () => {
      const h = makeCtx({ extensions: [redirector] })
      const dnr = new DeclarativeNetRequestAPI(h.ctx)
      await h.call('declarativeNetRequest.updateDynamicRules', redirector, {
        addRules: [
          { id: 1, action: { type: 'redirect', redirect: { extensionPath: '/public.html' } }, condition: { urlFilter: '/public' } },
          { id: 2, action: { type: 'redirect', redirect: { extensionPath: '/private.html' } }, condition: { urlFilter: '/private' } },
        ],
      })
      expect(dnr.evaluateOnBeforeRequest(details('https://allowed.example/public', 'https://allowed.example'))).to.deep.equal({
        redirectUrl: 'chrome-extension://dnr-redirector/public.html',
      })
      // The page may not load that resource, so the request goes nowhere.
      expect(dnr.evaluateOnBeforeRequest(details('https://allowed.example/private', 'https://allowed.example'))).to.deep.equal({
        cancel: true,
      })
      // No host access to the URL: the redirect does not apply.
      expect(dnr.evaluateOnBeforeRequest(details('https://other.example/public', 'https://other.example'))).to.equal(null)
    })

    it('lets an allow rule win over a block of the same priority, and reports matches only with feedback', async () => {
      const h = makeCtx({ extensions: [blocker] })
      const dnr = new DeclarativeNetRequestAPI(h.ctx)
      await h.call('declarativeNetRequest.updateDynamicRules', blocker, {
        addRules: [
          { id: 1, action: { type: 'block' }, condition: { urlFilter: 'tracker' } },
          { id: 2, action: { type: 'allow' }, condition: { urlFilter: 'tracker' } },
        ],
      })
      expect(dnr.evaluateOnBeforeRequest(details('https://tracker.example/'))).to.equal(null)
      await expect(h.call('declarativeNetRequest.getMatchedRules', blocker, {})).to.be.rejectedWith(
        'The extension must have the declarativeNetRequestFeedback permission',
      )
      expect(await h.call('declarativeNetRequest.testMatchOutcome', blocker, { url: 'https://tracker.example/', type: 'script' })).to.deep.equal({
        matchedRules: [{ ruleId: 2, rulesetId: '_dynamic' }],
      })
    })

    it('changes headers with modifyHeaders when it has host access', async () => {
      const editor = extension('dnr-editor', { permissions: ['declarativeNetRequest'], host_permissions: ['<all_urls>'] })
      const h = makeCtx({ extensions: [editor] })
      const dnr = new DeclarativeNetRequestAPI(h.ctx)
      await h.call('declarativeNetRequest.updateDynamicRules', editor, {
        addRules: [
          {
            id: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Test', operation: 'set', value: 'yes' }, { header: 'Cookie', operation: 'remove' }] },
            condition: { urlFilter: 'site.example' },
          },
        ],
      })
      expect(dnr.modifyHeaders('request', details('https://site.example/') as any, { cookie: 'a=1', Accept: '*/*' })).to.deep.equal({
        Accept: '*/*',
        'X-Test': 'yes',
      })
    })
  })

  describe('downloads', () => {
    const downloader = extension('dl-probe', { permissions: ['downloads'] })

    it('takes a filename only inside the downloads folder', async () => {
      const h = makeCtx({ extensions: [downloader] })
      new DownloadsAPI(h.ctx)
      for (const filename of ['../escape.txt', '/tmp/escape.txt', 'a/../../b.txt', 'C:\\x.txt', 'nul.txt', 'bad\u0000name', 'dir/']) {
        await expect(h.call('downloads.download', downloader, { url: 'https://site.example/f', filename })).to.be.rejectedWith('Invalid filename')
      }
      for (const url of ['notaurl', 'file:///etc/passwd', 'chrome://settings', 'chrome-extension://other/x']) {
        await expect(h.call('downloads.download', downloader, { url })).to.be.rejectedWith('Invalid URL')
      }
      await expect(h.call('downloads.pause', downloader, 987654)).to.be.rejectedWith('Invalid downloadId')
    })

    it('keeps the list across a restart, and a download that was running is interrupted', async () => {
      const state: Record<string, unknown> = {
        downloads: {
          nextId: 8,
          items: [
            { id: 6, url: 'https://site.example/a', filename: path.join(os.tmpdir(), 'no-such-download-file'), state: 'complete', startTime: new Date(1000).toISOString(), exists: true, totalBytes: 3 },
            { id: 7, url: 'https://site.example/b', filename: '', state: 'in_progress', startTime: new Date(5000).toISOString(), exists: true, totalBytes: 3 },
          ],
        },
      }
      const h = makeCtx({ extensions: [downloader], state })
      new DownloadsAPI(h.ctx)
      const items = await h.call('downloads.search', downloader, { orderBy: ['id'] })
      expect(items.map((d: any) => [d.id, d.state, d.exists])).to.deep.equal([
        [6, 'complete', false],
        [7, 'interrupted', true],
      ])
      expect(items[1].error).to.equal('CRASH')
      await expect(h.call('downloads.open', downloader, 6)).to.be.rejectedWith('User gesture required')
      await expect(h.call('downloads.removeFile', downloader, 7)).to.be.rejectedWith('Download must be complete')

      // browsingData forgets downloads started since a time, not their files.
      h.ctx.store.emit('clear-downloads', { since: 3000 })
      await new Promise((r) => setTimeout(r, 10))
      expect((await h.call('downloads.search', downloader, {})).map((d: any) => d.id)).to.deep.equal([6])
      expect(h.events.filter((e) => e.name === 'downloads.onErased').map((e) => e.args[0])).to.deep.equal([7])
    })

    it('needs downloads.ui to change the download UI, and tells the host', async () => {
      const calls: boolean[] = []
      const ui = extension('dl-ui', { permissions: ['downloads', 'downloads.ui'] })
      const h = makeCtx({ extensions: [downloader, ui], impl: { setDownloadUiEnabled: (_e: any, on: boolean) => calls.push(on) } })
      new DownloadsAPI(h.ctx)
      await expect(h.call('downloads.setUiOptions', downloader, { enabled: false })).to.be.rejectedWith(
        'downloads.setUiOptions requires "downloads.ui" permission',
      )
      await h.call('downloads.setUiOptions', ui, { enabled: false })
      await h.call('downloads.setUiOptions', ui, { enabled: true })
      expect(calls).to.deep.equal([false, true])
    })
  })

  describe('scripting', () => {
    const tab = (id: number, url: string) => {
      const frame: any = { url, isDestroyed: () => false, frameTreeNodeId: 1, parent: null }
      frame.top = frame
      frame.framesInSubtree = [frame]
      const wc: any = new EventEmitter()
      Object.assign(wc, { id, mainFrame: frame, isDestroyed: () => false, getURL: () => url })
      return wc
    }
    const scripter = extension('scripter', { permissions: ['scripting', 'tabs'], host_permissions: ['https://site.example/*'] })

    it('checks the tab and host access before Electron injects anything', async () => {
      const h = makeCtx({ extensions: [scripter] })
      new ScriptingAPI(h.ctx)
      h.ctx.store.tabs.add(tab(1, 'https://site.example/page'))
      h.ctx.store.tabs.add(tab(2, 'https://other.example/page'))
      h.ctx.store.tabs.add(tab(3, 'chrome://settings'))
      h.ctx.store.tabs.add(tab(4, 'chrome-extension://another/page.html'))
      const run = (tabId: number) => h.call('scripting.executeScript', scripter, { target: { tabId }, func: '() => 1' })
      expect(await run(1)).to.deep.include({ mode: 'electron', target: { tabId: 1 } })
      await expect(run(2)).to.be.rejectedWith(
        'Cannot access contents of url "https://other.example/page". Extension manifest must request permission to access this host.',
      )
      await expect(run(3)).to.be.rejectedWith('Cannot access a chrome:// URL')
      await expect(run(4)).to.be.rejectedWith('Cannot access a chrome-extension:// URL of different extension')
      await expect(run(987654)).to.be.rejectedWith('No tab with id: 987654')
    })

    it('hands persisted content scripts back once per run, and drops ones that asked not to persist', async () => {
      const state: Record<string, unknown> = {
        'scripting.dynamic.registry.v1': {
          scripter: [
            { id: 'keep', matches: ['https://site.example/*'], js: ['a.js'] },
            { id: 'drop', matches: ['https://site.example/*'], js: ['a.js'], persistAcrossSessions: false },
          ],
        },
      }
      const h = makeCtx({ extensions: [scripter], state })
      new ScriptingAPI(h.ctx)
      expect((await h.call('scripting.restoreContentScripts', scripter)).map((s: any) => s.id)).to.deep.equal(['keep'])
      expect(await h.call('scripting.restoreContentScripts', scripter)).to.deep.equal([])
      await h.call('scripting.syncContentScripts', scripter, [
        { id: 'new', matches: ['https://site.example/*'], js: ['b.js'], persistAcrossSessions: true },
        { id: 'temp', matches: ['https://site.example/*'], js: ['b.js'], persistAcrossSessions: false },
      ])
      expect((state['scripting.contentScripts'] as any).scripter.map((s: any) => s.id)).to.deep.equal(['new'])
    })
  })

  describe('debugger', () => {
    const debuggerTab = (id: number, url: string) => {
      const wc: any = new EventEmitter()
      const dbg: any = new EventEmitter()
      let attached = false
      Object.assign(dbg, {
        attach: () => (attached = true),
        detach: () => (attached = false),
        isAttached: () => attached,
        sendCommand: async (method: string) => ({ method }),
      })
      Object.assign(wc, { id, debugger: dbg, isDestroyed: () => false, getURL: () => url, getTitle: () => 't' })
      return wc
    }
    const devtool = extension('devtool', { permissions: ['debugger'] })

    it('never attaches to browser pages or another extension\'s, and refuses commands that reach past the page', async () => {
      const h = makeCtx({ extensions: [devtool] })
      new DebuggerAPI(h.ctx)
      const page = debuggerTab(1, 'https://site.example/')
      h.ctx.store.tabs.add(page)
      h.ctx.store.tabs.add(debuggerTab(2, 'peersky://settings'))
      h.ctx.store.tabs.add(debuggerTab(3, 'chrome-extension://another/page.html'))
      await expect(h.call('debugger.attach', devtool, { tabId: 2 }, '1.3')).to.be.rejectedWith('Cannot attach to this target.')
      await expect(h.call('debugger.attach', devtool, { tabId: 3 }, '1.3')).to.be.rejectedWith(
        'Cannot access a chrome-extension:// URL of different extension',
      )
      await expect(h.call('debugger.attach', devtool, { tabId: 1 }, '0.1')).to.be.rejectedWith(
        'Requested protocol version is not supported: 0.1.',
      )
      await h.call('debugger.attach', devtool, { tabId: 1 }, '1.3')
      await expect(h.call('debugger.attach', devtool, { tabId: 1 }, '1.3')).to.be.rejectedWith(
        'Another debugger is already attached to the tab with id: 1.',
      )
      await expect(h.call('debugger.sendCommand', devtool, { tabId: 1 }, 'Browser.close')).to.be.rejectedWith('-32601')
      await expect(
        h.call('debugger.sendCommand', devtool, { tabId: 1 }, 'Page.navigate', { url: 'peersky://settings' }),
      ).to.be.rejectedWith('Cannot attach to this target.')
      expect(await h.call('debugger.sendCommand', devtool, { tabId: 1 }, 'Runtime.enable')).to.deep.equal({ method: 'Runtime.enable' })

      // Navigating to a browser page ends the session, and the extension is told.
      page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'peersky://settings' })
      expect(page.debugger.isAttached()).to.equal(false)
      expect(h.events.find((e) => e.name === 'debugger.onDetach')?.args).to.deep.equal([{ tabId: 1 }, 'target_closed'])
      await h.call('debugger.attach', devtool, { tabId: 1 }, '1.3')
      h.events.length = 0
      await h.call('debugger.detach', devtool, { tabId: 1 })
      expect(h.events.filter((e) => e.name === 'debugger.onDetach')).to.deep.equal([])
      await expect(h.call('debugger.detach', devtool, { tabId: 1 })).to.be.rejectedWith(
        'Debugger is not attached to the tab with id: 1.',
      )
    })
  })

  describe('userScripts', () => {
    let dir: string
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-user-scripts-'))
      fs.writeFileSync(path.join(dir, 'script.js'), '1')
    })
    after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const manager = () => extension('script-manager', { permissions: ['userScripts'] }, dir)

    const allowed = { isUserScriptsAllowed: () => true }

    it('checks scripts as Chrome does and keeps them across a restart', async () => {
      const state: Record<string, unknown> = {}
      const h = makeCtx({ extensions: [manager()], state, impl: allowed })
      new UserScriptsAPI(h.ctx)
      const register = (scripts: any[]) => h.call('userScripts.register', manager(), scripts)
      await expect(register([{ id: '_x', matches: ['https://a.example/*'], js: [{ code: '1' }] }])).to.be.rejectedWith(
        "Script's ID '_x' must not start with '_'",
      )
      await expect(register([{ id: 'x', matches: [], js: [{ code: '1' }] }])).to.be.rejectedWith(
        "Script with ID 'x' must specify at least one match.",
      )
      await expect(register([{ id: 'x', matches: ['nope'], js: [{ code: '1' }] }])).to.be.rejectedWith(
        "Script with ID 'x' has invalid value for matches[0]: Missing scheme separator.",
      )
      await expect(register([{ id: 'x', matches: ['https://a.example/*'], js: [{ code: '1', file: 'script.js' }] }])).to.be.rejectedWith(
        "Exactly one of 'code' and 'file' must be specified.",
      )
      await expect(register([{ id: 'x', matches: ['https://a.example/*'], js: [{ file: '../outside.js' }] }])).to.be.rejectedWith(
        "Could not load javascript '../outside.js' for script.",
      )
      await register([{ id: 'x', matches: ['https://a.example/*'], js: [{ file: 'script.js' }] }])
      await expect(register([{ id: 'x', matches: ['https://a.example/*'], js: [{ code: '1' }] }])).to.be.rejectedWith(
        "Duplicate script ID 'x'",
      )
      await h.call('userScripts.configureWorld', manager(), { worldId: 'w', messaging: true })

      const again = makeCtx({ extensions: [manager()], state, impl: allowed })
      new UserScriptsAPI(again.ctx)
      expect(await again.call('userScripts.getScripts', manager())).to.deep.equal([
        { id: 'x', matches: ['https://a.example/*'], js: [{ file: 'script.js' }], runAt: 'document_idle', allFrames: false, world: 'USER_SCRIPT' },
      ])
      expect(await again.call('userScripts.getWorldConfigurations', manager())).to.deep.equal([{ worldId: 'w', messaging: true }])
      await expect(again.call('userScripts.unregister', manager(), { ids: ['nope'] })).to.be.rejectedWith("Nonexistent script ID 'nope'")
      await expect(again.call('userScripts.update', manager(), [{ id: 'nope' }])).to.be.rejectedWith(
        "Script with ID 'nope' does not exist or is not fully registered",
      )
    })

    it('is refused when the host says the person has not allowed user scripts', async () => {
      const h = makeCtx({ extensions: [manager()], impl: { isUserScriptsAllowed: () => false } })
      new UserScriptsAPI(h.ctx)
      await expect(h.call('userScripts.getScripts', manager())).to.be.rejectedWith('user scripts are not allowed')
    })

    it('is off without a host switch, as in Chrome, and tells new contexts to leave it out', async () => {
      const h = makeCtx({ extensions: [manager()] })
      new UserScriptsAPI(h.ctx)
      await expect(h.call('userScripts.getScripts', manager())).to.be.rejectedWith('user scripts are not allowed')
      const info = Object.assign({}, ...h.contextInfoProviders.map((p) => p(manager(), { type: 'service-worker' })))
      expect(info.userScripts).to.equal(false)
    })
  })
})
