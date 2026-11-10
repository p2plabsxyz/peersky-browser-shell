import { app, webFrameMain } from 'electron'
import debug from 'debug'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const d = debug('electron-chrome-extensions:webNavigation')

/**
 * A page starts loading before the host tells us it is a tab, so events for
 * a new page wait this long to learn whether it is one.
 */
const PENDING_TAB_MS = 10_000
const MAX_PENDING_EVENTS = 64

type Details = Record<string, any>

/** Frame state Chrome keeps for getFrame: the URL and whether its load failed. */
interface FrameState {
  url: string
  errorOccurred: boolean
  /** The navigation being made in this frame was redirected by the server. */
  redirected?: boolean
}

function alive(frame: Electron.WebFrameMain | null | undefined): Electron.WebFrameMain | null {
  if (!frame) return null
  try {
    return frame.isDestroyed() || frame.detached ? null : frame
  } catch {
    return null
  }
}

const frameIdOf = (frame: Electron.WebFrameMain) => (frame === frame.top ? 0 : frame.frameTreeNodeId)
const parentIdOf = (frame: Electron.WebFrameMain) => (frame.parent ? frameIdOf(frame.parent) : -1)
const frameTypeOf = (frame: Electron.WebFrameMain) => (frame.parent ? 'sub_frame' : 'outermost_frame')

const withoutHash = (url: string) => {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

export class WebNavigationAPI {
  private observed = new WeakSet<Electron.WebContents>()
  /** Events for pages not yet known to be tabs, by webContents id. */
  private pending = new Map<number, { since: number; events: [string, Details][] }>()
  private frames = new Map<string, FrameState>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webNavigation.getFrame', this.getFrame)
    handle('webNavigation.getAllFrames', this.getAllFrames)

    // Watch every page in the session from its start, so the first
    // navigation of a new tab is seen whole, from onBeforeNavigate on.
    app.on('web-contents-created', (_event, wc) => {
      if (wc.session !== this.ctx.session) return
      const type = wc.getType()
      if (type === 'backgroundPage' || type === 'remote') return
      this.observe(wc)
      this.pending.set(wc.id, { since: Date.now(), events: [] })
    })
    this.ctx.store.on('tab-added', (tab: Electron.WebContents) => {
      this.observe(tab)
      this.flush(tab)
    })
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const key of [...this.frames.keys()]) if (key.startsWith(`${tabId}:`)) this.frames.delete(key)
    })
  }

  private key(tabId: number, frameId: number) {
    return `${tabId}:${frameId}`
  }

  private send(tab: Electron.WebContents, name: string, details: Details) {
    if (this.ctx.store.tabs.has(tab)) {
      d(`${name} [url: ${details.url}]`)
      this.ctx.router.broadcastEvent(`webNavigation.${name}`, details)
      return
    }
    const waiting = this.pending.get(tab.id)
    if (!waiting) return
    if (Date.now() - waiting.since > PENDING_TAB_MS) {
      this.pending.delete(tab.id)
      return
    }
    if (waiting.events.length < MAX_PENDING_EVENTS) waiting.events.push([name, details])
  }

  private flush(tab: Electron.WebContents) {
    const waiting = this.pending.get(tab.id)
    this.pending.delete(tab.id)
    if (!waiting || Date.now() - waiting.since > PENDING_TAB_MS) return
    for (const [name, details] of waiting.events) this.send(tab, name, details)
  }

  private observe(tab: Electron.WebContents) {
    if (this.observed.has(tab)) return
    this.observed.add(tab)
    const tabId = tab.id
    let first = true

    tab.on('did-start-navigation', (details) => {
      if (details.isSameDocument) return
      const frame = alive(details.frame)
      if (!frame) return
      const frameId = frameIdOf(frame)
      const state = this.frames.get(this.key(tabId, frameId))
      if (state) state.redirected = false
      if (first && frame === frame.top) {
        first = false
        this.createdNavigationTarget(tab, details.url)
      }
      this.send(tab, 'onBeforeNavigate', {
        frameId,
        parentFrameId: parentIdOf(frame),
        ...this.parentDocument(tabId, frame),
        frameType: frameTypeOf(frame),
        documentLifecycle: 'active',
        processId: -1,
        tabId,
        timeStamp: Date.now(),
        url: details.url,
      })
    })

    tab.on('did-redirect-navigation', (details) => {
      const frame = alive(details.frame)
      if (!frame) return
      const state = this.frames.get(this.key(tabId, frameIdOf(frame)))
      if (state) state.redirected = true
      else this.frames.set(this.key(tabId, frameIdOf(frame)), { url: details.url, errorOccurred: false, redirected: true })
    })

    tab.on(
      'did-frame-navigate',
      (_event, url, _code, _status, isMainFrame, frameProcessId, frameRoutingId) => {
        const frame = alive(webFrameMain.fromId(frameProcessId, frameRoutingId))
        if (!frame) return
        const frameId = frameIdOf(frame)
        const key = this.key(tabId, frameId)
        const previous = this.frames.get(key)
        // A new document: it gets its own id, as in Chrome.
        const documentId = this.ctx.store.newDocumentId(tabId, frameId)
        let transitionType = isMainFrame ? 'link' : 'auto_subframe'
        if (isMainFrame && previous && previous.url === url) transitionType = 'reload'
        const transitionQualifiers: string[] = previous?.redirected ? ['server_redirect'] : []
        this.frames.set(key, { url, errorOccurred: false })
        this.send(tab, 'onCommitted', {
          documentId,
          documentLifecycle: 'active',
          frameId,
          frameType: frameTypeOf(frame),
          parentFrameId: parentIdOf(frame),
          ...this.parentDocument(tabId, frame),
          processId: frameProcessId,
          tabId,
          timeStamp: Date.now(),
          transitionQualifiers,
          transitionType,
          url,
        })
      },
    )

    tab.on('dom-ready', () => {
      const frame = alive(tab.mainFrame)
      if (frame) this.domContentLoaded(tab, frame)
    })
    tab.on('frame-created', (_event, { frame }) => {
      const f = alive(frame)
      if (!f || f === f.top) return
      f.on('dom-ready', () => {
        const live = alive(f)
        if (live) this.domContentLoaded(tab, live)
      })
    })

    tab.on('did-frame-finish-load', (_event, _isMainFrame, frameProcessId, frameRoutingId) => {
      const frame = alive(webFrameMain.fromId(frameProcessId, frameRoutingId))
      if (!frame) return
      this.send(tab, 'onCompleted', this.documentDetails(tab, frame, frameProcessId))
    })

    const failed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      _isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number,
    ) => {
      const frame = alive(webFrameMain.fromId(frameProcessId, frameRoutingId))
      if (!frame) return
      const frameId = frameIdOf(frame)
      this.frames.set(this.key(tabId, frameId), { url: validatedURL, errorOccurred: true })
      const error = errorDescription
        ? errorDescription.startsWith('net::')
          ? errorDescription
          : `net::${errorDescription}`
        : `net::ERR_FAILED (${errorCode})`
      this.send(tab, 'onErrorOccurred', {
        ...this.documentDetails(tab, frame, frameProcessId),
        error,
        url: validatedURL,
      })
    }
    tab.on('did-fail-load', failed)

    tab.on('did-navigate-in-page', (_event, url, _isMainFrame, frameProcessId, frameRoutingId) => {
      const frame = alive(webFrameMain.fromId(frameProcessId, frameRoutingId))
      if (!frame) return
      const key = this.key(tabId, frameIdOf(frame))
      const previous = this.frames.get(key)?.url
      this.frames.set(key, { url, errorOccurred: false })
      // Only the fragment changed: Chrome reports that on its own.
      const fragmentOnly = !!previous && withoutHash(previous) === withoutHash(url) && previous !== url
      this.send(tab, fragmentOnly ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated', {
        ...this.documentDetails(tab, frame, frameProcessId),
        transitionQualifiers: [],
        transitionType: 'link',
        url,
      })
    })

    tab.once('destroyed', () => {
      this.pending.delete(tabId)
    })
  }

  private parentDocument(tabId: number, frame: Electron.WebFrameMain) {
    if (!frame.parent) return {}
    const parentDocumentId = this.ctx.store.getDocumentId(tabId, frameIdOf(frame.parent))
    return parentDocumentId ? { parentDocumentId } : {}
  }

  private documentDetails(tab: Electron.WebContents, frame: Electron.WebFrameMain, processId: number) {
    const tabId = tab.id
    const frameId = frameIdOf(frame)
    const documentId =
      this.ctx.store.getDocumentId(tabId, frameId) || this.ctx.store.newDocumentId(tabId, frameId)
    return {
      documentId,
      documentLifecycle: 'active',
      frameId,
      frameType: frameTypeOf(frame),
      parentFrameId: parentIdOf(frame),
      ...this.parentDocument(tabId, frame),
      processId,
      tabId,
      timeStamp: Date.now(),
      url: frame.url,
    }
  }

  private domContentLoaded(tab: Electron.WebContents, frame: Electron.WebFrameMain) {
    this.send(tab, 'onDOMContentLoaded', this.documentDetails(tab, frame, frame.processId))
  }

  /** A page opened by another tab (window.open, a link with a target). */
  private createdNavigationTarget(tab: Electron.WebContents, url: string) {
    let opener: Electron.WebFrameMain | null = null
    try {
      opener = alive((tab as any).opener)
    } catch {}
    if (!opener) return
    const source = [...this.ctx.store.tabs].find(
      (t) => !t.isDestroyed() && t.mainFrame.framesInSubtree.includes(opener!),
    )
    if (!source) return
    this.send(tab, 'onCreatedNavigationTarget', {
      sourceFrameId: frameIdOf(opener),
      sourceProcessId: opener.processId,
      sourceTabId: source.id,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    })
  }

  private findFrame(tab: Electron.WebContents, frameId: number) {
    return tab.mainFrame.framesInSubtree.find((f) => alive(f) && frameIdOf(f) === frameId)
  }

  private frameResult(tab: Electron.WebContents, frame: Electron.WebFrameMain) {
    const tabId = tab.id
    const frameId = frameIdOf(frame)
    const state = this.frames.get(this.key(tabId, frameId))
    return {
      documentId: this.ctx.store.getDocumentId(tabId, frameId) || this.ctx.store.newDocumentId(tabId, frameId),
      documentLifecycle: 'active',
      errorOccurred: !!state?.errorOccurred,
      frameType: frameTypeOf(frame),
      parentFrameId: parentIdOf(frame),
      ...this.parentDocument(tabId, frame),
      url: frame.url,
    }
  }

  private getFrame = (
    _event: ExtensionEvent,
    details: { tabId?: number; frameId?: number; documentId?: string; processId?: number },
  ) => {
    if (!details || typeof details !== 'object') {
      throw new Error("Error at parameter 'details': Invalid type: expected object.")
    }
    let { tabId, frameId } = details
    if (typeof details.documentId === 'string') {
      const resolved = this.ctx.store.resolveByDocumentId(details.documentId)
      if (!resolved) return null
      if ((typeof tabId === 'number' && tabId !== resolved.tabId) || (typeof frameId === 'number' && frameId !== resolved.frameId)) {
        return null
      }
      tabId = resolved.tabId
      frameId = resolved.frameId
    } else if (typeof tabId !== 'number' || typeof frameId !== 'number') {
      throw new Error('Either documentId or both tabId and frameId must be specified.')
    }
    const tab = typeof tabId === 'number' ? this.ctx.store.getTabById(tabId) : undefined
    if (!tab || typeof frameId !== 'number') return null
    const frame = this.findFrame(tab, frameId)
    return frame ? this.frameResult(tab, frame) : null
  }

  private getAllFrames = (_event: ExtensionEvent, details: { tabId?: number }) => {
    if (!details || typeof details.tabId !== 'number') {
      throw new Error("Error at parameter 'details': Missing required property 'tabId'.")
    }
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab) return null
    return tab.mainFrame.framesInSubtree
      .filter((f) => alive(f))
      .map((frame) => ({
        ...this.frameResult(tab, frame),
        frameId: frameIdOf(frame),
        processId: frame.processId,
      }))
  }
}
