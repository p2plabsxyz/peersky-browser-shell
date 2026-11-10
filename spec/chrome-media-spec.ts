import { expect } from 'chai'
import { BaseWindow, BrowserWindow, session } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, promises as fs } from 'node:fs'
import * as path from 'node:path'

import { DesktopCaptureAPI } from '../src/browser/api/desktop-capture'
import { PageCaptureAPI } from '../src/browser/api/page-capture'
import { TabCaptureAPI } from '../src/browser/api/tab-capture'
import { TtsAPI, validateSpeakArgs } from '../src/browser/api/tts'
import { ExtensionPermissions } from '../src/browser/permissions'
import { uuid } from './spec-helpers'

const { startProbeServer } = require('./probe-server')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(check: () => T | undefined, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(25)
  }
  throw new Error('timed out')
}

const makeExtension = (id: string, permissions: string[]) =>
  ({ id, name: id, path: '/', url: `chrome-extension://${id}/`, manifest: { manifest_version: 3, permissions } }) as any

/** A ctx with the parts these APIs use; tabs are whatever `tabs` holds. */
function makeCtx(opts: { tabs?: any[]; impl?: any; session?: Electron.Session } = {}) {
  const handlers = new Map<string, Function>()
  const events: Array<{ extensionId: string; name: string; payload: any }> = []
  const state: Record<string, unknown> = {}
  const sessionExtensions: EventEmitter = opts.session ? (opts.session.extensions as any) : new EventEmitter()
  const permissions = new ExtensionPermissions({
    stateStore: {
      whenHydrated: async () => {},
      getNamespace: (name: string, fallback: any) => (state[name] as any) ?? fallback,
      setNamespace: (name: string, value: unknown) => {
        state[name] = value
      },
    },
    sendEvent: () => {},
    prompt: async () => false,
  })
  const tabs = opts.tabs ?? []
  const ctx: any = {
    router: {
      apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
      sendEvent: (extensionId: string, name: string, payload: any) => events.push({ extensionId, name, payload }),
      broadcastEvent: () => {},
    },
    session: opts.session ?? { extensions: sessionExtensions },
    store: {
      tabs: new Set(tabs),
      tabToWindow: new WeakMap(),
      impl: opts.impl ?? {},
      getTabById: (id: number) => tabs.find((t) => t.id === id && !t.isDestroyed()),
      getCurrentWindowForExtension: () => null,
      getActiveTabFromWindow: () => undefined,
    },
    permissions,
  }
  return { ctx, handlers, events, permissions, sessionExtensions }
}

class FakeTab extends EventEmitter {
  destroyed = false
  captured = false
  saved: string[] = []
  constructor(public id: number, public url: string) {
    super()
  }
  getURL() {
    return this.url
  }
  isDestroyed() {
    return this.destroyed
  }
  isBeingCaptured() {
    return this.captured
  }
  getMediaSourceId(consumer: { id: number }) {
    return `stream:${this.id}:${consumer.id}`
  }
  async savePage(file: string) {
    this.saved.push(file)
    await fs.writeFile(file, 'From: <Saved by Blink>\r\n')
  }
}

describe('chrome.tts', () => {
  describe('arguments', () => {
    const signature = 'Error in invocation of tts.speak(string utterance, optional tts.TtsOptions options, optional function callback): '
    it("checks them as Chrome does, with Chrome's messages", () => {
      expect(() => validateSpeakArgs(5, undefined)).to.throw(signature + 'No matching signature.')
      expect(() => validateSpeakArgs('x', 5)).to.throw(signature + 'No matching signature.')
      expect(() => validateSpeakArgs('x', { rate: 11 })).to.throw(
        signature + "Error at parameter 'options': Error at property 'rate': Value must be at most 10.",
      )
      expect(() => validateSpeakArgs('x', { volume: -1 })).to.throw("Error at property 'volume': Value must be at least 0.")
      expect(() => validateSpeakArgs('x', { gender: 'x' })).to.throw("Error at property 'gender': Value must be one of female, male.")
      expect(() => validateSpeakArgs('x', { desiredEventTypes: [5] })).to.throw(
        "Error at property 'desiredEventTypes': Error at index 0: Invalid type: expected string, found integer.",
      )
      expect(() => validateSpeakArgs('x', { srcId: 1 })).to.throw("Unexpected property: 'srcId'.")
      expect(validateSpeakArgs('x', { srcId: 1, rate: 0 }, true)).to.deep.equal({ srcId: 1, rate: 0 })
    })
  })

  describe('speech', function () {
    this.timeout(30_000)
    const a = makeExtension('a', ['tts'])
    const b = makeExtension('b', ['tts'])
    let harness: ReturnType<typeof makeCtx>
    const call = (name: string, extension: any, ...args: any[]) =>
      harness.handlers.get(`tts.${name}`)!({ extension, type: 'service-worker' }, ...args)
    const eventsFor = (srcId: number) =>
      harness.events.filter((e) => e.name === 'tts.onEvent' && e.payload.srcId === srcId).map((e) => e.payload)
    const typesFor = (srcId: number) => eventsFor(srcId).map((e) => e.type).filter((t) => t !== 'word')

    beforeEach(() => {
      harness = makeCtx({ session: session.fromPartition(`tts-${uuid()}`) })
      new TtsAPI(harness.ctx)
    })
    afterEach(async () => {
      await call('stop', a)
      await call('stop', b)
    })

    it('speaks from a page that never shows, and tells only callers that asked', async () => {
      const windows = BaseWindow.getAllWindows().length + BrowserWindow.getAllWindows().length
      call('speak', a, 'probe', { volume: 0, srcId: 1 })
      call('speak', a, 'probe', { volume: 0, enqueue: true })
      await waitFor(() => eventsFor(1).find((e) => e.isFinalEvent))
      expect(typesFor(1)).to.deep.equal(['start', 'end'])
      expect(eventsFor(1).slice(-1)[0]).to.deep.equal({ type: 'end', charIndex: 5, srcId: 1, isFinalEvent: true })
      expect(BaseWindow.getAllWindows().length + BrowserWindow.getAllWindows().length).to.equal(windows)
      await sleep(1500)
      expect(harness.events.filter((e) => e.payload?.srcId === undefined && e.name === 'tts.onEvent')).to.deep.equal([])
    })

    it('cuts off what speaks and drops what waits when a speak does not enqueue', async () => {
      call('speak', a, 'the first one is long enough to be cut off', { volume: 0, srcId: 1 })
      call('speak', b, 'second', { volume: 0, srcId: 2, enqueue: true })
      await waitFor(() => eventsFor(1).find((e) => e.type === 'start'))
      expect(await call('isSpeaking', a)).to.equal(true)
      call('speak', b, 'third', { volume: 0, srcId: 3 })
      await waitFor(() => eventsFor(3).find((e) => e.isFinalEvent))
      expect(typesFor(1)).to.deep.equal(['start', 'interrupted'])
      expect(typesFor(2)).to.deep.equal(['cancelled'])
      expect(typesFor(3)).to.deep.equal(['start', 'end'])
      expect(harness.events.filter((e) => e.payload.srcId === 2).every((e) => e.extensionId === 'b')).to.equal(true)
    })

    it("leaves another extension's speech alone when an extension stops", async () => {
      call('speak', a, 'this one keeps speaking for a little while', { volume: 0, srcId: 1 })
      await waitFor(() => eventsFor(1).find((e) => e.type === 'start'))
      await call('stop', b)
      expect(await call('isSpeaking', b)).to.equal(true)
      await call('stop', a)
      expect(typesFor(1)).to.deep.equal(['start', 'interrupted'])
      expect(await call('isSpeaking', a)).to.equal(false)
    })

    it('ends the speech of an extension that unloads', async () => {
      call('speak', a, 'this one is cut off by the unload', { volume: 0, srcId: 1 })
      call('speak', a, 'and this one never starts', { volume: 0, srcId: 2, enqueue: true })
      await waitFor(() => eventsFor(1).find((e) => e.type === 'start'))
      harness.sessionExtensions.emit('extension-unloaded', {}, a)
      expect(await call('isSpeaking', a)).to.equal(false)
      await sleep(500)
      expect(eventsFor(2)).to.deep.equal([])
    })

    it("lists the system's voices in Chrome's TtsVoice shape", async () => {
      const voices = await call('getVoices', a)
      expect(voices).to.be.an('array')
      for (const voice of voices) {
        expect(voice.voiceName).to.be.a('string')
        expect(voice.remote).to.be.a('boolean')
        expect(voice.eventTypes).to.include('end')
      }
    })
  })
})

describe('chrome.pageCapture', () => {
  const ext = makeExtension('probe', ['pageCapture'])
  const setup = (tabs: any[]) => {
    const harness = makeCtx({ tabs })
    new PageCaptureAPI(harness.ctx)
    return (details: any) => harness.handlers.get('pageCapture.saveAsMHTML')!({ extension: ext }, details)
  }

  it("refuses the browser's own pages, other extensions' pages and files, without saving them", async () => {
    const urls = [
      'peersky://settings',
      'chrome://gpu',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://otherextensionid/page.html',
      'file:///etc/passwd',
      'about:blank',
      'data:text/html,x',
    ]
    const tabs = urls.map((url, i) => new FakeTab(i + 1, url))
    const save = setup(tabs)
    for (const tab of tabs) {
      await expect(save({ tabId: tab.id })).to.be.rejectedWith("Don't have permissions required to capture this page.")
      expect(tab.saved).to.deep.equal([])
    }
  })

  it('hands back the bytes and deletes the temporary file', async () => {
    const own = new FakeTab(1, 'chrome-extension://probe/page.html')
    const web = new FakeTab(2, 'https://example.com/')
    const save = setup([own, web])
    for (const tab of [own, web]) {
      const bytes: Buffer = await save({ tabId: tab.id })
      expect(bytes.toString()).to.equal('From: <Saved by Blink>\r\n')
      expect(existsSync(path.dirname(tab.saved[0]))).to.equal(false)
    }
  })

  it("checks its arguments as Chrome does, with Chrome's messages", async () => {
    const save = setup([])
    await expect(save({ tabId: 987654 })).to.be.rejectedWith('Cannot find the tab for this request.')
    await expect(save({ tabId: 'x' })).to.be.rejectedWith("Error at property 'tabId': Invalid type: expected integer, found string.")
    await expect(save({ tabId: 1, nope: 1 })).to.be.rejectedWith("Unexpected property: 'nope'.")
    await expect(save(undefined)).to.be.rejectedWith('No matching signature.')
  })

  it('saves a real page as MHTML and never shows it as a download', async function () {
    this.timeout(20_000)
    const server = await startProbeServer()
    const ses = session.fromPartition(`mhtml-${uuid()}`)
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses } })
    let downloads = 0
    ses.on('will-download', () => downloads++)
    try {
      await win.loadURL(`${server.base}page?mhtml`)
      const harness = makeCtx({ tabs: [win.webContents] })
      new PageCaptureAPI(harness.ctx)
      const bytes: Buffer = await harness.handlers.get('pageCapture.saveAsMHTML')!({ extension: ext }, { tabId: win.webContents.id })
      const text = bytes.toString()
      expect(text.startsWith('From: <Saved by Blink>')).to.equal(true)
      expect(text).to.include('Subject: Probe page')
      expect(downloads).to.equal(0)
    } finally {
      win.destroy()
      await server.close()
    }
  })
})

describe('chrome.tabCapture', function () {
  this.timeout(10_000)
  const GRANT = 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'
  const setup = (permissions: string[], tabs: FakeTab[]) => {
    const harness = makeCtx({ tabs })
    const extension = makeExtension('cap', permissions)
    new TabCaptureAPI(harness.ctx)
    const page = { id: 77 }
    const call = (name: string, ...args: any[]) =>
      harness.handlers.get(`tabCapture.${name}`)!({ extension, type: 'frame', sender: page }, ...args)
    return { ...harness, extension, call }
  }

  it('gives a stream id only for a tab the extension was invoked on, bound to the calling page', () => {
    const tab = new FakeTab(5, 'https://example.com/')
    const { call, permissions, extension } = setup(['tabCapture'], [tab])
    expect(() => call('getMediaStreamId', { targetTabId: 5 })).to.throw(GRANT)
    expect(() => call('getMediaStreamId', { targetTabId: 987654 })).to.throw('Invalid tab specified.')
    // Chrome grants tabCapture on invocation without activeTab too.
    permissions.grantActiveTab(extension, 5, tab.url)
    expect(call('getMediaStreamId', { targetTabId: 5 })).to.equal('stream:5:77')
  })

  it("never captures the browser's own pages, even when invoked there", () => {
    const tab = new FakeTab(6, 'peersky://settings')
    const { call, permissions, extension } = setup(['tabCapture', 'activeTab'], [tab])
    permissions.grantActiveTab(extension, 6, tab.url)
    expect(() => call('getMediaStreamId', { targetTabId: 6 })).to.throw(GRANT)
  })

  it('loses the grant when the tab moves to another site', () => {
    const tab = new FakeTab(7, 'https://example.com/')
    const { call, permissions, extension } = setup(['tabCapture'], [tab])
    permissions.grantActiveTab(extension, 7, tab.url)
    permissions.revokeActiveTab(7, 'https://other.test/')
    expect(() => call('getMediaStreamId', { targetTabId: 7 })).to.throw(GRANT)
  })

  it('refuses a second stream of a tab while one is out', () => {
    const tab = new FakeTab(8, 'https://example.com/')
    const { call, permissions, extension } = setup(['tabCapture'], [tab])
    permissions.grantActiveTab(extension, 8, tab.url)
    call('getMediaStreamId', { targetTabId: 8 })
    expect(() => call('getMediaStreamId', { targetTabId: 8 })).to.throw('Cannot capture a tab with an active stream.')
  })

  it('follows the stream with getCapturedTabs and onStatusChanged', async () => {
    const tab = new FakeTab(9, 'https://example.com/')
    const { call, permissions, extension, events } = setup(['tabCapture'], [tab])
    permissions.grantActiveTab(extension, 9, tab.url)
    call('getMediaStreamId', { targetTabId: 9 })
    expect(call('getCapturedTabs')).to.deep.equal([])
    tab.captured = true
    await waitFor(() => events.find((e) => e.payload.status === 'active'))
    expect(call('getCapturedTabs')).to.deep.equal([{ tabId: 9, status: 'active', fullscreen: false }])
    tab.captured = false
    await waitFor(() => events.find((e) => e.payload.status === 'stopped'))
    expect(events.map((e) => [e.extensionId, e.name, e.payload.status])).to.deep.equal([
      ['cap', 'tabCapture.onStatusChanged', 'pending'],
      ['cap', 'tabCapture.onStatusChanged', 'active'],
      ['cap', 'tabCapture.onStatusChanged', 'stopped'],
    ])
    expect(call('getCapturedTabs')).to.deep.equal([])
  })

  it("checks capture()'s options as Chrome does", () => {
    const { call } = setup(['tabCapture'], [])
    expect(() => call('capture', {})).to.throw('Capture failed. No audio or video requested.')
  })
})

describe('chrome.desktopCapture', () => {
  const extension = makeExtension('desk', ['desktopCapture'])
  const setup = (impl: any = {}, tabs: any[] = []) => {
    const harness = makeCtx({ impl, tabs })
    new DesktopCaptureAPI(harness.ctx)
    const choose = (type: 'frame' | 'service-worker', ...args: any[]) =>
      harness.handlers.get('desktopCapture.chooseDesktopMedia')!({ extension, type }, ...args)
    const cancel = (id: number) => harness.handlers.get('desktopCapture.cancelChooseDesktopMedia')!({ extension }, id)
    return { choose, cancel }
  }

  it('answers as a cancelled picker when the host has none', async () => {
    const { choose } = setup()
    expect(await choose('frame', 1, ['screen'])).to.deep.equal(['', { canRequestAudioTrack: false }])
  })

  it("asks the host's picker and hands back what the person chose", async () => {
    let asked: any
    const { choose } = setup({
      chooseDesktopMedia: (details: any) => {
        asked = details
        return { id: 'screen:1:0', audio: true }
      },
    })
    expect(await choose('frame', 1, ['screen', 'audio'])).to.deep.equal(['screen:1:0', { canRequestAudioTrack: true }])
    expect(asked.sources).to.deep.equal(['screen', 'audio'])
    expect(asked.extension).to.equal(extension)
    expect(await choose('frame', 2, ['window'])).to.deep.equal(['screen:1:0', { canRequestAudioTrack: false }])
  })

  it('closes the picker when the extension cancels', async () => {
    let signal: AbortSignal | undefined
    const { choose, cancel } = setup({
      chooseDesktopMedia: (details: any) => {
        signal = details.signal
        return new Promise(() => {})
      },
    })
    const answer = choose('frame', 3, ['screen'])
    await sleep(10)
    cancel(3)
    expect(await answer).to.deep.equal(['', { canRequestAudioTrack: false }])
    expect(signal!.aborted).to.equal(true)
  })

  it('takes nothing but a source id from the host', async () => {
    const { choose } = setup({ chooseDesktopMedia: () => ({ id: 42 }) })
    expect(await choose('frame', 4, ['screen'])).to.deep.equal(['', { canRequestAudioTrack: false }])
  })

  it("refuses what Chrome refuses, with Chrome's messages", async () => {
    const tab = new FakeTab(5, 'https://example.com/a')
    const plain = new FakeTab(6, 'http://example.com/')
    const { choose } = setup({}, [tab, plain])
    await expect(choose('service-worker', 1, ['screen'])).to.be.rejectedWith(
      'A target tab is required when called from a service worker context.',
    )
    await expect(choose('frame', 1, [])).to.be.rejectedWith('At least one source type must be specified.')
    await expect(choose('frame', 1, ['nope'])).to.be.rejectedWith('Value must be one of audio, screen, tab, window.')
    await expect(choose('frame', 1, ['screen'], { url: tab.url })).to.be.rejectedWith("targetTab doesn't have id field set.")
    await expect(choose('frame', 1, ['screen'], { id: 5 })).to.be.rejectedWith("targetTab doesn't have URL field set.")
    await expect(choose('frame', 1, ['screen'], { id: 987654, url: tab.url })).to.be.rejectedWith('Invalid tab specified.')
    await expect(choose('frame', 1, ['screen'], { id: 6, url: plain.url })).to.be.rejectedWith(
      'URL scheme for the specified tab is not secure.',
    )
    await expect(choose('frame', 1, ['screen'], { id: 5, url: 'https://other.test/' })).to.be.rejectedWith(
      'URL for the specified tab has changed.',
    )
    expect(await choose('service-worker', 1, ['screen'], { id: 5, url: tab.url })).to.deep.equal([
      '',
      { canRequestAudioTrack: false },
    ])
  })
})

describe('tabCapture and declarativeContent in a real session', function () {
  this.timeout(60_000)
  const PROBE_ID = 'agiecahclpmfdifoehacoelbdlhkclph'
  const { ElectronChromeExtensions } = require('../')
  const { ProbeBrowser } = require('./probe-browser')
  let server: any
  let browser: any
  let page: BrowserWindow
  let tab: Electron.WebContents

  before(async () => {
    server = await startProbeServer()
    const ses = session.fromPartition(`persist:capture-${uuid()}`)
    browser = new ProbeBrowser(ses)
    browser.extensions = new ElectronChromeExtensions({ license: 'internal-license-do-not-use', session: ses, ...browser.impl })
    await (ses.extensions || ses).loadExtension(path.join(__dirname, 'fixtures', 'chrome-api-probe'))
    tab = browser.openWindow(`${server.base}page?captured`).tab
    await new Promise<void>((resolve) => tab.once('did-finish-load', () => resolve()))
    page = new BrowserWindow({ show: false, webPreferences: { session: ses } })
    await page.loadURL(`chrome-extension://${PROBE_ID}/page.html`)
  })

  after(async () => {
    page?.destroy()
    browser?.closeAll()
    await server?.close()
  })

  it('opens a stream of the tab from the id, once the person invoked the extension there', async () => {
    const run = (code: string) => page.webContents.executeJavaScript(code)
    const before = await run(`chrome.tabCapture.getMediaStreamId({ targetTabId: ${tab.id} }).then(() => 'ok', (e) => e.message)`)
    expect(before).to.match(/^Extension has not been invoked/)
    const extension = (page.webContents.session.extensions || page.webContents.session).getExtension(PROBE_ID)
    ;(browser.extensions as any).ctx.permissions.grantActiveTab(extension, tab.id, tab.getURL())
    const result = await run(`(async () => {
      const statuses = []
      chrome.tabCapture.onStatusChanged.addListener((info) => statuses.push(info.status))
      const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: ${tab.id} })
      const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } })
      const tracks = stream.getVideoTracks().length
      await new Promise((r) => setTimeout(r, 1500))
      const captured = await chrome.tabCapture.getCapturedTabs()
      stream.getTracks().forEach((t) => t.stop())
      await new Promise((r) => setTimeout(r, 1500))
      return { tracks, captured, statuses, after: await chrome.tabCapture.getCapturedTabs() }
    })()`)
    expect(result.tracks).to.equal(1)
    expect(result.captured).to.deep.equal([{ tabId: tab.id, status: 'active', fullscreen: false }])
    expect(result.statuses).to.deep.equal(['pending', 'active', 'stopped'])
    expect(result.after).to.deep.equal([])
  })

  it('shows the action and sets its icon on the tab a rule matches, from what the page built', async () => {
    const store = (browser.extensions as any).ctx.store
    const added = await page.webContents.executeJavaScript(`new Promise((resolve) => {
      const dc = chrome.declarativeContent
      const image = new ImageData(2, 2)
      for (let i = 0; i < image.data.length; i += 4) image.data.set([255, 0, 0, 255], i)
      dc.onPageChanged.addRules([{
        id: 'icon',
        conditions: [new dc.PageStateMatcher({ pageUrl: { queryEquals: 'captured' } })],
        actions: [new dc.ShowAction(), new dc.SetIcon({ imageData: image })],
      }], (rules) => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : rules.map((r) => typeof r.actions[1].imageData[2])))
    })`)
    expect(added).to.deep.equal(['string'])
    const state = await waitFor(() => store.getDeclarativeAction(PROBE_ID, tab.id))
    expect(state.show).to.equal(true)
    expect(state.icon['2']).to.match(/^data:image\/png;base64,/)
    await page.webContents.executeJavaScript(`new Promise((resolve) => chrome.declarativeContent.onPageChanged.removeRules(undefined, resolve))`)
    expect(store.getDeclarativeAction(PROBE_ID, tab.id)).to.equal(undefined)
  })

  it('opens the stream itself with capture() in an extension page', async () => {
    const result = await page.webContents.executeJavaScript(`new Promise((resolve) => {
      chrome.tabCapture.capture({ video: true }, (stream) => {
        const error = chrome.runtime.lastError && chrome.runtime.lastError.message
        const tracks = stream ? stream.getVideoTracks().length : 0
        if (stream) stream.getTracks().forEach((t) => t.stop())
        resolve({ tracks, error })
      })
    })`)
    expect(result).to.deep.equal({ tracks: 1, error: undefined })
  })
})
