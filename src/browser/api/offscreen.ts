import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * chrome.offscreen
 *
 * An offscreen document is a hidden page under the extension's own origin. It
 * is a real page rather than a synthetic context, so it registers as a client
 * of the extension's service worker on its own: `clients.matchAll()`,
 * `client.postMessage()` and MessagePort transfer all work without bridging.
 *
 * Chrome allows one offscreen document per extension.
 */

export interface OffscreenDocumentInfo {
  url: string
  reasons: string[]
  justification?: string
}

export class OffscreenAPI {
  private documents = new Map<string, BrowserWindow>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('offscreen.createDocument', this.createDocument, { permission: 'offscreen' })
    handle('offscreen.closeDocument', this.closeDocument, { permission: 'offscreen' })
    handle('offscreen.hasDocument', this.hasDocument, { permission: 'offscreen' })
  }

  /** Offscreen documents, as runtime.getContexts() reports them. */
  getContexts(extensionId: string) {
    const win = this.documents.get(extensionId)
    if (!win || win.isDestroyed()) return []
    return [
      {
        contextType: 'OFFSCREEN_DOCUMENT',
        contextId: String(win.webContents.id),
        tabId: -1,
        windowId: -1,
        documentId: String(win.webContents.id),
        documentUrl: win.webContents.getURL(),
        documentOrigin: `chrome-extension://${extensionId}`,
        frameId: 0,
        incognito: false,
      },
    ]
  }

  private resolveUrl(extensionId: string, url: string) {
    const resolved = new URL(url, `chrome-extension://${extensionId}/`)
    if (resolved.protocol !== 'chrome-extension:' || resolved.hostname !== extensionId) {
      throw new Error('Offscreen documents must be an extension-relative URL')
    }
    return resolved.href
  }

  private createDocument = async (
    event: ExtensionEvent,
    parameters: { url: string; reasons?: string[]; justification?: string },
  ) => {
    const extensionId = event.extension.id

    const existing = this.documents.get(extensionId)
    if (existing && !existing.isDestroyed()) {
      // Chrome rejects a second document rather than replacing the first.
      throw new Error('Only a single offscreen document may be created')
    }

    const url = this.resolveUrl(extensionId, parameters?.url)

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

    this.documents.set(extensionId, win)
    win.once('closed', () => {
      if (this.documents.get(extensionId) === win) this.documents.delete(extensionId)
    })

    try {
      await win.webContents.loadURL(url)
    } catch (error) {
      this.documents.delete(extensionId)
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
  }

  private closeDocument = async (event: ExtensionEvent) => {
    const extensionId = event.extension.id
    const win = this.documents.get(extensionId)
    this.documents.delete(extensionId)
    if (!win || win.isDestroyed()) {
      throw new Error('No current offscreen document')
    }
    win.destroy()
  }

  private hasDocument = (event: ExtensionEvent) => {
    const win = this.documents.get(event.extension.id)
    return !!win && !win.isDestroyed()
  }

  /** Tear down every offscreen document, for session shutdown. */
  destroy() {
    for (const win of this.documents.values()) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.documents.clear()
  }
}
