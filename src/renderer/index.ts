import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener } from './event'

export const injectExtensionAPIs = () => {
  interface ExtensionMessageOptions {
    noop?: boolean
    defaultResponse?: any
    serialize?: (...args: any[]) => any[]
  }

  const invokeExtension = async function (
    extensionId: string,
    fnName: string,
    options: ExtensionMessageOptions = {},
    ...args: any[]
  ) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, args)
    }

    if (options.noop) {
      console.warn(`${fnName} is not yet implemented.`)
      if (callback) callback(options.defaultResponse)
      return Promise.resolve(options.defaultResponse)
    }

    if (options.serialize) {
      args = options.serialize(...args)
    }

    let result
    // Callback-style Chrome APIs only set runtime.lastError when something failed;
    // on success the property is absent / undefined (not null).
    let lastError: { message: string } | undefined

    try {
      result = await ipcRenderer.invoke('crx-msg', extensionId, fnName, ...args)
    } catch (e) {
      console.error(e)
      result = undefined
      lastError = {
        message: e instanceof Error ? e.message : String(e),
      }
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, '(result)', result)
    }

    const chromeAny = (globalThis as any).chrome
    const rt = chromeAny?.runtime
    if (callback) {
      try {
        if (rt) {
          if (lastError) rt.lastError = lastError
          else delete rt.lastError
        }
        callback(result)
      } finally {
        if (rt) delete rt.lastError
      }
      return
    }

    if (rt) delete rt.lastError
    return result
  }

  type ConnectNativeCallback = (connectionId: string, send: (message: any) => void) => void
  const connectNative = (
    extensionId: string,
    application: string,
    receive: (message: any) => void,
    disconnect: () => void,
    callback: ConnectNativeCallback,
  ) => {
    const connectionId = (contextBridge as any).executeInMainWorld({
      func: () => crypto.randomUUID(),
    })
    invokeExtension(extensionId, 'runtime.connectNative', {}, connectionId, application)
    const onMessage = (_event: Electron.IpcRendererEvent, message: any) => {
      receive(message)
    }
    ipcRenderer.on(`crx-native-msg-${connectionId}`, onMessage)
    ipcRenderer.once(`crx-native-msg-${connectionId}-disconnect`, () => {
      ipcRenderer.off(`crx-native-msg-${connectionId}`, onMessage)
      disconnect()
    })
    const send = (message: any) => {
      ipcRenderer.send(`crx-native-msg-${connectionId}`, message)
    }
    callback(connectionId, send)
  }

  const disconnectNative = (extensionId: string, connectionId: string) => {
    invokeExtension(extensionId, 'runtime.disconnectNative', {}, connectionId)
  }

  const electronContext = {
    invokeExtension,
    addExtensionListener,
    removeExtensionListener,
    connectNative,
    disconnectNative,
  }

  // Function body to run in the main world.
  // IMPORTANT: This must be self-contained, no closure variable will be included!
  function mainWorldScript() {
    // Use context bridge API or closure variable when context isolation is disabled.
    const electron = ((globalThis as any).electron as typeof electronContext) || electronContext

    const chrome: any = (globalThis as any).chrome || {}
    const extensionId = chrome.runtime?.id

    // `no-cache` still revalidates; 304 has no body and Electron MV3 SW can surface
    // an empty body. Treat as no-store so responses include full entity bytes.
    try {
      const g = globalThis as any
      const nativeFetch = g.fetch?.bind(g)
      if (typeof nativeFetch === 'function' && g.fetch !== undefined) {
        g.fetch = function (input: any, init?: RequestInit) {
          if (init && init.cache === 'no-cache') {
            return nativeFetch(input, { ...init, cache: 'no-store' })
          }
          if (typeof Request !== 'undefined' && input instanceof Request) {
            if (input.cache === 'no-cache' && (init === undefined || init.cache === undefined)) {
              return nativeFetch(new Request(input, { cache: 'no-store' }), init)
            }
          }
          return nativeFetch(input, init)
        }
      }
    } catch {
      /* ignore */
    }

    // NOTE: This uses a synchronous IPC to get the extension manifest.
    // To avoid this, JS bindings for RendererExtensionRegistry would be
    // required.
    // OFFSCREEN_DOCUMENT contexts do not have this function defined.
    const manifest: chrome.runtime.Manifest =
      (extensionId && chrome.runtime.getManifest?.()) || ({} as any)

    const invokeExtension =
      (fnName: string, opts: ExtensionMessageOptions = {}) =>
        (...args: any[]) =>
          electron.invokeExtension(extensionId, fnName, opts, ...args)

    function imageData2base64(imageData: ImageData) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null

      canvas.width = imageData.width
      canvas.height = imageData.height
      ctx.putImageData(imageData, 0, 0)

      return canvas.toDataURL()
    }

    class ExtensionEvent<T extends Function> implements chrome.events.Event<T> {
      private listeners = new Set<T>()

      constructor(private name: string) {}

      addListener(callback: T) {
        if (this.listeners.has(callback)) return
        this.listeners.add(callback)
        electron.addExtensionListener(extensionId, this.name, callback)
      }
      removeListener(callback: T) {
        if (!this.listeners.delete(callback)) return
        electron.removeExtensionListener(extensionId, this.name, callback)
      }

      getRules(callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: string[], callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: any, callback?: any) {
        throw new Error('Method not implemented.')
      }
      hasListener(callback: T): boolean {
        return this.listeners.has(callback)
      }
      removeRules(ruleIdentifiers?: string[] | undefined, callback?: (() => void) | undefined): void
      removeRules(callback?: (() => void) | undefined): void
      removeRules(ruleIdentifiers?: any, callback?: any) {
        throw new Error('Method not implemented.')
      }
      addRules(
        rules: chrome.events.Rule[],
        callback?: ((rules: chrome.events.Rule[]) => void) | undefined,
      ): void {
        throw new Error('Method not implemented.')
      }
      hasListeners(): boolean {
        return this.listeners.size > 0
      }
    }

    // chrome.types.ChromeSetting<any>
    class ChromeSetting {
      private value: any = undefined

      get(_details?: any, cb?: Function) {
        const result = {
          value: this.value,
          levelOfControl: 'controllable_by_this_extension' as const,
        }
        if (typeof cb === 'function') cb(result)
        return result
      }

      set(details?: any, cb?: Function) {
        if (details && typeof details === 'object' && 'value' in details) {
          this.value = details.value
        }
        if (typeof cb === 'function') cb()
      }

      clear(_details?: any, cb?: Function) {
        this.value = undefined
        if (typeof cb === 'function') cb()
      }

      onChange = {
        addListener: () => {},
        removeListener: () => {},
        hasListener: () => false,
      }
    }

    class Event<T extends Function> implements Partial<chrome.events.Event<T>> {
      private listeners: T[] = []

      _emit(...args: any[]) {
        this.listeners.forEach((listener) => {
          listener(...args)
        })
      }

      addListener(callback: T): void {
        this.listeners.push(callback)
      }
      removeListener(callback: T): void {
        const index = this.listeners.indexOf(callback)
        if (index > -1) {
          this.listeners.splice(index, 1)
        }
      }
    }

    class NativePort implements chrome.runtime.Port {
      private connectionId: string = ''
      private connected = false
      private pending: any[] = []

      name: string = ''

      _init = (connectionId: string, send: (message: any) => void) => {
        this.connected = true
        this.connectionId = connectionId
        this._send = send

        this.pending.forEach((msg) => this.postMessage(msg))
        this.pending = []

        Object.defineProperty(this, '_init', { value: undefined })
      }

      _send(message: any) {
        this.pending.push(message)
      }

      _receive(message: any) {
        ;(this.onMessage as any)._emit(message)
      }

      _disconnect() {
        this.disconnect()
      }

      postMessage(message: any) {
        this._send(message)
      }
      disconnect() {
        if (this.connected) {
          electron.disconnectNative(extensionId, this.connectionId)
          ;(this.onDisconnect as any)._emit()
          this.connected = false
        }
      }
      onMessage: chrome.runtime.PortMessageEvent = new Event() as any
      onDisconnect: chrome.runtime.PortDisconnectEvent = new Event() as any
    }

    type DeepPartial<T> = {
      [P in keyof T]?: DeepPartial<T[P]>
    }

    type APIFactoryMap = {
      [apiName in keyof typeof chrome]: {
        shouldInject?: () => boolean
        factory: (
          base: DeepPartial<(typeof chrome)[apiName]>,
        ) => DeepPartial<(typeof chrome)[apiName]>
      }
    }

    const browserActionFactory = (base: DeepPartial<typeof globalThis.chrome.browserAction>) => {
      const api = {
        ...base,

        setTitle: invokeExtension('browserAction.setTitle'),
        getTitle: invokeExtension('browserAction.getTitle'),

        setIcon: invokeExtension('browserAction.setIcon', {
          serialize: (details: chrome.action.TabIconDetails) => {
            if (details.imageData) {
              if (manifest.manifest_version === 3) {
                // TODO(mv3): might need to use offscreen document to serialize
                console.warn(
                  'action.setIcon with imageData is not yet supported by electron-chrome-extensions',
                )
                details.imageData = undefined
              } else if (details.imageData instanceof ImageData) {
                details.imageData = imageData2base64(details.imageData) as any
              } else {
                details.imageData = Object.entries(details.imageData).reduce(
                  (obj: any, pair: any[]) => {
                    obj[pair[0]] = imageData2base64(pair[1])
                    return obj
                  },
                  {},
                )
              }
            }

            return [details]
          },
        }),

        setPopup: invokeExtension('browserAction.setPopup'),
        getPopup: invokeExtension('browserAction.getPopup'),

        setBadgeText: invokeExtension('browserAction.setBadgeText'),
        getBadgeText: invokeExtension('browserAction.getBadgeText'),

        setBadgeBackgroundColor: invokeExtension('browserAction.setBadgeBackgroundColor'),
        getBadgeBackgroundColor: invokeExtension('browserAction.getBadgeBackgroundColor'),

        getUserSettings: invokeExtension('browserAction.getUserSettings'),

        enable: invokeExtension('browserAction.enable', { noop: true }),
        disable: invokeExtension('browserAction.disable', { noop: true }),

        openPopup: invokeExtension('browserAction.openPopup'),

        onClicked: new ExtensionEvent('browserAction.onClicked'),
      }

      return api
    }

    /**
     * Factories for each additional chrome.* API.
     */
    const apiDefinitions: any = {
      action: {
        shouldInject: () => manifest.manifest_version === 3 && !!manifest.action,
        factory: browserActionFactory,
      },

      browserAction: {
        shouldInject: () => manifest.manifest_version === 2 && !!manifest.browser_action,
        factory: browserActionFactory,
      },

      alarms: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('alarms'),
        factory: (base) => {
          return {
            ...base,
            create: invokeExtension('alarms.create'),
            get: invokeExtension('alarms.get'),
            getAll: invokeExtension('alarms.getAll'),
            clear: invokeExtension('alarms.clear'),
            clearAll: invokeExtension('alarms.clearAll'),
            onAlarm: new ExtensionEvent('alarms.onAlarm'),
          }
        },
      },

      commands: {
        factory: (base) => {
          return {
            ...base,
            getAll: invokeExtension('commands.getAll'),
            onCommand: new ExtensionEvent('commands.onCommand'),
          }
        },
      },

      debugger: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('debugger'),
        factory: (base) => {
          return {
            ...base,
            attach: invokeExtension('debugger.attach'),
            detach: invokeExtension('debugger.detach'),
            getTargets: invokeExtension('debugger.getTargets'),
            sendCommand: invokeExtension('debugger.sendCommand'),
            onDetach: new ExtensionEvent('debugger.onDetach'),
            onEvent: new ExtensionEvent('debugger.onEvent'),
          }
        },
      },

      contextMenus: {
        factory: (base) => {
          let menuCounter = 0
          const menuCallbacks: {
            [key: string]: chrome.contextMenus.CreateProperties['onclick']
          } = {}
          const menuCreate = invokeExtension('contextMenus.create')

          let hasInternalListener = false
          const addInternalListener = () => {
            api.onClicked.addListener((info, tab) => {
              const callback = menuCallbacks[info.menuItemId]
              if (callback && tab) callback(info, tab)
            })
            hasInternalListener = true
          }

          const api = {
            ...base,
            create: function (
              createProperties: chrome.contextMenus.CreateProperties,
              callback?: Function,
            ) {
              if (typeof createProperties.id === 'undefined') {
                createProperties.id = `${++menuCounter}`
              }
              if (createProperties.onclick) {
                if (!hasInternalListener) addInternalListener()
                menuCallbacks[createProperties.id] = createProperties.onclick
                delete createProperties.onclick
              }
              menuCreate(createProperties, callback)
              return createProperties.id
            },
            update: invokeExtension('contextMenus.update'),
            remove: invokeExtension('contextMenus.remove'),
            removeAll: invokeExtension('contextMenus.removeAll'),
            onClicked: new ExtensionEvent<
              (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
            >('contextMenus.onClicked'),
          }

          return api
        },
      },

      cookies: {
        factory: (base) => {
          return {
            ...base,
            get: invokeExtension('cookies.get'),
            getAll: invokeExtension('cookies.getAll'),
            set: invokeExtension('cookies.set'),
            remove: invokeExtension('cookies.remove'),
            getAllCookieStores: invokeExtension('cookies.getAllCookieStores'),
            onChanged: new ExtensionEvent('cookies.onChanged'),
          }
        },
      },

      declarativeNetRequest: {
        factory: (base) => {
          return {
            ...base,
            getDynamicRules: invokeExtension('declarativeNetRequest.getDynamicRules'),
            updateDynamicRules: invokeExtension('declarativeNetRequest.updateDynamicRules'),
            getSessionRules: invokeExtension('declarativeNetRequest.getSessionRules'),
            updateSessionRules: invokeExtension('declarativeNetRequest.updateSessionRules'),
            getEnabledRulesets: invokeExtension('declarativeNetRequest.getEnabledRulesets'),
            updateEnabledRulesets: invokeExtension('declarativeNetRequest.updateEnabledRulesets'),
            updateStaticRules: invokeExtension('declarativeNetRequest.updateStaticRules'),
            isRegexSupported: invokeExtension('declarativeNetRequest.isRegexSupported'),
            getMatchedRules: invokeExtension('declarativeNetRequest.getMatchedRules'),
          }
        },
      },

      // TODO: implement
      downloads: {
        factory: (base) => {
          return {
            ...base,
            acceptDanger: invokeExtension('downloads.acceptDanger'),
            cancel: invokeExtension('downloads.cancel'),
            download: invokeExtension('downloads.download'),
            erase: invokeExtension('downloads.erase'),
            getFileIcon: invokeExtension('downloads.getFileIcon'),
            open: invokeExtension('downloads.open'),
            pause: invokeExtension('downloads.pause'),
            removeFile: invokeExtension('downloads.removeFile'),
            resume: invokeExtension('downloads.resume'),
            search: invokeExtension('downloads.search'),
            setUiOptions: invokeExtension('downloads.setUiOptions'),
            show: invokeExtension('downloads.show'),
            showDefaultFolder: invokeExtension('downloads.showDefaultFolder'),
            onChanged: new ExtensionEvent('downloads.onChanged'),
            onCreated: new ExtensionEvent('downloads.onCreated'),
            onDeterminingFilename: new ExtensionEvent('downloads.onDeterminingFilename'),
            onErased: new ExtensionEvent('downloads.onErased'),
          }
        },
      },

      extension: {
        factory: (base) => {
          const ipcGetViews = invokeExtension('extension.getViews')
          const resolveViews = async (fetchProperties?: {
            type?: string
            windowId?: number
            tabId?: number
          }) => {
            let views = ((await ipcGetViews(fetchProperties)) || []) as Array<
              Record<string, unknown>
            >
            // Same shape as IPC (id, type, windowId, tabId, url). Never mix in DOM Window
            // references — extensions that need the live window can't get it cross-process anyway.
            if (fetchProperties?.type === 'popup') {
              try {
                const href =
                  typeof location !== 'undefined' ? String(location.href || '') : ''
                if (href.startsWith('chrome-extension://')) {
                  const idx = views.findIndex((v) => typeof v.url === 'string' && v.url === href)
                  if (idx >= 0) {
                    views = views.slice()
                    views[idx] = { ...views[idx], self: true }
                  } else {
                    views = [
                      ...views,
                      {
                        type: 'popup',
                        url: href,
                        self: true,
                      },
                    ]
                  }
                }
              } catch {
                /* ignore */
              }
            }
            return views
          }
          return {
            ...base,
            isAllowedFileSchemeAccess: invokeExtension('extension.isAllowedFileSchemeAccess'),
            isAllowedIncognitoAccess: invokeExtension('extension.isAllowedIncognitoAccess'),
            getViews: (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const fetchProperties =
                args.length > 0 && args[0] && typeof args[0] === 'object' ? args[0] : undefined
              const result = resolveViews(fetchProperties)
              if (callback) {
                result.then(callback).catch(() => callback([]))
                return
              }
              return result
            },
          }
        },
      },

      identity: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('identity'),
        factory: (base) => {
          const redirectDomain = 'chromiumapp.org'
          const redirectBase = extensionId
            ? `https://${extensionId}.${redirectDomain}/`
            : ''
          return {
            ...base,
            getRedirectURL: (path?: string) =>
              path ? redirectBase + path.replace(/^\//, '') : redirectBase,
            launchWebAuthFlow: invokeExtension('identity.launchWebAuthFlow'),
            getAuthToken: invokeExtension('identity.getAuthToken'),
          }
        },
      },

      management: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('management'),
        factory: (base) => ({
          ...base,
          getSelf: invokeExtension('management.getSelf'),
          getAll: invokeExtension('management.getAll'),
          get: invokeExtension('management.get'),
        }),
      },

      i18n: {
        shouldInject: () => manifest.manifest_version === 3,
        factory: (base) => {
          // Electron configuration prevented this API from being available.
          // https://github.com/electron/electron/pull/45031
          if (base.getMessage) {
            return base
          }

          return {
            ...base,
            getUILanguage: () => 'en-US',
            getAcceptLanguages: (callback: any) => {
              const results = ['en-US']
              if (callback) {
                queueMicrotask(() => callback(results))
              }
              return Promise.resolve(results)
            },
            getMessage: (messageName: string) => messageName,
          }
        },
      },

      notifications: {
        factory: (base) => {
          return {
            ...base,
            clear: invokeExtension('notifications.clear'),
            create: invokeExtension('notifications.create'),
            getAll: invokeExtension('notifications.getAll'),
            getPermissionLevel: invokeExtension('notifications.getPermissionLevel'),
            update: invokeExtension('notifications.update'),
            onClicked: new ExtensionEvent('notifications.onClicked'),
            onButtonClicked: new ExtensionEvent('notifications.onButtonClicked'),
            onClosed: new ExtensionEvent('notifications.onClosed'),
          }
        },
      },

      permissions: {
        factory: (base) => {
          return {
            ...base,
            contains: invokeExtension('permissions.contains'),
            getAll: invokeExtension('permissions.getAll'),
            remove: invokeExtension('permissions.remove'),
            request: invokeExtension('permissions.request'),
            onAdded: new ExtensionEvent('permissions.onAdded'),
            onRemoved: new ExtensionEvent('permissions.onRemoved'),
          }
        },
      },

      privacy: {
        factory: (base) => {
          return {
            ...base,
            network: {
              networkPredictionEnabled: new ChromeSetting(),
              webRTCIPHandlingPolicy: new ChromeSetting(),
            },
            services: {
              autofillAddressEnabled: new ChromeSetting(),
              autofillCreditCardEnabled: new ChromeSetting(),
              passwordSavingEnabled: new ChromeSetting(),
            },
            websites: {
              hyperlinkAuditingEnabled: new ChromeSetting(),
            },
          }
        },
      },

      proxy: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('proxy'),
        factory: (base) => {
          return {
            ...base,
            settings: {
              get: invokeExtension('proxy.settings.get'),
              set: invokeExtension('proxy.settings.set'),
              clear: invokeExtension('proxy.settings.clear'),
              onChange: new ExtensionEvent('proxy.settings.onChange'),
            },
            onProxyError: new ExtensionEvent('proxy.onProxyError'),
          }
        },
      },

      scripting: {
        shouldInject: () =>
          manifest.manifest_version === 3 ||
          !!(manifest.permissions as string[] | undefined)?.includes('scripting'),
        factory: (base) => {
          const ipcExecuteScript = invokeExtension('scripting.executeScript')
          return {
            ...base,
            insertCSS: invokeExtension('scripting.insertCSS'),
            executeScript: (injection: any) => {
              if (injection && typeof injection.func === 'function') {
                injection = { ...injection, func: String(injection.func) }
              }
              return ipcExecuteScript(injection)
            },
            registerContentScripts: invokeExtension('scripting.registerContentScripts'),
            getRegisteredContentScripts: invokeExtension('scripting.getRegisteredContentScripts'),
            unregisterContentScripts: invokeExtension('scripting.unregisterContentScripts'),
            updateContentScripts: invokeExtension('scripting.updateContentScripts'),
          }
        },
      },

      runtime: {
        factory: (base) => {
          const patched: any = {}
          // Copy ALL own properties from the native chrome.runtime object,
          // including non-enumerable ones (connect, sendMessage, onConnect,
          // onMessage, etc.) that the spread operator would silently drop.
          if (base) {
            for (const key of Object.getOwnPropertyNames(base)) {
              try {
                patched[key] = (base as any)[key]
              } catch (_) { /* skip inaccessible */ }
            }
          }
          patched.connectNative = (application: string) => {
            const port = new NativePort()
            const receive = port._receive.bind(port)
            const disconnect = port._disconnect.bind(port)
            const callback: ConnectNativeCallback = (connectionId, send) => {
              port._init(connectionId, send)
            }
            electron.connectNative(extensionId, application, receive, disconnect, callback)
            return port
          }
          patched.openOptionsPage = invokeExtension('runtime.openOptionsPage')
          patched.sendNativeMessage = invokeExtension('runtime.sendNativeMessage')
          return patched
        },
      },

      storage: {
        factory: (base) => {
          const customOnChanged = new ExtensionEvent('storage.onChanged')
          const originalAddListener = base?.onChanged?.addListener?.bind(base.onChanged)
          const originalRemoveListener = base?.onChanged?.removeListener?.bind(base.onChanged)

          const addListener = (cb: any) => {
            if (originalAddListener) {
              try {
                originalAddListener(cb)
              } catch {
                // Some Electron contexts expose a partial native storage event that can throw.
                // We still want our IPC-backed listener to be registered.
              }
            }
            customOnChanged.addListener(cb)
          }
          const removeListener = (cb: any) => {
            if (originalRemoveListener) {
              try {
                originalRemoveListener(cb)
              } catch {
                // Ignore and continue removing from the IPC-backed listener set.
              }
            }
            customOnChanged.removeListener(cb)
          }
          const hasListener = (cb: any) => {
            return customOnChanged.hasListener(cb) || (base?.onChanged?.hasListener?.(cb) ?? false)
          }
          const hasListeners = () =>
            customOnChanged.hasListeners() || (base?.onChanged?.hasListeners?.() ?? false)

          const onChanged = { addListener, removeListener, hasListener, hasListeners }

          const cbWrap = (fn: (...a: any[]) => Promise<any>) =>
            (...args: any[]) => {
              const last = args[args.length - 1]
              if (typeof last === 'function') {
                const cb = args.pop()
                fn(...args).then(cb).catch(() => cb(undefined))
                return
              }
              return fn(...args)
            }

          /** storage.get must never pass undefined to callbacks (extensions index nested prefs). */
          const cbWrapStorageGet = (fn: (...a: any[]) => Promise<any>) =>
            (...args: any[]) => {
              const last = args[args.length - 1]
              if (typeof last === 'function') {
                const cb = args.pop()
                fn(...args)
                  .then((r) => cb(r != null && typeof r === 'object' ? r : {}))
                  .catch(() => cb({}))
                return
              }
              return fn(...args).then((r) => (r != null && typeof r === 'object' ? r : {}))
            }

          // Per-area onChanged is required by real extensions (e.g. Dark Reader uses
          // chrome.storage.local.onChanged). It aliases the same listeners as
          // chrome.storage.onChanged; the event payload includes the storage area.
          const ipcLocal = {
            get: cbWrapStorageGet(invokeExtension('storage.local.get')),
            set: cbWrap(invokeExtension('storage.local.set')),
            remove: cbWrap(invokeExtension('storage.local.remove')),
            clear: cbWrap(invokeExtension('storage.local.clear')),
            getBytesInUse: cbWrap(invokeExtension('storage.local.getBytesInUse')),
            onChanged,
            QUOTA_BYTES: 10485760,
          }

          const ipcManaged = {
            get: cbWrapStorageGet(invokeExtension('storage.managed.get')),
            onChanged: {
              addListener: () => {},
              removeListener: () => {},
              hasListener: () => false,
              hasListeners: () => false,
            },
          }

          return {
            ...base,
            onChanged,
            local: ipcLocal,
            managed: ipcManaged,
            session: (base as any)?.session || ipcLocal,
            sync: {
              ...(base as any)?.sync ?? ipcLocal,
              onChanged,
              get: cbWrapStorageGet(invokeExtension('storage.sync.get')),
              set: cbWrap(invokeExtension('storage.sync.set')),
              remove: cbWrap(invokeExtension('storage.sync.remove')),
              clear: cbWrap(invokeExtension('storage.sync.clear')),
              getBytesInUse: cbWrap(invokeExtension('storage.sync.getBytesInUse')),
            },
          }
        },
      },

      tabs: {
        factory: (base) => {
          const api = {
            ...base,
            create: invokeExtension('tabs.create'),
            executeScript: async function (
              arg1: unknown,
              arg2: unknown,
              arg3: unknown,
            ): Promise<any> {
              // Electron's implementation of chrome.tabs.executeScript is in
              // C++, but it doesn't support implicit execution in the active
              // tab. To handle this, we need to get the active tab ID and
              // pass it into the C++ implementation ourselves.
              if (typeof arg1 === 'object') {
                const [activeTab] = await api.query({
                  active: true,
                  windowId: chrome.windows.WINDOW_ID_CURRENT,
                })
                return api.executeScript(activeTab.id, arg1, arg2)
              } else {
                return (base.executeScript as typeof chrome.tabs.executeScript)(
                  arg1 as number,
                  arg2 as chrome.tabs.InjectDetails,
                  arg3 as () => {},
                )
              }
            },
            get: invokeExtension('tabs.get'),
            getCurrent: invokeExtension('tabs.getCurrent'),
            getAllInWindow: invokeExtension('tabs.getAllInWindow'),
            captureVisibleTab: invokeExtension('tabs.captureVisibleTab'),
            insertCSS: invokeExtension('tabs.insertCSS'),
            query: invokeExtension('tabs.query'),
            reload: invokeExtension('tabs.reload'),
            update: invokeExtension('tabs.update'),
            remove: invokeExtension('tabs.remove'),
            move: invokeExtension('tabs.move'),
            highlight: invokeExtension('tabs.highlight'),
            goBack: invokeExtension('tabs.goBack'),
            goForward: invokeExtension('tabs.goForward'),
            duplicate: invokeExtension('tabs.duplicate'),
            getZoom: invokeExtension('tabs.getZoom'),
            setZoom: invokeExtension('tabs.setZoom'),
            getZoomSettings: invokeExtension('tabs.getZoomSettings'),
            setZoomSettings: invokeExtension('tabs.setZoomSettings'),
            onCreated: new ExtensionEvent('tabs.onCreated'),
            onRemoved: new ExtensionEvent('tabs.onRemoved'),
            onUpdated: new ExtensionEvent('tabs.onUpdated'),
            onActivated: new ExtensionEvent('tabs.onActivated'),
            onReplaced: new ExtensionEvent('tabs.onReplaced'),
            onZoomChange: new ExtensionEvent('tabs.onZoomChange'),
            onMoved: new ExtensionEvent('tabs.onMoved'),
            onHighlighted: new ExtensionEvent('tabs.onHighlighted'),
          }
          return api
        },
      },

      topSites: {
        factory: () => {
          return {
            get: invokeExtension('topSites.get', { noop: true, defaultResponse: [] }),
          }
        },
      },

      webNavigation: {
        shouldInject: () =>
          !!(manifest.permissions as string[] | undefined)?.includes('webNavigation'),
        factory: (base) => {
          return {
            ...base,
            getFrame: invokeExtension('webNavigation.getFrame'),
            getAllFrames: invokeExtension('webNavigation.getAllFrames'),
            onBeforeNavigate: new ExtensionEvent('webNavigation.onBeforeNavigate'),
            onCommitted: new ExtensionEvent('webNavigation.onCommitted'),
            onCompleted: new ExtensionEvent('webNavigation.onCompleted'),
            onCreatedNavigationTarget: new ExtensionEvent(
              'webNavigation.onCreatedNavigationTarget',
            ),
            onDOMContentLoaded: new ExtensionEvent('webNavigation.onDOMContentLoaded'),
            onErrorOccurred: new ExtensionEvent('webNavigation.onErrorOccurred'),
            onHistoryStateUpdated: new ExtensionEvent('webNavigation.onHistoryStateUpdated'),
            onReferenceFragmentUpdated: new ExtensionEvent(
              'webNavigation.onReferenceFragmentUpdated',
            ),
            onTabReplaced: new ExtensionEvent('webNavigation.onTabReplaced'),
          }
        },
      },

      webRequest: {
        factory: (base) => {
          const onBeforeRequestEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebRequestBodyDetails) =>
              | void
              | { cancel?: boolean; redirectUrl?: string }
          >('webRequest.onBeforeRequest')
          const onBeforeRequestWrapperMap = new Map<
            (
              details: chrome.webRequest.WebRequestBodyDetails,
            ) => void | { cancel?: boolean; redirectUrl?: string },
            (details: chrome.webRequest.WebRequestBodyDetails) => void
          >()

          const onBeforeSendHeadersEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebRequestHeadersDetails) => void | { requestHeaders?: any }
          >('webRequest.onBeforeSendHeaders')
          const onBeforeSendHeadersWrapperMap = new Map<
            (details: chrome.webRequest.WebRequestHeadersDetails) => void | { requestHeaders?: any },
            (details: chrome.webRequest.WebRequestHeadersDetails) => void
          >()

          const onHeadersReceivedEvent = new ExtensionEvent<
            (
              details: chrome.webRequest.WebResponseHeadersDetails,
            ) => void | { responseHeaders?: any }
          >('webRequest.onHeadersReceived')
          const onHeadersReceivedWrapperMap = new Map<
            (details: chrome.webRequest.WebResponseHeadersDetails) => void | { responseHeaders?: any },
            (details: chrome.webRequest.WebResponseHeadersDetails) => void
          >()

          const onSendHeadersEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebRequestHeadersDetails) => void
          >('webRequest.onSendHeaders')

          const onBeforeRedirectEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebRedirectionResponseDetails) => void
          >('webRequest.onBeforeRedirect')

          const onResponseStartedEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebResponseCacheDetails) => void
          >('webRequest.onResponseStarted')

          const onCompletedEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebResponseCacheDetails) => void
          >('webRequest.onCompleted')

          const onErrorOccurredEvent = new ExtensionEvent<
            (details: chrome.webRequest.WebResponseErrorDetails) => void
          >('webRequest.onErrorOccurred')

          const onAuthRequiredEvent = new ExtensionEvent<
            (
              details: chrome.webRequest.WebAuthenticationChallengeDetails,
              asyncCallback?: (response?: chrome.webRequest.BlockingResponse) => void,
            ) => void | chrome.webRequest.BlockingResponse
          >('webRequest.onAuthRequired')
          const onAuthRequiredWrapperMap = new Map<
            (
              details: chrome.webRequest.WebAuthenticationChallengeDetails,
              asyncCallback?: (response?: chrome.webRequest.BlockingResponse) => void,
            ) => void | chrome.webRequest.BlockingResponse,
            (details: chrome.webRequest.WebAuthenticationChallengeDetails) => void
          >()

          return {
            ...base,
            onBeforeRequest: {
              addListener(
                callback: (
                  details: chrome.webRequest.WebRequestBodyDetails,
                ) => void | { cancel?: boolean; redirectUrl?: string },
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                const existing = onBeforeRequestWrapperMap.get(callback)
                if (existing) return

                invokeExtension('webRequest.addOnBeforeRequestListener')(filter, extraInfoSpec)

                const wrapper = (details: chrome.webRequest.WebRequestBodyDetails) => {
                  const reqId = details && (details as any).requestId
                  const listenerId = details && (details as any).listenerId
                  Promise.resolve()
                    .then(() => callback(details))
                    .then((result) => {
                      if (reqId != null && listenerId != null) {
                        invokeExtension('webRequest.onBeforeRequest.response')(
                          reqId,
                          listenerId,
                          result || undefined,
                        ).catch(() => {})
                      }
                    })
                    .catch(() => {
                      if (reqId != null && listenerId != null) {
                        invokeExtension('webRequest.onBeforeRequest.response')(
                          reqId,
                          listenerId,
                          undefined,
                        ).catch(() => {})
                      }
                    })
                }

                onBeforeRequestWrapperMap.set(callback, wrapper)
                onBeforeRequestEvent.addListener(wrapper)
              },
              removeListener(
                callback: (
                  details: chrome.webRequest.WebRequestBodyDetails,
                ) => void | { cancel?: boolean; redirectUrl?: string },
              ) {
                const wrapper = onBeforeRequestWrapperMap.get(callback)
                if (wrapper) {
                  onBeforeRequestEvent.removeListener(wrapper)
                  onBeforeRequestWrapperMap.delete(callback)
                  if (!onBeforeRequestEvent.hasListeners()) {
                    invokeExtension('webRequest.removeOnBeforeRequestListener')().catch(() => {})
                  }
                } else {
                  onBeforeRequestEvent.removeListener(callback as any)
                }
              },
              hasListener(
                callback: (
                  details: chrome.webRequest.WebRequestBodyDetails,
                ) => void | { cancel?: boolean; redirectUrl?: string },
              ) {
                return onBeforeRequestEvent.hasListener(
                  onBeforeRequestWrapperMap.get(callback) || (callback as any),
                )
              },
              hasListeners() {
                return onBeforeRequestEvent.hasListeners()
              },
            },
            onBeforeSendHeaders: {
              addListener(
                callback: (
                  details: chrome.webRequest.WebRequestHeadersDetails,
                ) => void | { requestHeaders?: any },
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                const existing = onBeforeSendHeadersWrapperMap.get(callback)
                if (existing) return

                invokeExtension('webRequest.addOnBeforeSendHeadersListener')(filter, extraInfoSpec)

                const wrapper = (details: chrome.webRequest.WebRequestHeadersDetails) => {
                  const reqId = details && (details as any).requestId
                  const listenerId = details && (details as any).listenerId
                  Promise.resolve()
                    .then(() => callback(details))
                    .then((result) => {
                      if (reqId != null && listenerId != null) {
                        invokeExtension('webRequest.onBeforeSendHeaders.response')(
                          reqId,
                          listenerId,
                          result || undefined,
                        ).catch(() => {})
                      }
                    })
                    .catch(() => {
                      if (reqId != null && listenerId != null) {
                        invokeExtension('webRequest.onBeforeSendHeaders.response')(
                          reqId,
                          listenerId,
                          undefined,
                        ).catch(() => {})
                      }
                    })
                }

                onBeforeSendHeadersWrapperMap.set(callback, wrapper)
                onBeforeSendHeadersEvent.addListener(wrapper)
              },
              removeListener(
                callback: (
                  details: chrome.webRequest.WebRequestHeadersDetails,
                ) => void | { requestHeaders?: any },
              ) {
                const wrapper = onBeforeSendHeadersWrapperMap.get(callback)
                if (wrapper) {
                  onBeforeSendHeadersEvent.removeListener(wrapper)
                  onBeforeSendHeadersWrapperMap.delete(callback)
                  if (!onBeforeSendHeadersEvent.hasListeners()) {
                    invokeExtension('webRequest.removeOnBeforeSendHeadersListener')().catch(() => {})
                  }
                } else {
                  onBeforeSendHeadersEvent.removeListener(callback as any)
                }
              },
              hasListener(
                callback: (
                  details: chrome.webRequest.WebRequestHeadersDetails,
                ) => void | { requestHeaders?: any },
              ) {
                return onBeforeSendHeadersEvent.hasListener(
                  onBeforeSendHeadersWrapperMap.get(callback) || (callback as any),
                )
              },
              hasListeners() {
                return onBeforeSendHeadersEvent.hasListeners()
              },
            },
            onSendHeaders: {
              addListener(
                callback: (details: chrome.webRequest.WebRequestHeadersDetails) => void,
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                invokeExtension('webRequest.addOnSendHeadersListener')(
                  filter,
                  extraInfoSpec,
                )
                onSendHeadersEvent.addListener(callback)
              },
              removeListener(
                callback: (details: chrome.webRequest.WebRequestHeadersDetails) => void,
              ) {
                onSendHeadersEvent.removeListener(callback)
                if (!onSendHeadersEvent.hasListeners()) {
                  invokeExtension('webRequest.removeOnSendHeadersListener')().catch(() => {})
                }
              },
              hasListener(
                callback: (details: chrome.webRequest.WebRequestHeadersDetails) => void,
              ) {
                return onSendHeadersEvent.hasListener(callback)
              },
              hasListeners() {
                return onSendHeadersEvent.hasListeners()
              },
            },
            onHeadersReceived: {
              addListener(
                callback: (
                  details: chrome.webRequest.WebResponseHeadersDetails,
                ) => void | { responseHeaders?: any },
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                const existing = onHeadersReceivedWrapperMap.get(callback)
                if (existing) return

                invokeExtension('webRequest.addOnHeadersReceivedListener')(filter, extraInfoSpec)

                const wrapper = (details: chrome.webRequest.WebResponseHeadersDetails) => {
                  const reqId = details && (details as any).requestId
                  const listenerId = details && (details as any).listenerId
                  Promise.resolve()
                    .then(() => callback(details))
                    .then((result) => {
                      if (reqId != null && listenerId != null) {
                        invokeExtension('webRequest.onHeadersReceived.response')(
                          reqId,
                          listenerId,
                          result || undefined,
                        ).catch(() => {})
                      }
                    })
                    .catch(() => {
                      if (reqId != null && listenerId != null) {
                        invokeExtension('webRequest.onHeadersReceived.response')(
                          reqId,
                          listenerId,
                          undefined,
                        ).catch(() => {})
                      }
                    })
                }

                onHeadersReceivedWrapperMap.set(callback, wrapper)
                onHeadersReceivedEvent.addListener(wrapper)
              },
              removeListener(
                callback: (
                  details: chrome.webRequest.WebResponseHeadersDetails,
                ) => void | { responseHeaders?: any },
              ) {
                const wrapper = onHeadersReceivedWrapperMap.get(callback)
                if (wrapper) {
                  onHeadersReceivedEvent.removeListener(wrapper)
                  onHeadersReceivedWrapperMap.delete(callback)
                  if (!onHeadersReceivedEvent.hasListeners()) {
                    invokeExtension('webRequest.removeOnHeadersReceivedListener')().catch(() => {})
                  }
                } else {
                  onHeadersReceivedEvent.removeListener(callback as any)
                }
              },
              hasListener(
                callback: (
                  details: chrome.webRequest.WebResponseHeadersDetails,
                ) => void | { responseHeaders?: any },
              ) {
                return onHeadersReceivedEvent.hasListener(
                  onHeadersReceivedWrapperMap.get(callback) || (callback as any),
                )
              },
              hasListeners() {
                return onHeadersReceivedEvent.hasListeners()
              },
            },
            onBeforeRedirect: {
              addListener(
                callback: (details: chrome.webRequest.WebRedirectionResponseDetails) => void,
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                invokeExtension('webRequest.addOnBeforeRedirectListener')(
                  filter,
                  extraInfoSpec,
                )
                onBeforeRedirectEvent.addListener(callback)
              },
              removeListener(
                callback: (details: chrome.webRequest.WebRedirectionResponseDetails) => void,
              ) {
                onBeforeRedirectEvent.removeListener(callback)
                if (!onBeforeRedirectEvent.hasListeners()) {
                  invokeExtension('webRequest.removeOnBeforeRedirectListener')().catch(() => {})
                }
              },
              hasListener(
                callback: (details: chrome.webRequest.WebRedirectionResponseDetails) => void,
              ) {
                return onBeforeRedirectEvent.hasListener(callback)
              },
              hasListeners() {
                return onBeforeRedirectEvent.hasListeners()
              },
            },
            onResponseStarted: {
              addListener(
                callback: (details: chrome.webRequest.WebResponseCacheDetails) => void,
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                invokeExtension('webRequest.addOnResponseStartedListener')(
                  filter,
                  extraInfoSpec,
                )
                onResponseStartedEvent.addListener(callback)
              },
              removeListener(
                callback: (details: chrome.webRequest.WebResponseCacheDetails) => void,
              ) {
                onResponseStartedEvent.removeListener(callback)
                if (!onResponseStartedEvent.hasListeners()) {
                  invokeExtension('webRequest.removeOnResponseStartedListener')().catch(() => {})
                }
              },
              hasListener(
                callback: (details: chrome.webRequest.WebResponseCacheDetails) => void,
              ) {
                return onResponseStartedEvent.hasListener(callback)
              },
              hasListeners() {
                return onResponseStartedEvent.hasListeners()
              },
            },
            onCompleted: {
              addListener(
                callback: (details: chrome.webRequest.WebResponseCacheDetails) => void,
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                invokeExtension('webRequest.addOnCompletedListener')(
                  filter,
                  extraInfoSpec,
                )
                onCompletedEvent.addListener(callback)
              },
              removeListener(
                callback: (details: chrome.webRequest.WebResponseCacheDetails) => void,
              ) {
                onCompletedEvent.removeListener(callback)
                if (!onCompletedEvent.hasListeners()) {
                  invokeExtension('webRequest.removeOnCompletedListener')().catch(() => {})
                }
              },
              hasListener(
                callback: (details: chrome.webRequest.WebResponseCacheDetails) => void,
              ) {
                return onCompletedEvent.hasListener(callback)
              },
              hasListeners() {
                return onCompletedEvent.hasListeners()
              },
            },
            onErrorOccurred: {
              addListener(
                callback: (details: chrome.webRequest.WebResponseErrorDetails) => void,
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                invokeExtension('webRequest.addOnErrorOccurredListener')(
                  filter,
                  extraInfoSpec,
                )
                onErrorOccurredEvent.addListener(callback)
              },
              removeListener(
                callback: (details: chrome.webRequest.WebResponseErrorDetails) => void,
              ) {
                onErrorOccurredEvent.removeListener(callback)
                if (!onErrorOccurredEvent.hasListeners()) {
                  invokeExtension('webRequest.removeOnErrorOccurredListener')().catch(() => {})
                }
              },
              hasListener(
                callback: (details: chrome.webRequest.WebResponseErrorDetails) => void,
              ) {
                return onErrorOccurredEvent.hasListener(callback)
              },
              hasListeners() {
                return onErrorOccurredEvent.hasListeners()
              },
            },
            onAuthRequired: {
              addListener(
                callback: (
                  details: chrome.webRequest.WebAuthenticationChallengeDetails,
                  asyncCallback?: (response?: chrome.webRequest.BlockingResponse) => void,
                ) => void | chrome.webRequest.BlockingResponse,
                filter: chrome.webRequest.RequestFilter,
                extraInfoSpec?: string[],
              ) {
                const existing = onAuthRequiredWrapperMap.get(callback)
                if (existing) return

                invokeExtension('webRequest.addOnAuthRequiredListener')(filter, extraInfoSpec)

                const wrapper = (details: chrome.webRequest.WebAuthenticationChallengeDetails) => {
                  const reqId = details && (details as any).requestId
                  const listenerId = details && (details as any).listenerId
                  const send = (result?: chrome.webRequest.BlockingResponse | void) => {
                    if (reqId != null && listenerId != null) {
                      invokeExtension('webRequest.onAuthRequired.response')(
                        reqId,
                        listenerId,
                        result || undefined,
                      ).catch(() => {})
                    }
                  }

                  const usesAsyncBlocking =
                    Array.isArray(extraInfoSpec) && extraInfoSpec.includes('asyncBlocking')

                  if (usesAsyncBlocking) {
                    let responded = false
                    const asyncCallback = (result?: chrome.webRequest.BlockingResponse) => {
                      if (responded) return
                      responded = true
                      send(result)
                    }

                    Promise.resolve()
                      .then(() => callback(details, asyncCallback))
                      .then((result) => {
                        if (!responded && result !== undefined) {
                          responded = true
                          send(result)
                        }
                      })
                      .catch(() => {
                        if (!responded) {
                          responded = true
                          send(undefined)
                        }
                      })

                    return
                  }

                  Promise.resolve()
                    .then(() => callback(details))
                    .then((result) => send(result))
                    .catch(() => send(undefined))
                }

                onAuthRequiredWrapperMap.set(callback, wrapper)
                onAuthRequiredEvent.addListener(wrapper)
              },
              removeListener(
                callback: (
                  details: chrome.webRequest.WebAuthenticationChallengeDetails,
                  asyncCallback?: (response?: chrome.webRequest.BlockingResponse) => void,
                ) => void | chrome.webRequest.BlockingResponse,
              ) {
                const wrapper = onAuthRequiredWrapperMap.get(callback)
                if (wrapper) {
                  onAuthRequiredEvent.removeListener(wrapper)
                  onAuthRequiredWrapperMap.delete(callback)
                  if (!onAuthRequiredEvent.hasListeners()) {
                    invokeExtension('webRequest.removeOnAuthRequiredListener')().catch(() => {})
                  }
                } else {
                  onAuthRequiredEvent.removeListener(callback as any)
                }
              },
              hasListener(
                callback: (
                  details: chrome.webRequest.WebAuthenticationChallengeDetails,
                  asyncCallback?: (response?: chrome.webRequest.BlockingResponse) => void,
                ) => void | chrome.webRequest.BlockingResponse,
              ) {
                return onAuthRequiredEvent.hasListener(
                  onAuthRequiredWrapperMap.get(callback) || (callback as any),
                )
              },
              hasListeners() {
                return onAuthRequiredEvent.hasListeners()
              },
            },
          }
        },
      },

      windows: {
        factory: (base) => {
          return {
            ...base,
            WINDOW_ID_NONE: -1,
            WINDOW_ID_CURRENT: -2,
            get: invokeExtension('windows.get'),
            getCurrent: invokeExtension('windows.getCurrent'),
            getLastFocused: invokeExtension('windows.getLastFocused'),
            getAll: invokeExtension('windows.getAll'),
            create: invokeExtension('windows.create'),
            update: invokeExtension('windows.update'),
            remove: invokeExtension('windows.remove'),
            onCreated: new ExtensionEvent('windows.onCreated'),
            onRemoved: new ExtensionEvent('windows.onRemoved'),
            onFocusChanged: new ExtensionEvent('windows.onFocusChanged'),
            onBoundsChanged: new ExtensionEvent('windows.onBoundsChanged'),
          }
        },
      },
    }

    // Initialize APIs
    Object.keys(apiDefinitions).forEach((apiName) => {
      const baseApi = chrome[apiName] as any
      const api = (apiDefinitions as any)[apiName] as any
      if (!api) return

      // Allow APIs to opt-out of being available in this context.
      if (api.shouldInject && !api.shouldInject()) return

      Object.defineProperty(chrome, apiName, {
        value: api.factory(baseApi),
        enumerable: true,
        configurable: true,
      })
    })

    // Remove access to internals
    delete (globalThis as any).electron

    Object.freeze(chrome)

    void 0 // no return
  }

  if (!process.contextIsolated) {
    console.warn(`injectExtensionAPIs: context isolation disabled in ${location.href}`)
    mainWorldScript()
    return
  }

  try {
    // Expose extension IPC to main world
    contextBridge.exposeInMainWorld('electron', electronContext)

    // Mutate global 'chrome' object with additional APIs in the main world.
    if ('executeInMainWorld' in contextBridge) {
      ;(contextBridge as any).executeInMainWorld({
        func: mainWorldScript,
      })
    } else {
      // TODO(mv3): remove webFrame usage
      webFrame.executeJavaScript(`(${mainWorldScript}());`)
    }
  } catch (error) {
    console.error(`injectExtensionAPIs error (${location.href})`)
    console.error(error)
  }
}
