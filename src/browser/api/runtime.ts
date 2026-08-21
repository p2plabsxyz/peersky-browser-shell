import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { BrowserWindow, webContents } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'
import { NativeMessagingHost } from './lib/native-messaging-host'

export class RuntimeAPI extends EventEmitter {
  private hostMap: Record<string, NativeMessagingHost | undefined> = {}

  constructor(
    private ctx: ExtensionContext,
    private offscreen?: { getContexts(extensionId: string): any[] },
  ) {
    super()

    const handle = this.ctx.router.apiHandler()
    handle('runtime.connectNative', this.connectNative, { permission: 'nativeMessaging' })
    handle('runtime.disconnectNative', this.disconnectNative, { permission: 'nativeMessaging' })
    handle('runtime.getContexts', this.getContexts)
    handle('runtime.openOptionsPage', this.openOptionsPage)
    handle('runtime.sendNativeMessage', this.sendNativeMessage, { permission: 'nativeMessaging' })
    handle('extension.getViews', this.getViews)
    handle('extension.isAllowedFileSchemeAccess', this.isAllowedFileSchemeAccess)
    handle('extension.isAllowedIncognitoAccess', this.isAllowedIncognitoAccess)
  }

  /**
   * chrome.runtime.getContexts — the extension's own live contexts.
   *
   * Covers the running service worker, extension pages, and any offscreen
   * document. Chrome also reports SIDE_PANEL, which has no counterpart here.
   */
  private getContexts = (event: ExtensionEvent, filter?: Record<string, any>) => {
    const extensionId = event.extension.id
    const contexts: any[] = []

    for (const [versionId, info] of Object.entries(
      this.ctx.session.serviceWorkers.getAllRunning(),
    )) {
      const scope = (info as any)?.scope
      if (!scope) continue
      try {
        if (new URL(scope).hostname !== extensionId) continue
      } catch {
        continue
      }
      contexts.push({
        contextType: 'SERVICE_WORKER',
        contextId: String(versionId),
        tabId: -1,
        windowId: -1,
        documentId: undefined,
        documentUrl: (info as any).scriptUrl,
        documentOrigin: `chrome-extension://${extensionId}`,
        frameId: -1,
        incognito: false,
      })
    }

    for (const view of this.getViews(event)) {
      contexts.push({
        contextType: view.type === 'popup' ? 'POPUP' : 'TAB',
        contextId: String(view.id),
        tabId: typeof (view as any).tabId === 'number' ? (view as any).tabId : -1,
        windowId: typeof view.windowId === 'number' ? view.windowId : -1,
        documentId: String(view.id),
        documentUrl: view.url,
        documentOrigin: `chrome-extension://${extensionId}`,
        frameId: 0,
        incognito: false,
      })
    }

    contexts.push(...(this.offscreen?.getContexts(extensionId) ?? []))

    if (!filter) return contexts

    const matches = (key: string, value: any) => {
      const wanted = filter[key]
      return !Array.isArray(wanted) || wanted.includes(value)
    }

    return contexts.filter(
      (context) =>
        matches('contextTypes', context.contextType) &&
        matches('contextIds', context.contextId) &&
        matches('documentIds', context.documentId) &&
        matches('documentUrls', context.documentUrl) &&
        matches('documentOrigins', context.documentOrigin) &&
        matches('tabIds', context.tabId) &&
        matches('windowIds', context.windowId) &&
        matches('frameIds', context.frameId) &&
        (typeof filter.incognito !== 'boolean' || filter.incognito === context.incognito),
    )
  }

  private isAllowedFileSchemeAccess = () => false
  private isAllowedIncognitoAccess = () => false

  private getViews = (
    event: ExtensionEvent,
    fetchProperties?: { type?: string; windowId?: number; tabId?: number },
  ) => {
    const extensionId = event.extension.id
    const manifest = getExtensionManifest(event.extension)
    const popupPath =
      (manifest.manifest_version === 3 ? manifest.action?.default_popup : manifest.browser_action?.default_popup) ||
      undefined
    const optionsPath = manifest.options_ui?.page || manifest.options_page || undefined

    const all = webContents.getAllWebContents().filter((wc) => {
      if (wc.isDestroyed() || wc.session !== this.ctx.session) return false
      const rawUrl = wc.getURL?.()
      if (!rawUrl || !rawUrl.startsWith('chrome-extension://')) return false
      try {
        const parsed = new URL(rawUrl)
        return parsed.hostname === extensionId
      } catch {
        return false
      }
    })

    const views = all
      .map((wc) => {
        const rawUrl = wc.getURL()
        const parsed = new URL(rawUrl)
        const relPath = parsed.pathname.replace(/^\//, '')
        const bw = BrowserWindow.fromWebContents(wc)
        const type: string =
          popupPath && relPath === popupPath
            ? 'popup'
            : optionsPath && relPath === optionsPath
              ? 'tab'
              : wc.getType() === 'backgroundPage'
                ? 'background'
                : 'tab'
        return {
          id: wc.id,
          type,
          windowId: bw?.id,
          // tabId is only meaningful for page views; popups/background are not a tab in Chrome.
          ...(type === 'tab' ? { tabId: wc.id } : {}),
          url: rawUrl,
        }
      })
      .filter((view) => {
        if (fetchProperties?.type && fetchProperties.type !== view.type) return false
        if (typeof fetchProperties?.windowId === 'number' && fetchProperties.windowId !== view.windowId)
          return false
        if (typeof fetchProperties?.tabId === 'number' && fetchProperties.tabId !== view.tabId) return false
        return true
      })
    return views
  }

  private connectNative = async (
    event: ExtensionEvent,
    connectionId: string,
    application: string,
  ) => {
    const host = new NativeMessagingHost(
      event.extension.id,
      event.sender!,
      connectionId,
      application,
    )
    this.hostMap[connectionId] = host
  }

  private disconnectNative = (event: ExtensionEvent, connectionId: string) => {
    this.hostMap[connectionId]?.destroy()
    this.hostMap[connectionId] = undefined
  }

  private sendNativeMessage = async (event: ExtensionEvent, application: string, message: any) => {
    const connectionId = randomUUID()
    const host = new NativeMessagingHost(
      event.extension.id,
      event.sender!,
      connectionId,
      application,
      false,
    )
    await host.ready
    return await host.sendAndReceive(message)
  }

  private openOptionsPage = async ({ extension }: ExtensionEvent) => {
    // TODO: options page shouldn't appear in Tabs API
    // https://developer.chrome.com/extensions/options#tabs-api

    const manifest = getExtensionManifest(extension)

    if (manifest.options_ui) {
      // Embedded option not support (!options_ui.open_in_new_tab)
      const url = `chrome-extension://${extension.id}/${manifest.options_ui.page}`
      await this.ctx.store.createTab({ url, active: true })
    } else if (manifest.options_page) {
      const url = `chrome-extension://${extension.id}/${manifest.options_page}`
      await this.ctx.store.createTab({ url, active: true })
    }
  }
}
