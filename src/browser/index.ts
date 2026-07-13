import { app, session as electronSession } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { BrowserActionAPI } from './api/browser-action'
import { DebuggerAPI } from './api/debugger'
import { TabsAPI } from './api/tabs'
import { WindowsAPI } from './api/windows'
import { WebNavigationAPI } from './api/web-navigation'
import { ExtensionStore } from './store'
import { StorageSyncAPI } from './api/storage-sync'
import { IdentityAPI } from './api/identity'
import { ContextMenusAPI } from './api/context-menus'
import { ManagementAPI } from './api/management'
import { RuntimeAPI } from './api/runtime'
import { WebRequestAPI } from './api/web-request'
import { DeclarativeNetRequestAPI } from './api/declarative-net-request'
import { CookiesAPI } from './api/cookies'
import { NotificationsAPI } from './api/notifications'
import { ChromeExtensionImpl } from './impl'
import { CommandsAPI } from './api/commands'
import { ExtensionContext } from './context'
import { ExtensionRouter } from './router'
import { checkLicense, License } from './license'
import { readLoadedExtensionManifest } from './manifest'
import { PermissionsAPI } from './api/permissions'
import { ProxyAPI } from './api/proxy'
import { ScriptingAPI } from './api/scripting'
import { resolvePartition } from './partition'
import { ExtensionStateStore } from './state-store'
import { AlarmsAPI } from './api/alarms'
import { DownloadsAPI } from './api/downloads'

function checkVersion() {
  const electronVersion = process.versions.electron
  if (electronVersion && parseInt(electronVersion.split('.')[0], 10) < 35) {
    console.warn('electron-chrome-extensions requires electron@>=35.0.0')
  }
}

/** Align with server lists that use bare hostnames (FQDN dot, case, IPv6 brackets). */
function normalizeProxyAuthHost(host: string): string {
  if (host == null || typeof host !== 'string') return host
  let h = host.trim().toLowerCase()
  while (h.endsWith('.')) h = h.slice(0, -1)
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  return h
}

function resolvePreloadPath(modulePath?: string) {
  // Attempt to resolve preload path from module exports
  try {
    return createRequire(__dirname).resolve('@p2plabs/peersky-chrome-extensions/preload')
  } catch {
    // Backward compatibility for older package names.
    try {
      return createRequire(__dirname).resolve('peersky-chrome-extensions/preload')
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(error)
      }
    }
  }

  const preloadFilename = 'chrome-extension-api.preload.js'

  // Deprecated: use modulePath if provided
  if (modulePath) {
    process.emitWarning(
      'electron-chrome-extensions: "modulePath" is deprecated and will be removed in future versions.',
      { type: 'DeprecationWarning' },
    )
    return path.join(modulePath, 'dist', preloadFilename)
  }

  // Fallback to preload relative to entrypoint directory (dist/cjs/ -> dist/)
  return path.join(__dirname, '..', preloadFilename)
}

export interface ChromeExtensionOptions extends ChromeExtensionImpl {
  /**
   * License used to distribute electron-chrome-extensions.
   *
   * See LICENSE.md for more details.
   */
  license: License

  /**
   * Session to add Chrome extension support in.
   * Defaults to `session.defaultSession`.
   */
  session?: Electron.Session

  /**
   * Path to electron-chrome-extensions module files. Might be needed if
   * JavaScript bundlers like Webpack are used in your build process.
   *
   * @deprecated See "Packaging the preload script" in the readme.
   */
  modulePath?: string
}

const sessionMap = new WeakMap<Electron.Session, ElectronChromeExtensions>()

/**
 * Provides an implementation of various Chrome extension APIs to a session.
 */
export class ElectronChromeExtensions extends EventEmitter {
  /** Retrieve an instance of this class associated with the given session. */
  static fromSession(session: Electron.Session) {
    return sessionMap.get(session)
  }

  /**
   * Handles the 'crx://' protocol in the session.
   *
   * This is required to display <browser-action-list> extension icons.
   */
  static handleCRXProtocol(session: Electron.Session) {
    if (session.protocol.isProtocolHandled('crx')) {
      session.protocol.unhandle('crx')
    }
    session.protocol.handle('crx', function handleCRXRequest(request) {
      let url
      try {
        url = new URL(request.url)
      } catch {
        return new Response('Invalid URL', { status: 404 })
      }

      const partition = url?.searchParams.get('partition') || '_self'
      const remoteSession = partition === '_self' ? session : resolvePartition(partition)
      const extensions = ElectronChromeExtensions.fromSession(remoteSession)
      if (!extensions) {
        return new Response(`ElectronChromeExtensions not found for "${partition}"`, {
          status: 404,
        })
      }

      return extensions.api.browserAction.handleCRXRequest(request)
    })
  }

  private ctx: ExtensionContext

  api: {
    browserAction: BrowserActionAPI
    contextMenus: ContextMenusAPI
    management: ManagementAPI
    declarativeNetRequest: DeclarativeNetRequestAPI
    webRequest: WebRequestAPI
    commands: CommandsAPI
    cookies: CookiesAPI
    debugger: DebuggerAPI
    identity: IdentityAPI
    notifications: NotificationsAPI
    permissions: PermissionsAPI
    proxy: ProxyAPI
    runtime: RuntimeAPI
    alarms: AlarmsAPI
    downloads: DownloadsAPI
    scripting: ScriptingAPI
    storageSync: StorageSyncAPI
    tabs: TabsAPI
    webNavigation: WebNavigationAPI
    windows: WindowsAPI
  }

  constructor(opts: ChromeExtensionOptions) {
    super()

    const { license, session = electronSession.defaultSession, ...impl } = opts || {}

    checkVersion()
    checkLicense(license)

    if (sessionMap.has(session)) {
      throw new Error(`Extensions instance already exists for the given session`)
    }

    sessionMap.set(session, this)

    const router = new ExtensionRouter(session)
    const store = new ExtensionStore(impl)
    const stateStore = new ExtensionStateStore(session)

    this.ctx = {
      emit: this.emit.bind(this),
      router,
      session,
      store,
      stateStore,
    }
    void stateStore.hydrate().catch((error) => {
      console.error('Failed to hydrate extension API state store:', error)
    })

    const declarativeNetRequest = new DeclarativeNetRequestAPI(this.ctx)
    this.api = {
      browserAction: new BrowserActionAPI(this.ctx),
      contextMenus: new ContextMenusAPI(this.ctx),
      management: new ManagementAPI(this.ctx),
      declarativeNetRequest,
      webRequest: new WebRequestAPI(this.ctx, declarativeNetRequest),
      commands: new CommandsAPI(this.ctx),
      cookies: new CookiesAPI(this.ctx),
      debugger: new DebuggerAPI(this.ctx),
      identity: new IdentityAPI(this.ctx),
      notifications: new NotificationsAPI(this.ctx),
      permissions: new PermissionsAPI(this.ctx),
      proxy: new ProxyAPI(this.ctx),
      runtime: new RuntimeAPI(this.ctx),
      alarms: new AlarmsAPI(this.ctx),
      downloads: new DownloadsAPI(this.ctx),
      scripting: new ScriptingAPI(this.ctx),
      storageSync: new StorageSyncAPI(this.ctx),
      tabs: new TabsAPI(this.ctx),
      webNavigation: new WebNavigationAPI(this.ctx),
      windows: new WindowsAPI(this.ctx),
    }

    this.listenForExtensions()
    this.listenForAuthRequired()
    this.prependPreload(opts.modulePath)
  }

  private listenForAuthRequired() {
    app.on(
      'login',
      async (event, webContents, authenticationResponseDetails, authInfo, callback) => {
        // Wrong session: let Chromium handle it. If webContents is null, still run so
        // proxy auth can reach webRequest (extension listeners).
        if (webContents && webContents.session !== this.ctx.session) return

      event.preventDefault()

        try {
          const result = await this.api.webRequest.notifyOnAuthRequired({
            id: (authenticationResponseDetails as any)?.id,
            url: authenticationResponseDetails.url,
            method: (authenticationResponseDetails as any)?.method,
            webContentsId: webContents?.id,
            timestamp: Date.now(),
            isProxy: authInfo.isProxy,
            scheme: authInfo.scheme,
            realm: authInfo.realm,
            challenger: {
              host: normalizeProxyAuthHost(authInfo.host),
              port: authInfo.port,
            },
          })

        if (result.cancel) {
          callback()
          return
        }

          const credentials = result.authCredentials
          if (
            credentials != null &&
            (credentials.username != null || credentials.password != null)
          ) {
            callback(credentials.username ?? '', credentials.password ?? '')
            return
          }
        } catch {}

        callback()
      },
    )
  }

  private listenForExtensions() {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.addListener('extension-loaded', (_event, extension) => {
      readLoadedExtensionManifest(this.ctx, extension)

      // Start MV3 background service workers so extensions can
      // initialize themselves (enable DNR rulesets, set up event
      // listeners, bootstrap configuration, etc.). PCE's router
      // holds a reference to the worker to prevent termination.
      this.startExtensionServiceWorker(extension)
    })

    // Also start service workers for any extensions already loaded.
    const getAll = (sessionExtensions as any).getAllExtensions
    if (typeof getAll === 'function') {
      const list = getAll.call(sessionExtensions) || []
      for (const ext of list) {
        this.startExtensionServiceWorker(ext)
      }
    }
    sessionExtensions.addListener('extension-unloaded', () => {
      void this.ctx.stateStore.flush().catch((error) => {
        console.error('Failed to flush extension API state store:', error)
      })
    })
    app.once('before-quit', () => {
      void this.ctx.stateStore.flush().catch((error) => {
        console.error('Failed to flush extension API state store during shutdown:', error)
      })
    })
  }

  /**
   * Start the MV3 background service worker for an extension if it has one.
   */
  private startExtensionServiceWorker(extension: Electron.Extension) {
    const manifest = extension.manifest as chrome.runtime.Manifest
    // MV3 extensions use "background.service_worker" (a string).
    // Narrow the union type to access service_worker.
    const bg = manifest.background
    if (!bg || !('service_worker' in bg)) return
    const swPath = bg.service_worker
    if (!swPath) return

    const scope = `chrome-extension://${extension.id}/`
    this.ctx.session.serviceWorkers.startWorkerForScope(scope).catch((err) => {
      console.error(`Failed to start service worker for ${extension.id} (${extension.name}):`, err)
    })
  }

  private async prependPreload(modulePath?: string) {
    const { session } = this.ctx

    const preloadPath = resolvePreloadPath(modulePath)

    if ('registerPreloadScript' in session) {
      session.registerPreloadScript({
        id: 'crx-mv2-preload',
        type: 'frame',
        filePath: preloadPath,
      })
      session.registerPreloadScript({
        id: 'crx-mv3-preload',
        type: 'service-worker',
        filePath: preloadPath,
      })
    } else {
      // @ts-expect-error Deprecated electron@<35
      session.setPreloads([...session.getPreloads(), preloadPath])
    }

    if (!existsSync(preloadPath)) {
      console.error(
        new Error(
          `electron-chrome-extensions: Preload file not found at "${preloadPath}". ` +
            'See "Packaging the preload script" in the readme.',
        ),
      )
    }
  }

  private checkWebContentsArgument(wc: Electron.WebContents) {
    if (this.ctx.session !== wc.session) {
      throw new TypeError(
        'Invalid WebContents argument. Its session must match the session provided to ElectronChromeExtensions constructor options.',
      )
    }
  }

  /** Add webContents to be tracked as a tab. */
  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    this.checkWebContentsArgument(tab)
    this.ctx.store.addTab(tab, window)
  }

  /** Remove webContents from being tracked as a tab. */
  removeTab(tab: Electron.WebContents) {
    this.checkWebContentsArgument(tab)
    this.ctx.store.removeTab(tab)
  }

  /** Notify extension system that the active tab has changed. */
  selectTab(tab: Electron.WebContents) {
    this.checkWebContentsArgument(tab)
    if (this.ctx.store.tabs.has(tab)) {
      this.api.tabs.onActivated(tab.id)
    }
  }

  /**
   * Add webContents to be tracked as an extension host which will receive
   * extension events when a chrome-extension:// resource is loaded.
   *
   * This is usually reserved for extension background pages and popups, but
   * can also be used in other special cases.
   *
   * @deprecated Extension hosts are now tracked lazily when they send
   * extension IPCs to the main process.
   */
  addExtensionHost(host: Electron.WebContents) {
    console.warn('ElectronChromeExtensions.addExtensionHost() is deprecated')
  }

  /**
   * Get collection of menu items managed by the `chrome.contextMenus` API.
   * @see https://developer.chrome.com/extensions/contextMenus
   */
  getContextMenuItems(webContents: Electron.WebContents, params: Electron.ContextMenuParams) {
    this.checkWebContentsArgument(webContents)
    return this.api.contextMenus.buildMenuItemsForParams(webContents, params)
  }

  /** webRequest.onBeforeRequest bridge. */
  notifyWebRequestOnBeforeRequest(
    details: Electron.OnBeforeRequestListenerDetails,
  ): Promise<{ cancel?: boolean; redirectUrl?: string }> {
    return this.api.webRequest.notifyOnBeforeRequest(details)
  }

  /** webRequest.onBeforeSendHeaders bridge. */
  notifyWebRequestOnBeforeSendHeaders(
    details: Electron.OnBeforeSendHeadersListenerDetails,
  ): Promise<{ requestHeaders?: Record<string, string | string[]> }> {
    return this.api.webRequest.notifyOnBeforeSendHeaders(details)
  }

  /** webRequest.onSendHeaders bridge. */
  notifyWebRequestOnSendHeaders(details: Electron.OnSendHeadersListenerDetails): Promise<void> {
    return this.api.webRequest.notifyOnSendHeaders(details)
  }

  /** webRequest.onHeadersReceived bridge. */
  notifyWebRequestOnHeadersReceived(
    details: Electron.OnHeadersReceivedListenerDetails,
  ): Promise<{ responseHeaders?: Record<string, string | string[]> }> {
    return this.api.webRequest.notifyOnHeadersReceived(details)
  }

  /** webRequest.onResponseStarted bridge. */
  notifyWebRequestOnResponseStarted(
    details: Electron.OnResponseStartedListenerDetails,
  ): Promise<void> {
    return this.api.webRequest.notifyOnResponseStarted(details)
  }

  /** webRequest.onCompleted bridge. */
  notifyWebRequestOnCompleted(details: Electron.OnCompletedListenerDetails): Promise<void> {
    return this.api.webRequest.notifyOnCompleted(details)
  }

  /** webRequest.onErrorOccurred bridge. */
  notifyWebRequestOnErrorOccurred(
    details: Electron.OnErrorOccurredListenerDetails,
  ): Promise<void> {
    return this.api.webRequest.notifyOnErrorOccurred(details)
  }

  /**
   * Gets map of special pages to extension override URLs.
   *
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides
   */
  getURLOverrides(): Record<string, string> {
    return this.ctx.store.urlOverrides
  }

  /**
   * Handles the 'crx://' protocol in the session.
   *
   * @deprecated Call `ElectronChromeExtensions.handleCRXProtocol(session)`
   * instead. The CRX protocol is no longer one-to-one with
   * ElectronChromeExtensions instances. Instead, it should now be handled only
   * on the sessions where <browser-action-list> extension icons will be shown.
   */
  handleCRXProtocol(session: Electron.Session) {
    throw new Error(
      'extensions.handleCRXProtocol(session) is deprecated, call ElectronChromeExtensions.handleCRXProtocol(session) instead.',
    )
  }

  /**
   * Add extensions to be visible as an extension action button.
   *
   * @deprecated Not needed in Electron >=12.
   */
  addExtension(extension: Electron.Extension) {
    console.warn('ElectronChromeExtensions.addExtension() is deprecated')
    this.api.browserAction.processExtension(extension)
  }

  /**
   * Remove extensions from the list of visible extension action buttons.
   *
   * @deprecated Not needed in Electron >=12.
   */
  removeExtension(extension: Electron.Extension) {
    console.warn('ElectronChromeExtensions.removeExtension() is deprecated')
    this.api.browserAction.removeActions(extension.id)
  }
}
