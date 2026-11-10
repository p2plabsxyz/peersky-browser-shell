import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener } from './event'
import { API_CONSTANTS } from './constants'
import { API_SCHEMA } from './api-schema'

export const injectExtensionAPIs = () => {
  // A click or key press in this page lets a call do what Chrome allows only
  // during a user gesture, such as permissions.request. It is read here, in the
  // preload's own world, where the page's scripts cannot fake it.
  const hasUserGesture = () => {
    try {
      return !!(globalThis as any).navigator?.userActivation?.isActive
    } catch {
      return false
    }
  }

  // Electron wraps errors from the main process as "Error invoking remote
  // method 'crx-msg': Error: <message>". Extensions see Chrome's message only.
  const cleanIpcError = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e)
    return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '')
  }

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
      result = await ipcRenderer.invoke(
        'crx-msg',
        extensionId,
        fnName,
        { gesture: hasUserGesture() },
        ...args,
      )
    } catch (e) {
      result = undefined
      lastError = { message: cleanIpcError(e) }
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

    // Promise-style callers must observe failures as rejections.
    if (lastError) {
      if (rt) delete rt.lastError
      throw new Error(lastError.message)
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
    invokeExtension(extensionId, 'runtime.connectNative', {}, connectionId, application).catch(
      () => {},
    )
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
    invokeExtension(extensionId, 'runtime.disconnectNative', {}, connectionId).catch(() => {})
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
  function mainWorldScript(constants: Record<string, any>, schema: Record<string, any>) {
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

    // Each listener gets an id here, in the page's world, so the preload can
    // find it again on removeListener: the function itself reaches the
    // preload as a different proxy on every call.
    let nextListenerId = 1
    const listenerIds = new WeakMap<Function, number>()
    const listenerIdFor = (callback: Function) => {
      let id = listenerIds.get(callback)
      if (!id) {
        id = nextListenerId++
        listenerIds.set(callback, id)
      }
      return id
    }

    class ExtensionEvent<T extends Function> implements chrome.events.Event<T> {
      private listeners = new Set<T>()

      constructor(private name: string) {}

      addListener(callback: T) {
        if (typeof callback !== 'function') {
          throw new TypeError(
            `Error in invocation of ${this.name}.addListener(function callback): No matching signature.`,
          )
        }
        if (this.listeners.has(callback)) return
        this.listeners.add(callback)
        electron.addExtensionListener(extensionId, this.name, callback, listenerIdFor(callback))
      }
      removeListener(callback: T) {
        if (!this.listeners.delete(callback)) return
        electron.removeExtensionListener(extensionId, this.name, listenerIdFor(callback))
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
        permission?: string | string[]
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
    // Which context this is. Chrome gives a service worker a few less APIs
    // than an extension page (no extension.getViews, for one).
    const contextKind =
      typeof (globalThis as any).ServiceWorkerGlobalScope === 'function' &&
      globalThis instanceof (globalThis as any).ServiceWorkerGlobalScope
        ? 'worker'
        : 'page'

    // An API shows up only for an extension that asks for its permission, in
    // its permissions or optional_permissions, as in Chrome. The main process
    // checks again on every call, and checks optional ones were granted.
    const declared = new Set<string>(
      [
        ...(((manifest as any).permissions as unknown[]) || []),
        ...(((manifest as any).optional_permissions as unknown[]) || []),
      ].filter((p): p is string => typeof p === 'string'),
    )
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
        permission: 'alarms',
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

      sidePanel: {
        permission: 'sidePanel',
        factory: (base) => {
          return {
            ...base,
            setOptions: invokeExtension('sidePanel.setOptions'),
            getOptions: invokeExtension('sidePanel.getOptions'),
            setPanelBehavior: invokeExtension('sidePanel.setPanelBehavior'),
            getPanelBehavior: invokeExtension('sidePanel.getPanelBehavior'),
            getLayout: invokeExtension('sidePanel.getLayout'),
            open: invokeExtension('sidePanel.open'),
            close: invokeExtension('sidePanel.close'),
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
        permission: 'debugger',
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
        permission: 'contextMenus',
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
        permission: 'cookies',
        factory: (base) => {
          return {
            ...base,
            get: invokeExtension('cookies.get'),
            getAll: invokeExtension('cookies.getAll'),
            set: invokeExtension('cookies.set'),
            remove: invokeExtension('cookies.remove'),
            getAllCookieStores: invokeExtension('cookies.getAllCookieStores'),
            getPartitionKey: invokeExtension('cookies.getPartitionKey'),
            onChanged: new ExtensionEvent('cookies.onChanged'),
          }
        },
      },

      userScripts: {
        permission: 'userScripts',
        factory: () => ({
          getScripts: invokeExtension('userScripts.getScripts'),
          register: invokeExtension('userScripts.register'),
          unregister: invokeExtension('userScripts.unregister'),
          update: invokeExtension('userScripts.update'),
          execute: invokeExtension('userScripts.execute'),
          configureWorld: invokeExtension('userScripts.configureWorld'),
          getWorldConfigurations: invokeExtension('userScripts.getWorldConfigurations'),
          resetWorldConfiguration: invokeExtension('userScripts.resetWorldConfiguration'),
          ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' },
        }),
      },

      offscreen: {
        permission: 'offscreen',
        factory: () => ({
          createDocument: invokeExtension('offscreen.createDocument'),
          closeDocument: invokeExtension('offscreen.closeDocument'),
          hasDocument: invokeExtension('offscreen.hasDocument'),
          Reason: {
            TESTING: 'TESTING',
            AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
            IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
            DOM_SCRAPING: 'DOM_SCRAPING',
            BLOBS: 'BLOBS',
            DOM_PARSER: 'DOM_PARSER',
            USER_MEDIA: 'USER_MEDIA',
            DISPLAY_MEDIA: 'DISPLAY_MEDIA',
            WEB_RTC: 'WEB_RTC',
            CLIPBOARD: 'CLIPBOARD',
            LOCAL_STORAGE: 'LOCAL_STORAGE',
            WORKERS: 'WORKERS',
            BATTERY_STATUS: 'BATTERY_STATUS',
            MATCH_MEDIA: 'MATCH_MEDIA',
            GEOLOCATION: 'GEOLOCATION',
          },
        }),
      },

      declarativeNetRequest: {
        permission: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'],
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
            getDisabledRuleIds: invokeExtension('declarativeNetRequest.getDisabledRuleIds'),
            getAvailableStaticRuleCount: invokeExtension('declarativeNetRequest.getAvailableStaticRuleCount'),
            isRegexSupported: invokeExtension('declarativeNetRequest.isRegexSupported'),
            getMatchedRules: invokeExtension('declarativeNetRequest.getMatchedRules'),
            testMatchOutcome: invokeExtension('declarativeNetRequest.testMatchOutcome'),
            setExtensionActionOptions: invokeExtension('declarativeNetRequest.setExtensionActionOptions'),
          }
        },
      },

      downloads: {
        permission: 'downloads',
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
            setShelfEnabled: invokeExtension('downloads.setShelfEnabled'),
            show: invokeExtension('downloads.show'),
            showDefaultFolder: invokeExtension('downloads.showDefaultFolder'),
            onChanged: new ExtensionEvent('downloads.onChanged'),
            onCreated: new ExtensionEvent('downloads.onCreated'),
            onDeterminingFilename: (() => {
              // A listener gets suggest(); calling it, or returning without
              // returning true, gives the main process its answer.
              const channel = new ExtensionEvent<(item: any) => void>('downloads.onDeterminingFilename')
              const wrappers = new Map<Function, (item: any) => void>()
              const answer = invokeExtension('downloads.determineFilename')
              return {
                addListener(callback: Function) {
                  if (typeof callback !== 'function' || wrappers.has(callback)) return
                  const wrapper = (item: any) => {
                    let answered = false
                    const suggest = (suggestion?: any) => {
                      if (answered) return
                      answered = true
                      answer(item?.id, suggestion).catch(() => {})
                    }
                    let keep: any
                    try {
                      keep = callback(item, suggest)
                    } catch {}
                    if (keep !== true) suggest()
                  }
                  wrappers.set(callback, wrapper)
                  channel.addListener(wrapper)
                },
                removeListener(callback: Function) {
                  const wrapper = wrappers.get(callback)
                  if (!wrapper) return
                  wrappers.delete(callback)
                  channel.removeListener(wrapper)
                },
                hasListener: (callback: Function) => wrappers.has(callback),
                hasListeners: () => wrappers.size > 0,
              }
            })(),
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
          const api: any = {
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
          // A service worker has no views, and Manifest V3 has no getURL or
          // background page, as in Chrome.
          if (contextKind === 'worker') delete api.getViews
          if (manifest.manifest_version === 3) {
            for (const name of ['getURL', 'getBackgroundPage', 'getExtensionTabs', 'sendRequest', 'onRequest', 'onRequestExternal', 'lastError']) {
              delete api[name]
            }
          }
          return api
        },
      },

      identity: {
        permission: 'identity',
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
        // Every extension has getSelf and the two calls about itself; the rest
        // needs the "management" permission.
        factory: (base) => {
          const api: any = {
            getSelf: invokeExtension('management.getSelf'),
            getPermissionWarningsByManifest: invokeExtension(
              'management.getPermissionWarningsByManifest',
            ),
            uninstallSelf: invokeExtension('management.uninstallSelf'),
          }
          if (declared.has('management')) {
            for (const method of [
              'createAppShortcut',
              'generateAppForLink',
              'get',
              'getAll',
              'getPermissionWarningsById',
              'launchApp',
              'setEnabled',
              'setLaunchType',
              'uninstall',
            ]) {
              api[method] = invokeExtension(`management.${method}`)
            }
            for (const event of ['onDisabled', 'onEnabled', 'onInstalled', 'onUninstalled']) {
              api[event] = new ExtensionEvent(`management.${event}`)
            }
          }
          return api
        },
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
        permission: 'notifications',
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

      omnibox: {
        manifestKey: 'omnibox',
        factory: (base: any) => {
          // sendSuggestions returns nothing in Chrome, so a bad argument has
          // to throw here, at once, with the message Chrome's bindings give.
          const invocation = 'Error in invocation of omnibox.sendSuggestions(integer requestId, array suggestResults): '
          const isInt32 = (v: any) => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
          const typeOf = (v: any) =>
            v === null
              ? 'null'
              : Array.isArray(v)
                ? 'array'
                : isInt32(v)
                  ? 'integer'
                  : typeof v
          const fields: Record<string, string> = {
            content: 'string',
            description: 'string',
            deletable: 'boolean',
            descriptionStyles: 'array',
            actions: 'array',
          }
          const checkSuggestion = (r: any): string | undefined => {
            if (!r || typeof r !== 'object' || Array.isArray(r)) {
              return `Invalid type: expected omnibox.SuggestResult, found ${typeOf(r)}.`
            }
            const seen = new Set<string>()
            for (const key of Object.keys(r)) {
              const want = fields[key]
              if (!want) return `Unexpected property: '${key}'.`
              seen.add(key)
              const v = r[key]
              if (v === null || v === undefined) {
                if (key === 'content' || key === 'description') return `Missing required property '${key}'.`
                continue
              }
              const got = typeOf(v) === 'integer' ? 'number' : typeOf(v)
              if (got !== want) return `Error at property '${key}': Invalid type: expected ${want}, found ${typeOf(v)}.`
            }
            for (const key of ['content', 'description']) {
              if (!seen.has(key)) return `Missing required property '${key}'.`
            }
            return undefined
          }
          const sendSuggestions = (...args: any[]) => {
            const [requestId, results] = args
            if (
              args.slice(2).some((a) => a !== undefined) ||
              !(isInt32(requestId) || Object.is(requestId, -0)) ||
              !Array.isArray(results)
            ) {
              throw new Error(invocation + 'No matching signature.')
            }
            results.forEach((r: any, i: number) => {
              const error = checkSuggestion(r)
              if (error) throw new Error(invocation + `Error at parameter 'suggestResults': Error at index ${i}: ${error}`)
            })
            electron
              .invokeExtension(extensionId, 'omnibox.sendSuggestions', {}, requestId, results)
              .catch((e: any) => console.error(`Unchecked runtime.lastError: ${e?.message ?? e}`))
          }
          // Listeners get (text, suggest), as in Chrome; the main process
          // sends (text, requestId), and suggest answers that request.
          const inputChanged = new ExtensionEvent<any>('omnibox.onInputChanged')
          const wrappers = new Map<Function, Function>()
          const onInputChanged = {
            addListener(callback: Function) {
              if (typeof callback !== 'function' || wrappers.has(callback)) return
              const wrapper = (text: string, requestId: number) =>
                callback(text, (suggestions: any) => sendSuggestions(requestId, suggestions))
              wrappers.set(callback, wrapper)
              inputChanged.addListener(wrapper)
            },
            removeListener(callback: Function) {
              const wrapper = wrappers.get(callback)
              if (!wrapper) return
              wrappers.delete(callback)
              inputChanged.removeListener(wrapper)
            },
            hasListener(callback: Function) {
              return wrappers.has(callback)
            },
            hasListeners() {
              return wrappers.size > 0
            },
          }
          return {
            ...base,
            setDefaultSuggestion: invokeExtension('omnibox.setDefaultSuggestion'),
            sendSuggestions,
            onInputStarted: new ExtensionEvent('omnibox.onInputStarted'),
            onInputChanged,
            onInputEntered: new ExtensionEvent('omnibox.onInputEntered'),
            onInputCancelled: new ExtensionEvent('omnibox.onInputCancelled'),
            onDeleteSuggestion: new ExtensionEvent('omnibox.onDeleteSuggestion'),
            onActionExecuted: new ExtensionEvent('omnibox.onActionExecuted'),
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
        permission: 'privacy',
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
        permission: 'proxy',
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
        permission: 'scripting',
        factory: (base) => {
          // Electron's own chrome.scripting does the injecting: it has an
          // isolated world per extension in every frame and Chrome's errors.
          // The main process checks each call first (the tab is a tab, the
          // extension may reach its frames), and runs it itself where only
          // PeerSky grants the access.
          const native: any = base || {}
          const ipc =
            (name: string) =>
            (...args: any[]) =>
              electron.invokeExtension(extensionId, name, {}, ...args)
          const NO_ACCESS = /^Cannot access contents of the page/
          const toWire = (injection: any) => {
            if (!injection || typeof injection !== 'object') return injection
            const copy = { ...injection }
            if (typeof copy.func === 'function') copy.func = String(copy.func)
            return copy
          }
          // Promise or callback, with runtime.lastError for the callback.
          const withCallback =
            (fn: (...args: any[]) => Promise<any>) =>
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const promise = Promise.resolve().then(() => fn(...args))
              if (!callback) return promise
              promise.then(
                (value) => callback(value),
                (error) => {
                  const rt = (globalThis as any).chrome?.runtime
                  try {
                    if (rt) rt.lastError = { message: error?.message ?? String(error) }
                    callback()
                  } finally {
                    if (rt) delete rt.lastError
                  }
                },
              )
            }
          const inject = (method: 'executeScript' | 'insertCSS' | 'removeCSS') =>
            withCallback(async (injection: any) => {
              const plan: any = await ipc(`scripting.${method}`)(toWire(injection))
              if (plan?.mode === 'electron' && typeof native[method] === 'function') {
                try {
                  const out = await native[method]({ ...injection, target: plan.target })
                  if (method !== 'executeScript' || !Array.isArray(out)) return out
                  // The document ids webNavigation gives, so the two agree.
                  return out.map((r: any) => ({
                    ...r,
                    documentId: plan.documentIds?.[r.frameId] ?? r.documentId,
                  }))
                } catch (error: any) {
                  if (!NO_ACCESS.test(error?.message ?? '')) throw error
                }
              }
              const done: any = await ipc(`scripting.${method}`)(toWire(injection), { fallback: true })
              return done?.result
            })

          // Electron forgets registered scripts at a restart; the first
          // context registers the persisted ones again before anything else
          // reads or changes the registry.
          const sync = async () => {
            try {
              await ipc('scripting.syncContentScripts')(await native.getRegisteredContentScripts())
            } catch {}
          }
          const ready = (async () => {
            try {
              const pending: any[] = await ipc('scripting.restoreContentScripts')()
              if (!Array.isArray(pending) || pending.length === 0) return
              const have = new Set(((await native.getRegisteredContentScripts()) || []).map((s: any) => s.id))
              for (const script of pending) {
                if (have.has(script.id)) continue
                try {
                  await native.registerContentScripts([script])
                } catch {}
              }
              await sync()
            } catch {}
          })()
          const registry = (method: string, changes: boolean) =>
            withCallback(async (...args: any[]) => {
              await ready
              if (typeof native[method] !== 'function') {
                throw new Error(`scripting.${method} is not available in this context.`)
              }
              const out = await native[method](...args)
              if (changes) await sync()
              return out
            })

          return {
            ...base,
            executeScript: inject('executeScript'),
            insertCSS: inject('insertCSS'),
            removeCSS: inject('removeCSS'),
            registerContentScripts: registry('registerContentScripts', true),
            getRegisteredContentScripts: registry('getRegisteredContentScripts', false),
            unregisterContentScripts: registry('unregisterContentScripts', true),
            updateContentScripts: registry('updateContentScripts', true),
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
          patched.getContexts = invokeExtension('runtime.getContexts')
          patched.openOptionsPage = invokeExtension('runtime.openOptionsPage')
          patched.sendNativeMessage = invokeExtension('runtime.sendNativeMessage')
          patched.requestUpdateCheck = invokeExtension('runtime.requestUpdateCheck')
          // Electron never fires these. The main process does, once the
          // extension has added its listener.
          patched.onInstalled = new ExtensionEvent('runtime.onInstalled')
          patched.onStartup = new ExtensionEvent('runtime.onStartup')
          return patched
        },
      },

      storage: {
        permission: 'storage',
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
          // Manifest V3 has no tabs.executeScript, insertCSS or the other
          // calls replaced by chrome.scripting, as in Chrome.
          if (manifest.manifest_version === 3) {
            for (const name of [
              'executeScript',
              'insertCSS',
              'removeCSS',
              'getAllInWindow',
              'getSelected',
              'sendRequest',
              'onActiveChanged',
              'onHighlightChanged',
              'onSelectionChanged',
              'onRequest',
            ]) {
              delete (api as any)[name]
            }
          }
          return api
        },
      },

      topSites: {
        permission: 'topSites',
        factory: () => {
          return {
            get: invokeExtension('topSites.get'),
          }
        },
      },

      webNavigation: {
        permission: 'webNavigation',
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
        permission: 'webRequest',
        factory: (base) => {
          // Every event the main process sends carries the id of the listener
          // it is for; a listener answers only its own, and never sees the id.
          const invoke = (name: string, ...args: any[]) =>
            electron.invokeExtension(extensionId, name, {}, ...args)
          const canBlock = new Set(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onAuthRequired'])
          const makeEvent = (name: string) => {
            const suffix = name[0].toUpperCase() + name.slice(1)
            const channel = new ExtensionEvent<(details: any) => void>(`webRequest.${name}`)
            const wrappers = new Map<Function, { wrapper: (details: any) => void; id: Promise<any> }>()
            // Identical listeners in this context, counted so the main process
            // can tell a second one from a restarted worker's first.
            const counts = new Map<string, number>()
            return {
              addListener(callback: Function, filter: any, extraInfoSpec?: string[]) {
                if (typeof callback !== 'function' || wrappers.has(callback)) return
                const spec = Array.isArray(extraInfoSpec) ? extraInfoSpec : []
                let key = ''
                try {
                  key = JSON.stringify([filter, spec])
                } catch {}
                const ordinal = counts.get(key) || 0
                counts.set(key, ordinal + 1)
                const id = Promise.resolve(
                  invoke(`webRequest.add${suffix}Listener`, filter, extraInfoSpec, ordinal),
                ).catch(() => undefined)
                const asyncBlocking = name === 'onAuthRequired' && spec.includes('asyncBlocking')
                const blocking = canBlock.has(name) && (spec.includes('blocking') || asyncBlocking)
                const wrapper = (raw: any) => {
                  void id.then((myId) => {
                    if (!raw || myId == null || raw.listenerId !== myId) return
                    const { listenerId, ...details } = raw
                    let answered = false
                    const respond = (result?: any) => {
                      if (answered) return
                      answered = true
                      if (!blocking) return
                      invoke(`webRequest.${name}.response`, details.requestId, listenerId, result || undefined).catch(() => {})
                    }
                    if (asyncBlocking) {
                      try {
                        const result = callback(details, respond)
                        if (result !== undefined) respond(result)
                      } catch {
                        respond(undefined)
                      }
                      return
                    }
                    let result: any
                    try {
                      result = callback(details)
                    } catch {
                      respond(undefined)
                      return
                    }
                    Promise.resolve(result).then(respond, () => respond(undefined))
                  })
                }
                wrappers.set(callback, { wrapper, id })
                channel.addListener(wrapper)
              },
              removeListener(callback: Function) {
                const entry = wrappers.get(callback)
                if (!entry) return
                wrappers.delete(callback)
                channel.removeListener(entry.wrapper)
                void entry.id.then((myId) => {
                  if (myId != null) invoke(`webRequest.remove${suffix}Listener`, myId).catch(() => {})
                })
              },
              hasListener(callback: Function) {
                return wrappers.has(callback)
              },
              hasListeners() {
                return wrappers.size > 0
              },
            }
          }
          const api: any = { ...base }
          for (const name of [
            'onBeforeRequest',
            'onBeforeSendHeaders',
            'onSendHeaders',
            'onHeadersReceived',
            'onAuthRequired',
            'onResponseStarted',
            'onBeforeRedirect',
            'onCompleted',
            'onErrorOccurred',
          ]) {
            api[name] = makeEvent(name)
          }
          return api
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

    const isAllowed = (def: any) => {
      if (!def) return false
      if (def.permission) {
        const anyOf: string[] = Array.isArray(def.permission) ? def.permission : [def.permission]
        if (!anyOf.some((p) => declared.has(p))) return false
      }
      if (def.manifestKey && !(manifest as any)[def.manifestKey]) return false
      if (def.manifestVersion && manifest.manifest_version !== def.manifestVersion) return false
      if (def.contexts && !def.contexts.includes(contextKind)) return false
      if (def.shouldInject && !def.shouldInject()) return false
      return true
    }
    const isGated = (def: any) =>
      !!def && !!(def.permission || def.manifestKey || def.manifestVersion || def.contexts)

    const getPath = (root: any, dotted: string) =>
      dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), root)
    const setPath = (root: any, dotted: string, value: any) => {
      const parts = dotted.split('.')
      let node = root
      for (const part of parts.slice(0, -1)) {
        if (!node[part] || typeof node[part] !== 'object') {
          Object.defineProperty(node, part, { value: {}, enumerable: true, configurable: true, writable: true })
        }
        node = node[part]
      }
      Object.defineProperty(node, parts[parts.length - 1], {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    const deletePath = (root: any, dotted: string) => {
      const parts = dotted.split('.')
      const parent = getPath(root, parts.slice(0, -1).join('.')) ?? (parts.length === 1 ? root : undefined)
      if (parent && parts[parts.length - 1] in parent) {
        try {
          delete parent[parts[parts.length - 1]]
        } catch {}
      }
    }

    // Methods and events listed in the schema for the main process to serve.
    // `override` replaces Electron's own bindings, some of which have nothing
    // behind them and crash the browser when called (chrome.system.*).
    const applySchema = (name: string, spec: any, target: any) => {
      for (const method of spec.methods || []) {
        if (spec.override || !(method in target)) target[method] = invokeExtension(`${name}.${method}`)
      }
      for (const event of spec.events || []) {
        if (spec.override || !(event in target)) target[event] = new ExtensionEvent(`${name}.${event}`)
      }
      for (const method of spec.remove || []) {
        try {
          delete target[method]
        } catch {}
      }
      return target
    }

    // Chrome's enum objects and constants (tabs.TAB_ID_NONE,
    // downloads.State.COMPLETE, ...). A nested namespace that this context
    // does not have is skipped rather than made up from its constants.
    const applyConstants = (target: any, values: any) => {
      if (!target || !values) return
      for (const [key, value] of Object.entries(values)) {
        if (value && typeof value === 'object') {
          const isEnum = Object.values(value as object).every((v) => typeof v !== 'object')
          if (target[key] && typeof target[key] === 'object') applyConstants(target[key], value)
          else if (isEnum && /^[A-Z]/.test(key)) target[key] = { ...(value as object) }
        } else if (!(key in target)) {
          target[key] = value
        }
      }
    }

    // Initialize APIs: the hand-written definitions, then everything else the
    // schema lists.
    const apiNames = new Set([...Object.keys(apiDefinitions), ...Object.keys(schema || {})])
    const injected: string[] = []
    for (const apiName of apiNames) {
      const def = (apiDefinitions as any)[apiName]
      const spec = schema?.[apiName]
      const gate = { ...(spec || {}), ...(def || {}) }
      if (!isAllowed(gate)) {
        // Chrome leaves the namespace out entirely without its permission.
        if (isGated(gate)) deletePath(chrome, apiName)
        continue
      }
      const base = getPath(chrome, apiName)
      // An overriding schema entry starts from a fresh object: Electron's own
      // binding objects may not let their members be replaced.
      let api = def
        ? def.factory(base)
        : spec?.override || !base || typeof base !== 'object'
          ? {}
          : base
      if (spec) api = applySchema(apiName, spec, api)
      applyConstants(api, getPath(constants, apiName))
      setPath(chrome, apiName, api)
      injected.push(apiName)
    }

    // Chromium 150 exposes a native `browser` alias in extension contexts as a
    // SEPARATE object, and extensions that prefer it (webextension-polyfill,
    // Firefox-first builds) then see the un-shimmed native subset: no privacy,
    // permissions events, proxy, and so on. Mirror the patched surface onto it
    // so both globals agree.
    const browserAlias = (globalThis as any).browser
    if (browserAlias && browserAlias !== chrome) {
      for (const apiName of apiNames) {
        try {
          const root = apiName.split('.')[0]
          if (root in chrome) {
            Object.defineProperty(browserAlias, root, {
              value: (chrome as any)[root],
              enumerable: true,
              configurable: true,
            })
          } else if (root in browserAlias) {
            delete browserAlias[root]
          }
        } catch (_) {}
      }
    }

    // Remove access to internals

    delete (globalThis as any).electron

    // Chrome does not freeze the chrome object, and extensions rely on that:
    // compatibility shims assign to it (e.g. `chrome.browserAction = chrome.action`),
    // which throws in strict-mode module workers when frozen and fails the
    // service worker's script evaluation (registration status 15).

    void 0 // no return
  }

  if (!process.contextIsolated) {
    console.warn(`injectExtensionAPIs: context isolation disabled in ${location.href}`)
    mainWorldScript(API_CONSTANTS, API_SCHEMA)
    return
  }

  try {
    // Expose extension IPC to main world
    contextBridge.exposeInMainWorld('electron', electronContext)

    // Mutate global 'chrome' object with additional APIs in the main world.
    // The constants and schema are plain data, copied in as arguments.
    if ('executeInMainWorld' in contextBridge) {
      ;(contextBridge as any).executeInMainWorld({
        func: mainWorldScript,
        args: [API_CONSTANTS, API_SCHEMA],
      })
    } else {
      // TODO(mv3): remove webFrame usage
      webFrame.executeJavaScript(
        `(${mainWorldScript})(${JSON.stringify(API_CONSTANTS)}, ${JSON.stringify(API_SCHEMA)});`,
      )
    }
  } catch (error) {
    console.error(`injectExtensionAPIs error (${location.href})`)
    console.error(error)
  }
}
