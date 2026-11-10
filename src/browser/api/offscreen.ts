import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { chromeTypeName } from './alarms'

/**
 * chrome.offscreen
 *
 * An offscreen document is a hidden page under the extension's own origin. It
 * is a real page rather than a synthetic context, so it registers as a client
 * of the extension's service worker on its own: `clients.matchAll()`,
 * `client.postMessage()` and MessagePort transfer all work without bridging.
 *
 * Chrome allows one offscreen document per extension, and gives it only
 * chrome.runtime.
 */

export interface OffscreenDocumentInfo {
  url: string
  reasons: string[]
  justification?: string
}

const REASONS = [
  'AUDIO_PLAYBACK',
  'BATTERY_STATUS',
  'BLOBS',
  'CLIPBOARD',
  'DISPLAY_MEDIA',
  'DOM_PARSER',
  'DOM_SCRAPING',
  'GEOLOCATION',
  'IFRAME_SCRIPTING',
  'LOCAL_STORAGE',
  'MATCH_MEDIA',
  'TESTING',
  'USER_MEDIA',
  'WEB_RTC',
  'WORKERS',
]

const SIGNATURE =
  'offscreen.createDocument(offscreen.CreateParameters parameters, optional function callback)'

const invocationError = (detail: string) => new Error(`Error in invocation of ${SIGNATURE}: ${detail}`)

/**
 * The web contents of every offscreen document in the app, across sessions.
 * The preload asks, while a page loads, whether it is one, since Chrome gives
 * an offscreen document a smaller chrome object than other extension pages.
 */
const offscreenContents = new Set<number>()
let contextInfoHandler = false
const listenForContextInfo = () => {
  if (contextInfoHandler) return
  contextInfoHandler = true
  ipcMain.on('crx-context-info', (event) => {
    const isMainFrame = event.senderFrame === event.sender.mainFrame
    event.returnValue = { offscreen: isMainFrame && offscreenContents.has(event.sender.id) }
  })
}

interface OffscreenDocument {
  win: BrowserWindow
  contextId: string
  documentId: string
  reasons: string[]
  justification: string
}

export class OffscreenAPI {
  private documents = new Map<string, OffscreenDocument>()

  constructor(private ctx: ExtensionContext) {
    listenForContextInfo()
    const handle = this.ctx.router.apiHandler()
    handle('offscreen.createDocument', this.createDocument, { permission: 'offscreen' })
    handle('offscreen.closeDocument', this.closeDocument, { permission: 'offscreen' })
    handle('offscreen.hasDocument', this.hasDocument, { permission: 'offscreen' })

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.closeFor(extension.id)
    })
  }

  /** Whether these web contents are an offscreen document. */
  isOffscreenDocument(webContents: Electron.WebContents) {
    return offscreenContents.has(webContents.id)
  }

  /** Offscreen documents, as runtime.getContexts() reports them. */
  getContexts(extensionId: string) {
    const doc = this.documents.get(extensionId)
    if (!doc || doc.win.isDestroyed()) return []
    return [
      {
        contextType: 'OFFSCREEN_DOCUMENT',
        contextId: doc.contextId,
        tabId: -1,
        windowId: -1,
        documentId: doc.documentId,
        documentUrl: doc.win.webContents.getURL(),
        documentOrigin: `chrome-extension://${extensionId}`,
        frameId: 0,
        incognito: false,
      },
    ]
  }

  private closeFor(extensionId: string) {
    const doc = this.documents.get(extensionId)
    this.documents.delete(extensionId)
    if (doc && !doc.win.isDestroyed()) doc.win.destroy()
  }

  /** Checks the arguments as Chrome's bindings do, with their messages. */
  private readParameters(parameters: unknown) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      throw invocationError('No matching signature.')
    }
    const p = parameters as Record<string, unknown>
    const at = (detail: string) => invocationError(`Error at parameter 'parameters': ${detail}`)
    // In the schema's order, as Chrome checks them.
    if (p.reasons === undefined) throw at("Missing required property 'reasons'.")
    if (!Array.isArray(p.reasons)) {
      throw at(`Error at property 'reasons': Invalid type: expected array, found ${chromeTypeName(p.reasons)}.`)
    }
    p.reasons.forEach((reason, i) => {
      if (typeof reason !== 'string' || !REASONS.includes(reason)) {
        throw at(`Error at property 'reasons': Error at index ${i}: Value must be one of ${REASONS.join(', ')}.`)
      }
    })
    for (const key of ['url', 'justification']) {
      if (p[key] === undefined) throw at(`Missing required property '${key}'.`)
      if (typeof p[key] !== 'string') {
        throw at(`Error at property '${key}': Invalid type: expected string, found ${chromeTypeName(p[key])}.`)
      }
    }
    return {
      url: p.url as string,
      reasons: [...new Set(p.reasons as string[])],
      justification: (p.justification as string).slice(0, 1000),
    }
  }

  private resolveUrl(extensionId: string, url: string) {
    let resolved: URL
    try {
      resolved = new URL(url, `chrome-extension://${extensionId}/`)
    } catch {
      throw new Error('Invalid URL.')
    }
    if (resolved.protocol !== 'chrome-extension:' || resolved.hostname !== extensionId) {
      throw new Error('Invalid URL.')
    }
    return resolved.href
  }

  private createDocument = async (event: ExtensionEvent, parameters: unknown) => {
    const extensionId = event.extension.id
    const { url, reasons, justification } = this.readParameters(parameters)
    if (reasons.length === 0) throw new Error('A `reason` must be provided.')
    const href = this.resolveUrl(extensionId, url)

    const existing = this.documents.get(extensionId)
    if (existing && !existing.win.isDestroyed()) {
      // Chrome rejects a second document rather than replacing the first.
      throw new Error('Only a single offscreen document may be created.')
    }

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: this.ctx.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        // A hidden window is throttled by default, which would stall whatever
        // the document was created to run.
        backgroundThrottling: false,
      },
    })
    const id = win.webContents.id
    // Known before the page's preload asks.
    offscreenContents.add(id)
    win.webContents.once('destroyed', () => offscreenContents.delete(id))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const doc: OffscreenDocument = {
      win,
      contextId: randomUUID(),
      documentId: randomUUID().replace(/-/g, '').toUpperCase(),
      reasons,
      justification,
    }
    this.documents.set(extensionId, doc)
    win.once('closed', () => {
      if (this.documents.get(extensionId) === doc) this.documents.delete(extensionId)
    })

    try {
      await win.webContents.loadURL(href)
    } catch {
      if (this.documents.get(extensionId) === doc) this.documents.delete(extensionId)
      if (!win.isDestroyed()) win.destroy()
      throw new Error('Page failed to load.')
    }
  }

  private closeDocument = async (event: ExtensionEvent) => {
    const doc = this.documents.get(event.extension.id)
    if (!doc || doc.win.isDestroyed()) {
      this.documents.delete(event.extension.id)
      throw new Error('No current offscreen document.')
    }
    this.closeFor(event.extension.id)
  }

  private hasDocument = (event: ExtensionEvent) => {
    const doc = this.documents.get(event.extension.id)
    return !!doc && !doc.win.isDestroyed()
  }

  /** Tear down every offscreen document, for session shutdown. */
  destroy() {
    for (const doc of this.documents.values()) {
      if (!doc.win.isDestroyed()) doc.win.destroy()
    }
    this.documents.clear()
  }
}
