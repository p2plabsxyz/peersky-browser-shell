import { webContents as allWebContents } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const GET_ID_SIGNATURE =
  'tabCapture.getMediaStreamId(optional tabCapture.GetMediaStreamOptions options, optional function callback)'
const CAPTURE_SIGNATURE =
  'tabCapture.capture(tabCapture.CaptureOptions options, function callback)'

const GRANT_ERROR =
  'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'

// A stream id works for this long once given out (Electron's limit for
// getMediaSourceId). An id not used in time is forgotten.
const ID_LIFETIME_MS = 10_000
const POLL_MS = 500

type Status = 'pending' | 'active' | 'stopped' | 'error'

interface Capture {
  extensionId: string
  tab: Electron.WebContents
  status: Status
  fullscreen: boolean
  issued: number
  /** The stream has been seen running. */
  used: boolean
  cleanup: () => void
}

const typeName = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

/** Chrome's checks of getMediaStreamId's options, with its messages. */
export function validateStreamOptions(options: unknown): { targetTabId?: number; consumerTabId?: number } {
  const fail = (detail: string) => new Error(`Error in invocation of ${GET_ID_SIGNATURE}: ${detail}`)
  if (options == null) return {}
  if (typeof options !== 'object' || Array.isArray(options)) throw fail('No matching signature.')
  const out: { targetTabId?: number; consumerTabId?: number } = {}
  for (const key of ['consumerTabId', 'targetTabId'] as const) {
    const value = (options as any)[key]
    if (value == null) continue
    if (!Number.isInteger(value)) {
      throw fail(
        `Error at parameter 'options': Error at property '${key}': Invalid type: expected integer, found ${typeName(value)}.`,
      )
    }
    out[key] = value
  }
  for (const key of Object.keys(options)) {
    if (key !== 'consumerTabId' && key !== 'targetTabId') {
      throw fail(`Error at parameter 'options': Unexpected property: '${key}'.`)
    }
  }
  return out
}

/**
 * chrome.tabCapture: a stream of a tab the person invoked the extension on.
 * getMediaStreamId gives an id for getUserMedia (chromeMediaSource 'tab');
 * getCapturedTabs and onStatusChanged follow the streams made from those ids.
 */
export class TabCaptureAPI {
  private captures = new Map<number, Capture>()
  private timer?: NodeJS.Timeout

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('tabCapture.getMediaStreamId', this.getMediaStreamId)
    handle('tabCapture.getCapturedTabs', this.getCapturedTabs)
    handle('tabCapture.capture', this.capture)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      for (const [tabId, capture] of this.captures) {
        if (capture.extensionId === extension.id) this.end(tabId, capture, undefined)
      }
    })
  }

  /** Only web pages, and the extension's own, can be captured; never the browser's own pages. */
  private capturable(extension: Electron.Extension, url: string) {
    try {
      const parsed = new URL(url)
      if (['http:', 'https:', 'file:'].includes(parsed.protocol)) return true
      return parsed.protocol === 'chrome-extension:' && parsed.hostname === extension.id
    } catch {
      return false
    }
  }

  /** The tab Chrome captures when none is named: the active tab of the caller's window. */
  private activeTabFor(event: ExtensionEvent) {
    const store = this.ctx.store
    if (event.type === 'frame') {
      const sender = event.sender
      if (store.tabs.has(sender)) return sender
      const win = store.tabToWindow.get(sender) || (sender as any).getOwnerBrowserWindow?.()
      const parent = win?.getParentWindow?.() || win
      const active = parent && store.getActiveTabFromWindow(parent)
      if (active) return active
    }
    const win = store.getCurrentWindowForExtension(event.extension.id)
    return win ? store.getActiveTabFromWindow(win) : undefined
  }

  /**
   * The page that will call getUserMedia with the id. Electron ties an id to
   * one page: the consumer tab when named, else the calling page, else (for a
   * service worker) the extension's newest page, which is its offscreen
   * document when it has just made one for this.
   */
  private consumerFor(event: ExtensionEvent, consumerTabId?: number) {
    if (typeof consumerTabId === 'number') {
      const tab = this.ctx.store.getTabById(consumerTabId)
      if (!tab) throw new Error('Invalid tab specified.')
      return tab
    }
    if (event.type === 'frame') return event.sender
    const origin = `chrome-extension://${event.extension.id}/`
    const pages = allWebContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && wc.session === this.ctx.session && wc.getURL().startsWith(origin))
      .sort((a, b) => b.id - a.id)
    if (!pages[0]) throw new Error('Invalid origin specified.')
    return pages[0]
  }

  private checkGrant(extension: Electron.Extension, target: Electron.WebContents) {
    if (!this.capturable(extension, target.getURL()) || !this.ctx.permissions.mayCaptureTab(extension, target.id)) {
      throw new Error(GRANT_ERROR)
    }
  }

  private issue(event: ExtensionEvent, target: Electron.WebContents, consumer: Electron.WebContents) {
    const { extension } = event
    const tabId = target.id
    const existing = this.captures.get(target.id)
    if (existing && (existing.used || Date.now() - existing.issued < ID_LIFETIME_MS)) {
      throw new Error('Cannot capture a tab with an active stream.')
    }
    if (existing) this.end(target.id, existing, undefined)

    const id = target.getMediaSourceId(consumer)
    if (!id) throw new Error('Error finding tab to capture.')

    const onDestroyed = () => {
      const capture = this.captures.get(tabId)
      if (capture) this.end(tabId, capture, capture.used ? 'stopped' : undefined)
    }
    const onFullscreen = (fullscreen: boolean) => () => {
      const capture = this.captures.get(tabId)
      if (!capture || capture.fullscreen === fullscreen) return
      capture.fullscreen = fullscreen
      if (capture.used) this.notify(tabId, capture)
    }
    const enter = onFullscreen(true)
    const leave = onFullscreen(false)
    target.once('destroyed', onDestroyed)
    target.on('enter-html-full-screen', enter)
    target.on('leave-html-full-screen', leave)
    this.captures.set(tabId, {
      extensionId: extension.id,
      tab: target,
      status: 'pending',
      fullscreen: false,
      issued: Date.now(),
      used: false,
      cleanup: () => {
        target.removeListener('destroyed', onDestroyed)
        target.removeListener('enter-html-full-screen', enter)
        target.removeListener('leave-html-full-screen', leave)
      },
    })
    this.poll()
    return id
  }

  private getMediaStreamId = (event: ExtensionEvent, options?: unknown) => {
    const { targetTabId, consumerTabId } = validateStreamOptions(options)
    let target: Electron.WebContents | undefined
    if (typeof targetTabId === 'number') {
      target = this.ctx.store.getTabById(targetTabId)
      if (!target) throw new Error('Invalid tab specified.')
    } else {
      target = this.activeTabFor(event)
      if (!target) throw new Error('Error finding tab to capture.')
    }
    this.checkGrant(event.extension, target)
    return this.issue(event, target, this.consumerFor(event, consumerTabId))
  }

  /** capture() in an extension page: the renderer turns the id into a MediaStream. */
  private capture = (event: ExtensionEvent, options: unknown) => {
    const fail = (detail: string) => new Error(`Error in invocation of ${CAPTURE_SIGNATURE}: ${detail}`)
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('No matching signature.')
    const { audio, video } = options as { audio?: unknown; video?: unknown }
    if (event.type !== 'frame') throw new Error('Error finding tab to capture.')
    if (audio !== true && video !== true) throw new Error('Capture failed. No audio or video requested.')
    const target = this.activeTabFor(event)
    if (!target) throw new Error('Error finding tab to capture.')
    this.checkGrant(event.extension, target)
    return this.issue(event, target, event.sender)
  }

  private getCapturedTabs = ({ extension }: ExtensionEvent) => {
    const out: chrome.tabCapture.CaptureInfo[] = []
    for (const [tabId, capture] of this.captures) {
      if (capture.extensionId !== extension.id || !capture.used) continue
      if (capture.status !== 'pending' && capture.status !== 'active') continue
      out.push({ tabId, status: capture.status as any, fullscreen: capture.fullscreen })
    }
    return out
  }

  private notify(tabId: number, capture: Capture) {
    this.ctx.router.sendEvent(capture.extensionId, 'tabCapture.onStatusChanged', {
      tabId,
      status: capture.status,
      fullscreen: capture.fullscreen,
    })
  }

  private end(tabId: number, capture: Capture, status: Status | undefined) {
    if (this.captures.get(tabId) !== capture) return
    this.captures.delete(tabId)
    capture.cleanup()
    if (status && capture.used) {
      capture.status = status
      this.notify(tabId, capture)
    }
  }

  /**
   * Electron says when a page is being captured, not which stream does it, so
   * a tab with an id out is watched until its stream starts and then until it
   * stops. Chrome reports pending, then active, then stopped.
   */
  private poll() {
    if (this.timer) return
    this.timer = setInterval(() => {
      for (const [tabId, capture] of this.captures) {
        const tab = capture.tab
        if (tab.isDestroyed()) {
          this.end(tabId, capture, 'stopped')
          continue
        }
        const captured = tab.isBeingCaptured()
        if (!capture.used) {
          if (captured) {
            capture.used = true
            this.notify(tabId, capture)
            capture.status = 'active'
            this.notify(tabId, capture)
          } else if (Date.now() - capture.issued > ID_LIFETIME_MS) {
            this.end(tabId, capture, undefined)
          }
        } else if (!captured) {
          this.end(tabId, capture, 'stopped')
        }
      }
      if (this.captures.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }, POLL_MS)
    this.timer.unref?.()
  }
}
