import * as electron from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import debug from 'debug'

const d = debug('electron-chrome-extensions:webNavigation')

type DocumentLifecycle = 'prerender' | 'active' | 'cached' | 'pending_deletion'

const getFrame = (frameProcessId: number, frameRoutingId: number) =>
  electron.webFrameMain.fromId(frameProcessId, frameRoutingId)

/** Safely access frame data; returns null if the frame was already disposed. */
function withFrame<T>(
  frame: Electron.WebFrameMain | null | undefined,
  fn: (frame: Electron.WebFrameMain) => T,
): T | null {
  if (!frame) return null
  try {
    return fn(frame)
  } catch (err: any) {
    if (
      err?.message?.includes('Render frame was disposed') ||
      err?.message?.includes('WebFrameMain could be accessed')
    ) {
      return null
    }
    throw err
  }
}

const getFrameId = (frame: Electron.WebFrameMain) =>
  frame === frame.top ? 0 : frame.frameTreeNodeId

const getParentFrameId = (frame: Electron.WebFrameMain) => {
  const parentFrame = frame?.parent
  return parentFrame ? getFrameId(parentFrame) : -1
}

// TODO(mv3): fenced_frame getter API needed
const getFrameType = (frame: Electron.WebFrameMain) =>
  !frame.parent ? 'outermost_frame' : 'sub_frame'

// TODO(mv3): add WebFrameMain API to retrieve this
const getDocumentLifecycle = (frame: Electron.WebFrameMain): DocumentLifecycle => 'active' as const

const getFrameDetails = (
  frame: Electron.WebFrameMain,
  ctx?: { store: import('../store').ExtensionStore; tabId?: number },
): chrome.webNavigation.GetFrameResultDetails => {
  const fid = getFrameId(frame)
  const docId = ctx?.store?.getDocumentId(ctx.tabId ?? -1, fid)
  return {
    url: frame.url,
    documentId: docId || 'unknown',
    documentLifecycle: getDocumentLifecycle(frame),
    errorOccurred: false,
    frameType: getFrameType(frame),
    ...{
      frameId: fid,
    },
    parentDocumentId: undefined,
    parentFrameId: getParentFrameId(frame),
  }
}

export class WebNavigationAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webNavigation.getFrame', this.getFrame.bind(this))
    handle('webNavigation.getAllFrames', this.getAllFrames.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  private observeTab(tab: Electron.WebContents) {
    tab.once('will-navigate', this.onCreatedNavigationTarget.bind(this, tab))
    tab.on('did-start-navigation', this.onBeforeNavigate.bind(this, tab))
    tab.on('did-frame-finish-load', this.onFinishLoad.bind(this, tab))
    tab.on('did-frame-navigate', this.onCommitted.bind(this, tab))
    tab.on('did-navigate-in-page', this.onHistoryStateUpdated.bind(this, tab))

    tab.on('frame-created', (_e, { frame }) => {
      const isMain = withFrame(frame, (f) => f.top === f)
      if (!frame || isMain === null || isMain) return

      frame.on('dom-ready', () => {
        this.onDOMContentLoaded(tab, frame)
      })
    })

    // Main frame dom-ready event
    tab.on('dom-ready', () => {
      if ('mainFrame' in tab) {
        this.onDOMContentLoaded(tab, tab.mainFrame)
      }
    })
  }

  private getFrame(
    event: ExtensionEvent,
    details: chrome.webNavigation.GetFrameDetails,
  ): chrome.webNavigation.GetFrameResultDetails | null {
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab) return null

    let targetFrame: Electron.WebFrameMain | undefined

    if (typeof details.frameId === 'number') {
      const mainFrame = tab.mainFrame
      targetFrame = mainFrame.framesInSubtree.find((frame: any) => {
        const isMainFrame = frame === frame.top
        return isMainFrame ? details.frameId === 0 : details.frameId === frame.frameTreeNodeId
      })
    }

    return targetFrame ? getFrameDetails(targetFrame, { store: this.ctx.store, tabId: details.tabId }) : null
  }

  private getAllFrames(
    event: ExtensionEvent,
    details: chrome.webNavigation.GetFrameDetails,
  ): chrome.webNavigation.GetAllFrameResultDetails[] | null {
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab || !('mainFrame' in tab)) return []
    const ctx = { store: this.ctx.store, tabId: details.tabId }
    return (tab as any).mainFrame.framesInSubtree.map((f: Electron.WebFrameMain) => getFrameDetails(f, ctx))
  }

  private sendNavigationEvent = (eventName: string, details: { url: string }) => {
    d(`${eventName} [url: ${details.url}]`)
    this.ctx.router.broadcastEvent(`webNavigation.${eventName}`, details)
  }

  private onCreatedNavigationTarget = (
    tab: Electron.WebContents,
    { url, frame }: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
  ) => {
    if (tab.isDestroyed()) return
    const details = withFrame(frame, (f) => {
      const frameId = getFrameId(f)
      return {
        sourceTabId: tab.id,
        sourceProcessId: f.processId,
        sourceFrameId: frameId,
        url,
        tabId: tab.id,
        timeStamp: Date.now(),
      }
    })
    if (!details) return
    this.sendNavigationEvent('onCreatedNavigationTarget', details)
  }

  private onBeforeNavigate = (
    tab: Electron.WebContents,
    {
      url,
      isSameDocument,
      frame,
    }: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (tab.isDestroyed()) return
    if (isSameDocument) return

    const details = withFrame(frame, (f) => {
      const frameId = getFrameId(f)
      const documentId = this.ctx.store.newDocumentId(tab.id, frameId)
      return {
        documentId,
        frameId,
        frameType: getFrameType(f),
        documentLifecycle: getDocumentLifecycle(f),
        parentFrameId: getParentFrameId(f),
        processId: f.processId,
        tabId: tab.id,
        timeStamp: Date.now(),
        url,
      }
    })
    if (!details) return
    this.sendNavigationEvent('onBeforeNavigate', details)
  }

  private onCommitted = (
    tab: Electron.WebContents,
    _event: Electron.Event,
    url: string,
    _httpResponseCode: number,
    _httpStatusText: string,
    _isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => {
    if (tab.isDestroyed()) return
    const frame = getFrame(frameProcessId, frameRoutingId)
    const details = withFrame(frame ?? null, (f) => {
      const frameId = getFrameId(f)
      return {
        documentId: this.ctx.store.getDocumentId(tab.id, frameId) || this.ctx.store.newDocumentId(tab.id, frameId),
        frameId,
        parentFrameId: getParentFrameId(f),
        frameType: getFrameType(f),
        transitionType: '',
        transitionQualifiers: [] as string[],
        documentLifecycle: getDocumentLifecycle(f),
        processId: frameProcessId,
        tabId: tab.id,
        timeStamp: Date.now(),
        url,
      }
    })
    if (!details) return
    this.sendNavigationEvent('onCommitted', details)
  }

  private onHistoryStateUpdated = (
    tab: Electron.WebContents,
    event: Electron.Event,
    url: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => {
    if (tab.isDestroyed()) return
    const frame = getFrame(frameProcessId, frameRoutingId)
    const details = withFrame(frame ?? null, (f) => {
      const frameId = getFrameId(f)
      return {
        documentId: this.ctx.store.getDocumentId(tab.id, frameId) || this.ctx.store.newDocumentId(tab.id, frameId),
        transitionType: '',
        transitionQualifiers: [] as string[],
        frameId,
        parentFrameId: getParentFrameId(f),
        frameType: getFrameType(f),
        documentLifecycle: getDocumentLifecycle(f),
        processId: frameProcessId,
        tabId: tab.id,
        timeStamp: Date.now(),
        url,
      }
    })
    if (!details) return
    this.sendNavigationEvent('onHistoryStateUpdated', details)
  }

  private onDOMContentLoaded = (tab: Electron.WebContents, frame: Electron.WebFrameMain) => {
    if (tab.isDestroyed()) return
    const details = withFrame(frame, (f) => {
      const frameId = getFrameId(f)
      return {
        documentId: this.ctx.store.getDocumentId(tab.id, frameId) || this.ctx.store.newDocumentId(tab.id, frameId),
        frameId,
        parentFrameId: getParentFrameId(f),
        frameType: getFrameType(f),
        documentLifecycle: getDocumentLifecycle(f),
        processId: f.processId,
        tabId: tab.id,
        timeStamp: Date.now(),
        url: f.url,
      }
    })
    if (!details) return
    this.sendNavigationEvent('onDOMContentLoaded', details)

    if (!tab.isLoadingMainFrame()) {
      this.sendNavigationEvent('onCompleted', details)
    }
  }

  private onFinishLoad = (
    tab: Electron.WebContents,
    event: Electron.Event,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => {
    if (tab.isDestroyed()) return
    const frame = getFrame(frameProcessId, frameRoutingId)
    const details = withFrame(frame ?? null, (f) => {
      const frameId = getFrameId(f)
      const url = (typeof f.url === 'string' && f.url) || tab.getURL()
      return {
        documentId: this.ctx.store.getDocumentId(tab.id, frameId) || this.ctx.store.newDocumentId(tab.id, frameId),
        frameId,
        parentFrameId: getParentFrameId(f),
        frameType: getFrameType(f),
        documentLifecycle: getDocumentLifecycle(f),
        processId: frameProcessId,
        tabId: tab.id,
        timeStamp: Date.now(),
        url,
      }
    })
    if (!details) return
    this.sendNavigationEvent('onCompleted', details)
  }
}
