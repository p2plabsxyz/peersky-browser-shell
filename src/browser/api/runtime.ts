import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'
import { NativeMessagingHost } from './lib/native-messaging-host'

const INSTALLED_STATE_NS = 'installed'

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
    handle('runtime.requestUpdateCheck', this.requestUpdateCheck)
    handle('extension.setUpdateUrlData', () => undefined)
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
      // Chrome calls the service worker the BACKGROUND context, with no
      // document fields.
      contexts.push({
        contextType: 'BACKGROUND',
        contextId: this.contextIdFor(`sw:${versionId}`),
        tabId: -1,
        windowId: -1,
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

  private contextIds = new Map<string, string>()

  /** Chrome's context ids are UUIDs that stay the same for the context's life. */
  private contextIdFor(key: string) {
    let id = this.contextIds.get(key)
    if (!id) {
      id = randomUUID()
      this.contextIds.set(key, id)
    }
    return id
  }

  /**
   * runtime.onInstalled and onStartup, as Chrome fires them: 'install' the
   * first time an extension loads, 'update' when its version changed since,
   * 'chrome_update' when the browser's did, and onStartup when it loads
   * unchanged in a new run of the app. What was seen is kept in the state
   * store, so a restart is told apart from an install.
   */
  async onExtensionLoaded(extension: Electron.Extension) {
    const { stateStore, router } = this.ctx
    await stateStore.whenHydrated()
    const seen = stateStore.getNamespace<Record<string, { version: string; browser: string }>>(
      INSTALLED_STATE_NS,
      {},
    )
    const version = getExtensionManifest(extension).version || '0'
    const browser = process.versions.chrome || ''
    const before = seen[extension.id]
    // 1.x kept no record of installs. On the first run after updating, an
    // extension that already stored data was installed before: Chrome would
    // call that a browser update, and a welcome page must not open again.
    // Decided once per run, before this run's first record is written.
    if (this.firstTracked === undefined) {
      this.firstTracked = !stateStore.getNamespace<unknown>(INSTALLED_STATE_NS, undefined as any)
    }
    const firstTracked = this.firstTracked
    let details: chrome.runtime.InstalledDetails | undefined
    if (!before) {
      const returning = firstTracked && (await this.hasStoredData(extension.id))
      details = { reason: (returning ? 'chrome_update' : 'install') as chrome.runtime.OnInstalledReason }
    } else if (before.version !== version) {
      details = { reason: 'update' as chrome.runtime.OnInstalledReason, previousVersion: before.version }
    } else if (before.browser !== browser) {
      details = { reason: 'chrome_update' as chrome.runtime.OnInstalledReason }
    }
    if (!before || before.version !== version || before.browser !== browser) {
      stateStore.setNamespace(INSTALLED_STATE_NS, { ...seen, [extension.id]: { version, browser } })
      await stateStore.flush().catch(() => {})
    }
    if (details) {
      router.sendEventWhenListening(extension.id, 'runtime.onInstalled', [details])
    } else if (!this.startedThisRun.has(extension.id)) {
      router.sendEventWhenListening(extension.id, 'runtime.onStartup', [])
    }
    this.startedThisRun.add(extension.id)
  }

  private startedThisRun = new Set<string>()
  private firstTracked?: boolean

  private async hasStoredData(extensionId: string) {
    const storagePath = (this.ctx.session as any).storagePath as string | null | undefined
    const candidates = [
      storagePath && path.join(storagePath, 'extension-local', `${extensionId}.json`),
      storagePath && path.join(storagePath, 'extension-sync', `${extensionId}.json`),
      storagePath && path.join(storagePath, 'Local Extension Settings', extensionId),
      storagePath && path.join(app.getPath('userData'), 'extension-local', `${extensionId}.json`),
      storagePath && path.join(app.getPath('userData'), 'extension-sync', `${extensionId}.json`),
    ].filter((c): c is string => !!c)
    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        return true
      } catch {}
    }
    return false
  }

  /** Updates come from the host, if at all; the shell itself never has one. */
  private requestUpdateCheck = () => ({ status: 'no_update', version: '' })

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
