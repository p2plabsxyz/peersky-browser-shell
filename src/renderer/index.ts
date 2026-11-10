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
  function mainWorldScript(
    constants: Record<string, any>,
    schema: Record<string, any>,
    context: { offscreen?: boolean } = {},
  ) {
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

    // A callback runs here, in the extension's own world, so it sees
    // runtime.lastError: set in the preload's world, it never reached the
    // extension. Chrome calls it with no arguments when there is no result.
    const runCallback = (callback: Function, error?: unknown, result?: unknown) => {
      const runtime = (globalThis as any).chrome?.runtime
      if (error && runtime) {
        runtime.lastError = { message: error instanceof Error ? error.message : String(error) }
      }
      try {
        if (error || result === undefined) callback()
        else callback(result)
      } finally {
        if (runtime) delete runtime.lastError
      }
    }

    const invokeExtension =
      (fnName: string, opts: ExtensionMessageOptions = {}) =>
        (...args: any[]) => {
          const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
          const promise = electron.invokeExtension(extensionId, fnName, opts, ...args)
          if (!callback) return promise
          promise.then(
            (result: unknown) => runCallback(callback, undefined, result),
            (error: unknown) => runCallback(callback, error),
          )
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

    // A types.ChromeSetting kept by the main process, such as
    // chrome.privacy.network.webRTCIPHandlingPolicy: calls go to `${name}.get`
    // and so on, and changes come as `${name}.onChange`.
    const chromeSetting = (name: string) => ({
      get: invokeExtension(`${name}.get`),
      set: invokeExtension(`${name}.set`),
      clear: invokeExtension(`${name}.clear`),
      onChange: new ExtensionEvent(`${name}.onChange`),
    })

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
      // ImageData cannot cross to the main process; its pixels can.
      const serializeImageData = (value: any): any => {
        if (typeof ImageData !== 'undefined' && value instanceof ImageData) {
          return { width: value.width, height: value.height, data: new Uint8Array(value.data) }
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const out: any = {}
          for (const [size, data] of Object.entries(value)) {
            out[size] =
              typeof ImageData !== 'undefined' && data instanceof ImageData
                ? { width: data.width, height: data.height, data: new Uint8Array(data.data) }
                : data
          }
          return out
        }
        return value
      }

      const api = {
        ...base,

        setTitle: invokeExtension('browserAction.setTitle'),
        getTitle: invokeExtension('browserAction.getTitle'),

        setIcon: invokeExtension('browserAction.setIcon', {
          serialize: (details: chrome.action.TabIconDetails) => {
            if (details && typeof details === 'object' && details.imageData !== undefined) {
              return [{ ...details, imageData: serializeImageData(details.imageData) }]
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

        setBadgeTextColor: invokeExtension('browserAction.setBadgeTextColor'),
        getBadgeTextColor: invokeExtension('browserAction.getBadgeTextColor'),

        getUserSettings: invokeExtension('browserAction.getUserSettings'),

        enable: invokeExtension('browserAction.enable'),
        disable: invokeExtension('browserAction.disable'),
        isEnabled: invokeExtension('browserAction.isEnabled'),

        openPopup: invokeExtension('browserAction.openPopup'),

        onClicked: new ExtensionEvent('browserAction.onClicked'),
        onUserSettingsChanged: new ExtensionEvent('browserAction.onUserSettingsChanged'),
      }

      // These came with the action API; Manifest V2's browserAction has none.
      if (manifest.manifest_version !== 3) {
        for (const name of ['setBadgeTextColor', 'getBadgeTextColor', 'getUserSettings', 'isEnabled', 'onUserSettingsChanged']) {
          delete (api as any)[name]
        }
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
    // Chrome's argument checks, for the hand-written calls below that check
    // in the page as Chrome's bindings do: a bad argument throws at once with
    // Chrome's message. The main process checks every call again.
    type ArgSpec = {
      type: string
      min?: number
      max?: number
      enum?: string[]
      items?: ArgSpec
      choices?: ArgSpec[]
      props?: Record<string, ArgSpec>
      required?: string[]
    }
    const typeOfArg = (v: unknown) =>
      v === null
        ? 'null'
        : Array.isArray(v)
          ? 'array'
          : typeof v === 'number'
            ? Number.isInteger(v)
              ? 'integer'
              : 'number'
            : typeof v
    const checkArg = (spec: ArgSpec, value: any): string | undefined => {
      if (spec.choices) {
        if (spec.choices.some((choice) => !checkArg(choice, value))) return undefined
        return `Invalid type: expected [${spec.choices.map((c) => c.type).join('|')}], found ${typeOfArg(value)}.`
      }
      if (spec.type === 'any') return undefined
      const found = typeOfArg(value)
      if (found !== spec.type && !(spec.type === 'number' && found === 'integer')) {
        return `Invalid type: expected ${spec.type}, found ${found}.`
      }
      if (spec.enum && !spec.enum.includes(value)) return `Value must be one of ${[...spec.enum].sort().join(', ')}.`
      if (spec.min !== undefined && value < spec.min) return `Value must be at least ${spec.min}.`
      if (spec.max !== undefined && value > spec.max) return `Value must be at most ${spec.max}.`
      if (spec.items) {
        for (let i = 0; i < value.length; i++) {
          const error = checkArg(spec.items, value[i])
          if (error) return `Error at index ${i}: ${error}`
        }
      }
      if (spec.props) {
        for (const name of Object.keys(spec.props).sort()) {
          const v = value[name]
          if (v === undefined || v === null) {
            if (spec.required?.includes(name)) return `Missing required property '${name}'.`
            continue
          }
          const error = checkArg(spec.props[name], v)
          if (error) return `Error at property '${name}': ${error}`
        }
        for (const name of Object.keys(value)) {
          if (!(name in spec.props)) return `Unexpected property: '${name}'.`
        }
      }
      return undefined
    }
    const invocationError = (signature: string, detail: string) =>
      new TypeError(`Error in invocation of ${signature}: ${detail}`)
    /** Throws as Chrome does for an argument `name` of `signature` that does not fit `spec`. */
    const checkParam = (signature: string, name: string, spec: ArgSpec, value: unknown) => {
      const error = checkArg(spec, value)
      if (error) {
        throw invocationError(signature, error.startsWith('Invalid type') ? 'No matching signature.' : `Error at parameter '${name}': ${error}`)
      }
    }
    const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
    /** Calls back as Chrome does: chrome.runtime.lastError is set while the callback runs after a failure. */
    const callBack = (callback: Function, error: unknown, args: any[]) => {
      const rt = chrome.runtime
      if (error && rt) {
        try {
          Object.defineProperty(rt, 'lastError', {
            value: { message: errorText(error) },
            configurable: true,
            enumerable: true,
            writable: true,
          })
        } catch {}
      }
      try {
        callback(...args)
      } finally {
        if (error && rt) {
          try {
            delete rt.lastError
          } catch {}
        }
      }
    }
    const strings: ArgSpec = { type: 'array', items: { type: 'string' } }

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
            onOpened: new ExtensionEvent('sidePanel.onOpened'),
            onClosed: new ExtensionEvent('sidePanel.onClosed'),
          }
        },
      },

      commands: {
        // Chrome gives chrome.commands only to an extension whose manifest has commands.
        manifestKey: 'commands',
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

      // chrome.tts: speak's onEvent option stays in this context; the main
      // process tags the utterance's events with a srcId and they come back
      // through tts.onEvent, as Chrome's bindings do it.
      tts: {
        permission: 'tts',
        factory: (base: any) => {
          const signature =
            'tts.speak(string utterance, optional tts.TtsOptions options, optional function callback)'
          const optionsSpec: ArgSpec = {
            type: 'object',
            props: {
              desiredEventTypes: strings,
              enqueue: { type: 'boolean' },
              extensionId: { type: 'string' },
              gender: { type: 'string', enum: ['male', 'female'] },
              lang: { type: 'string' },
              onEvent: { type: 'function' },
              pitch: { type: 'number', min: 0, max: 2 },
              rate: { type: 'number', max: 10 },
              requiredEventTypes: strings,
              voiceName: { type: 'string' },
              volume: { type: 'number', min: 0, max: 1 },
            },
          }
          const onEvent = new ExtensionEvent('tts.onEvent')
          const handlers = new Map<number, Function>()
          let listening = false
          // Unique across this extension's pages and worker, which all hear
          // every tts.onEvent.
          let nextSrcId = 1 + Math.floor(Math.random() * 0x3fffffff)
          const dispatch = (event: any) => {
            const handler = event && handlers.get(event.srcId)
            if (!handler) return
            if (event.isFinalEvent) handlers.delete(event.srcId)
            handler({
              type: event.type,
              charIndex: event.charIndex,
              length: event.length,
              errorMessage: event.errorMessage,
            })
          }
          // Calls that answer nothing call back with no arguments, as in Chrome.
          const noResult = (name: string) => {
            const call = invokeExtension(name)
            return (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const result = (call(...args) as Promise<unknown>).then(() => undefined)
              if (!callback) return result
              result.then(
                () => callBack(callback, null, []),
                (error) => callBack(callback, error, []),
              )
            }
          }
          const speak = noResult('tts.speak')
          return {
            ...base,
            getVoices: invokeExtension('tts.getVoices'),
            isSpeaking: invokeExtension('tts.isSpeaking'),
            pause: noResult('tts.pause'),
            resume: noResult('tts.resume'),
            stop: noResult('tts.stop'),
            speak(utterance: unknown, options?: any, callback?: unknown) {
              if (typeof options === 'function' && callback === undefined) {
                callback = options
                options = undefined
              }
              if (typeof utterance !== 'string' || (callback !== undefined && typeof callback !== 'function')) {
                throw invocationError(signature, 'No matching signature.')
              }
              let sent: any
              if (options != null) {
                checkParam(signature, 'options', optionsSpec, options)
                sent = { ...options }
                if (typeof sent.onEvent === 'function') {
                  const srcId = nextSrcId++
                  handlers.set(srcId, sent.onEvent)
                  if (!listening) {
                    listening = true
                    onEvent.addListener(dispatch)
                  }
                  sent.srcId = srcId
                }
                delete sent.onEvent
              }
              return callback ? speak(utterance, sent, callback) : speak(utterance, sent)
            },
            onEvent,
            onVoicesChanged: new ExtensionEvent('tts.onVoicesChanged'),
          }
        },
      },

      // chrome.pageCapture: the main process sends the page's MHTML bytes,
      // which reach the extension as a Blob, as in Chrome.
      pageCapture: {
        permission: 'pageCapture',
        factory: (base: any) => {
          const signature = 'pageCapture.saveAsMHTML(object details, optional function callback)'
          const detailsSpec: ArgSpec = { type: 'object', props: { tabId: { type: 'integer' } }, required: ['tabId'] }
          const save = invokeExtension('pageCapture.saveAsMHTML')
          return {
            ...base,
            saveAsMHTML(details: any, callback?: unknown) {
              if (callback !== undefined && typeof callback !== 'function') {
                throw invocationError(signature, 'No matching signature.')
              }
              checkParam(signature, 'details', detailsSpec, details)
              const result = (save({ tabId: details.tabId }) as Promise<any>).then((bytes) => new Blob([bytes]))
              if (!callback) return result
              result.then(
                (blob) => callBack(callback as Function, null, [blob]),
                (error) => callBack(callback as Function, error, [undefined]),
              )
            },
          }
        },
      },

      // chrome.tabCapture: getMediaStreamId gives an id for getUserMedia;
      // capture(), in extension pages only, opens the stream itself.
      tabCapture: {
        permission: 'tabCapture',
        factory: (base: any) => {
          const idSignature =
            'tabCapture.getMediaStreamId(optional tabCapture.GetMediaStreamOptions options, optional function callback)'
          const captureSignature = 'tabCapture.capture(tabCapture.CaptureOptions options, function callback)'
          const constraintsSpec: ArgSpec = {
            type: 'object',
            props: { mandatory: { type: 'object' }, optional: { type: 'object' } },
          }
          const getId = invokeExtension('tabCapture.getMediaStreamId')
          const api: any = {
            ...base,
            getMediaStreamId(options?: any, callback?: unknown) {
              if (typeof options === 'function' && callback === undefined) {
                callback = options
                options = undefined
              }
              if (callback !== undefined && typeof callback !== 'function') {
                throw invocationError(idSignature, 'No matching signature.')
              }
              if (options != null) {
                checkParam(idSignature, 'options', {
                  type: 'object',
                  props: { consumerTabId: { type: 'integer' }, targetTabId: { type: 'integer' } },
                }, options)
              }
              const args = options == null ? [] : [{ targetTabId: options.targetTabId, consumerTabId: options.consumerTabId }]
              return callback ? getId(...args, callback) : getId(...args)
            },
            getCapturedTabs: invokeExtension('tabCapture.getCapturedTabs'),
            onStatusChanged: new ExtensionEvent('tabCapture.onStatusChanged'),
          }
          if (contextKind === 'page') {
            const startCapture = invokeExtension('tabCapture.capture')
            api.capture = (options: any, callback: unknown) => {
              if (typeof callback !== 'function') throw invocationError(captureSignature, 'No matching signature.')
              checkParam(captureSignature, 'options', {
                type: 'object',
                props: {
                  audio: { type: 'boolean' },
                  audioConstraints: constraintsSpec,
                  presentationId: { type: 'string' },
                  video: { type: 'boolean' },
                  videoConstraints: constraintsSpec,
                },
              }, options)
              const constraint = (wanted: boolean, extra: any, id: string) =>
                wanted
                  ? {
                      mandatory: { ...((extra && extra.mandatory) || {}), chromeMediaSource: 'tab', chromeMediaSourceId: id },
                      ...(extra && extra.optional ? { optional: extra.optional } : {}),
                    }
                  : false
              ;(startCapture({ audio: options.audio === true, video: options.video === true }) as Promise<string>)
                .then((id) =>
                  (globalThis as any).navigator.mediaDevices.getUserMedia({
                    audio: constraint(options.audio === true, options.audioConstraints, id),
                    video: constraint(options.video === true, options.videoConstraints, id),
                  }),
                )
                .then(
                  (stream: any) => callBack(callback, null, [stream]),
                  (error: unknown) => callBack(callback, error, [null]),
                )
            }
          }
          return api
        },
      },

      // chrome.desktopCapture: chooseDesktopMedia returns its request id at
      // once and answers through its callback when the person has chosen.
      desktopCapture: {
        permission: 'desktopCapture',
        factory: (base: any) => {
          const signature =
            'desktopCapture.chooseDesktopMedia(array sources, optional tabs.Tab targetTab, optional object options, function callback)'
          const cancelSignature = 'desktopCapture.cancelChooseDesktopMedia(integer desktopMediaRequestId)'
          const choose = invokeExtension('desktopCapture.chooseDesktopMedia')
          const cancel = invokeExtension('desktopCapture.cancelChooseDesktopMedia')
          let nextRequestId = 1 + Math.floor(Math.random() * 0x3fffffff)
          return {
            ...base,
            chooseDesktopMedia(...args: any[]) {
              const callback = args[args.length - 1]
              if (typeof callback !== 'function' || args.length < 2 || args.length > 4) {
                throw invocationError(signature, 'No matching signature.')
              }
              const [sources, targetTab, options] = args.slice(0, -1)
              checkParam(signature, 'sources', {
                type: 'array',
                items: { type: 'string', enum: ['screen', 'window', 'tab', 'audio'] },
              }, sources)
              if (targetTab != null && typeOfArg(targetTab) !== 'object') {
                throw invocationError(signature, 'No matching signature.')
              }
              if (options != null) {
                checkParam(signature, 'options', {
                  type: 'object',
                  props: {
                    selfBrowserSurface: { type: 'string', enum: ['exclude', 'include'] },
                    suppressLocalAudioPlaybackIntended: { type: 'boolean' },
                    systemAudio: { type: 'string', enum: ['exclude', 'include'] },
                    windowAudio: { type: 'string', enum: ['exclude', 'system', 'window'] },
                  },
                }, options)
              }
              const requestId = nextRequestId++
              const tab = targetTab == null ? undefined : { id: targetTab.id, url: targetTab.url }
              ;(choose(requestId, [...sources], tab, options == null ? undefined : { ...options }) as Promise<any>).then(
                (answer) => callBack(callback, null, Array.isArray(answer) ? answer : ['', { canRequestAudioTrack: false }]),
                (error) => callBack(callback, error, [undefined, undefined]),
              )
              return requestId
            },
            cancelChooseDesktopMedia(...args: any[]) {
              if (args.length !== 1 || !Number.isInteger(args[0])) {
                throw invocationError(cancelSignature, 'No matching signature.')
              }
              ;(cancel(args[0]) as Promise<void>).catch(() => {})
            },
          }
        },
      },

      // chrome.declarativeContent: the rule types are built and checked here,
      // as Chrome's bindings do, and onPageChanged keeps its rules in the
      // main process, which matches them against pages.
      declarativeContent: {
        permission: 'declarativeContent',
        factory: () => {
          const PAGE_STATE_MATCHER = 'declarativeContent.PageStateMatcher'
          const SHOW_ACTION = 'declarativeContent.ShowAction'
          const SHOW_PAGE_ACTION = 'declarativeContent.ShowPageAction'
          const SET_ICON = 'declarativeContent.SetIcon'
          const REQUEST_CONTENT_SCRIPT = 'declarativeContent.RequestContentScript'
          const urlFilterProps: Record<string, ArgSpec> = {
            cidrBlocks: strings,
            ports: { type: 'array', items: { type: 'any', choices: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }] } },
            schemes: strings,
          }
          for (const name of [
            'hostContains', 'hostEquals', 'hostPrefix', 'hostSuffix', 'pathContains', 'pathEquals', 'pathPrefix',
            'pathSuffix', 'queryContains', 'queryEquals', 'queryPrefix', 'querySuffix', 'urlContains', 'urlEquals',
            'urlMatches', 'originAndPathMatches', 'urlPrefix', 'urlSuffix',
          ]) {
            urlFilterProps[name] = { type: 'string' }
          }
          const specs: Record<string, ArgSpec> = {
            [PAGE_STATE_MATCHER]: {
              type: 'object',
              props: {
                css: strings,
                instanceType: { type: 'string' },
                isBookmarked: { type: 'boolean' },
                pageUrl: { type: 'object', props: urlFilterProps },
              },
            },
            [SHOW_ACTION]: { type: 'object', props: { instanceType: { type: 'string' } } },
            [SHOW_PAGE_ACTION]: { type: 'object', props: { instanceType: { type: 'string' } } },
            [SET_ICON]: { type: 'object', props: { imageData: { type: 'object' }, instanceType: { type: 'string' } } },
            [REQUEST_CONTENT_SCRIPT]: {
              type: 'object',
              props: {
                allFrames: { type: 'boolean' },
                css: strings,
                instanceType: { type: 'string' },
                js: strings,
                matchAboutBlank: { type: 'boolean' },
              },
            },
          }
          const invalid = (detail?: string) => new Error(detail ? `Invalid invocation: ${detail}` : 'Invalid invocation')

          // Chrome takes compound selectors only, such as 'a.b[c]:hover', and
          // lists of them: no combinators between parts.
          const isCompoundSelector = (selector: string) => {
            const parts: string[] = []
            let depth = 0
            let quote = ''
            let part = ''
            for (const ch of selector) {
              if (quote) {
                if (ch === quote) quote = ''
              } else if (ch === '"' || ch === "'") quote = ch
              else if (ch === '(' || ch === '[') depth++
              else if (ch === ')' || ch === ']') depth--
              else if (ch === ',' && depth === 0) {
                parts.push(part)
                part = ''
                continue
              }
              part += ch
            }
            if (quote || depth !== 0) return false
            parts.push(part)
            const simple = /^(?:\*|-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*)?(?:#-?[_a-zA-Z0-9 -￿-]+|\.-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*|\[[^\]]+\]|::?[-a-zA-Z]+(?:\((?:[^()]|\([^()]*\))*\))?)*$/
            return parts.every((p) => {
              const s = p.trim()
              if (!s || !simple.test(s)) return false
              const doc = (globalThis as any).document
              if (doc) {
                try {
                  doc.createDocumentFragment().querySelector(s)
                } catch {
                  return false
                }
              }
              return true
            })
          }

          // Copies the parameters in, as Chrome's constructors do, then checks the result.
          const setup = (instance: any, parameters: any, instanceType: string) => {
            if (parameters && typeof parameters === 'object') {
              for (const key of Object.keys(parameters)) instance[key] = parameters[key]
            }
            instance.instanceType = instanceType
            const error = checkArg(specs[instanceType], instance)
            if (error) throw invalid(error)
          }

          function PageStateMatcher(this: any, parameters?: any) {
            if (!(this instanceof PageStateMatcher)) throw invalid()
            setup(this, parameters, PAGE_STATE_MATCHER)
            for (const selector of (this as any).css || []) {
              if (!isCompoundSelector(selector)) throw invalid(`Invalid CSS selector: ${selector}`)
            }
          }
          function ShowAction(this: any, parameters?: any) {
            if (!(this instanceof ShowAction)) throw invalid()
            setup(this, parameters, SHOW_ACTION)
          }
          // In Manifest V3 a ShowPageAction is a ShowAction.
          function ShowPageAction(this: any, parameters?: any) {
            if (!(this instanceof ShowPageAction)) throw invalid()
            setup(this, parameters, SHOW_ACTION)
          }
          function RequestContentScript(this: any, parameters?: any) {
            if (!(this instanceof RequestContentScript)) throw invalid()
            setup(this, parameters, REQUEST_CONTENT_SCRIPT)
          }
          const isImageData = (v: any) => typeof ImageData === 'function' && v instanceof ImageData
          // Chrome keeps each icon as an ArrayBuffer of its pixels from the
          // start. Here: width and height (32 bits each), then RGBA bytes.
          const packImage = (image: ImageData) => {
            const buffer = new ArrayBuffer(8 + image.data.length)
            const view = new DataView(buffer)
            view.setUint32(0, image.width, true)
            view.setUint32(4, image.height, true)
            new Uint8Array(buffer, 8).set(image.data)
            return buffer
          }
          const badImageData = () =>
            new Error('The imageData property must contain an ImageData object or dictionary of ImageData objects.')
          const packIcons = (imageData: any) => {
            if (isImageData(imageData)) return { [imageData.width]: packImage(imageData) }
            if (!imageData || typeof imageData !== 'object') throw badImageData()
            const out: Record<string, ArrayBuffer> = {}
            for (const [size, image] of Object.entries(imageData)) {
              if (!isImageData(image)) throw badImageData()
              out[size] = packImage(image as ImageData)
            }
            return out
          }
          // Icons from a path load later, as in Chrome: until then the
          // instance has no instanceType and addRules refuses it.
          const loadIcon = async (instance: any, path: any) => {
            const paths: Record<string, string> = typeof path === 'string' ? { 16: path } : path
            const images: Record<string, ImageData> = {}
            for (const [size, file] of Object.entries(paths)) {
              const response = await fetch(new URL(String(file), `chrome-extension://${extensionId}/`).href)
              const bitmap = await createImageBitmap(await response.blob())
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
              const context = canvas.getContext('2d')!
              context.drawImage(bitmap, 0, 0)
              images[size] = context.getImageData(0, 0, bitmap.width, bitmap.height)
            }
            instance.imageData = packIcons(images)
            instance.instanceType = SET_ICON
          }
          function SetIcon(this: any, parameters?: any) {
            if (!(this instanceof SetIcon)) throw invalid()
            if (!('imageData' in parameters) && !('path' in parameters)) {
              throw new Error('Either the path or imageData property must be specified.')
            }
            if ('path' in parameters && !('imageData' in parameters)) {
              loadIcon(this, parameters.path).catch((error) => console.error('declarativeContent.SetIcon:', error))
              return
            }
            const { imageData, ...rest } = parameters
            const icons = packIcons(imageData)
            const self: any = this
            setup(self, rest, SET_ICON)
            self.imageData = icons
          }

          // A rule as the main process takes it: plain data, icons in base64.
          const toBase64 = (buffer: ArrayBuffer) => {
            const bytes = new Uint8Array(buffer)
            let text = ''
            for (let i = 0; i < bytes.length; i += 0x8000) {
              text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            }
            return btoa(text)
          }
          const checkRules = (rules: unknown) => {
            if (!Array.isArray(rules)) throw invalid()
            for (const rule of rules) {
              const error = checkArg({
                type: 'object',
                props: {
                  actions: { type: 'array' },
                  conditions: { type: 'array' },
                  id: { type: 'string' },
                  priority: { type: 'integer' },
                  tags: strings,
                },
                required: ['actions', 'conditions'],
              }, rule)
              if (error) throw invalid()
              for (const condition of rule.conditions) {
                if (condition?.instanceType !== PAGE_STATE_MATCHER || checkArg(specs[PAGE_STATE_MATCHER], condition)) {
                  throw invalid()
                }
              }
              for (const action of rule.actions) {
                const spec = action && specs[action.instanceType]
                if (!spec || action.instanceType === PAGE_STATE_MATCHER || checkArg(spec, action)) throw invalid()
              }
            }
          }
          const serialize = async (rules: any[]) =>
            Promise.all(
              rules.map(async (rule) => ({
                ...(rule.id !== undefined ? { id: rule.id } : {}),
                ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
                ...(rule.tags !== undefined ? { tags: [...rule.tags] } : {}),
                conditions: rule.conditions.map((c: any) => JSON.parse(JSON.stringify(c))),
                actions: await Promise.all(
                  rule.actions.map(async (action: any) => {
                    if (action.instanceType !== SET_ICON) return JSON.parse(JSON.stringify(action))
                    const imageData: Record<string, string> = {}
                    for (const [size, image] of Object.entries(action.imageData || {})) {
                      // An icon from getRules comes back as the base64 it was sent as.
                      imageData[size] = image instanceof ArrayBuffer ? toBase64(image) : String(image)
                    }
                    return { instanceType: SET_ICON, imageData }
                  }),
                ),
              })),
            )
          const checkIds = (ids: unknown) => {
            if (ids != null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) throw invalid()
          }
          const addRules = invokeExtension('declarativeContent.addRules')
          const getRules = invokeExtension('declarativeContent.getRules')
          const removeRules = invokeExtension('declarativeContent.removeRules')
          const report = (callback: unknown, promise: Promise<any>, withResult: boolean) => {
            promise.then(
              (result) => {
                if (typeof callback === 'function') callBack(callback, null, withResult ? [result] : [])
              },
              (error) => {
                if (typeof callback === 'function') callBack(callback, error, [])
                else console.error(`Unchecked runtime.lastError: ${errorText(error)}`)
              },
            )
          }
          // A declarative event: rules, and no listeners.
          class DeclarativeEvent {
            addRules(rules: unknown, callback?: unknown) {
              if (callback !== undefined && typeof callback !== 'function') throw invalid()
              checkRules(rules)
              report(callback, serialize(rules as any[]).then((list) => addRules(list)), true)
            }
            getRules(ids?: unknown, callback?: unknown) {
              if (typeof ids === 'function' && callback === undefined) {
                callback = ids
                ids = undefined
              }
              if (typeof callback !== 'function') throw invalid()
              checkIds(ids)
              report(callback, getRules(ids == null ? undefined : [...(ids as string[])]), true)
            }
            removeRules(ids?: unknown, callback?: unknown) {
              if (typeof ids === 'function' && callback === undefined) {
                callback = ids
                ids = undefined
              }
              if (callback !== undefined && typeof callback !== 'function') throw invalid()
              checkIds(ids)
              report(callback, removeRules(ids == null ? undefined : [...(ids as string[])]), false)
            }
          }
          return {
            PageStateMatcher,
            ShowAction,
            ShowPageAction,
            SetIcon,
            RequestContentScript,
            PageStateMatcherInstanceType: {},
            ShowActionInstanceType: {},
            ShowPageActionInstanceType: {},
            SetIconInstanceType: {},
            RequestContentScriptInstanceType: {},
            onPageChanged: new DeclarativeEvent(),
          }
        },
      },

      contextMenus: {
        permission: 'contextMenus',
        factory: (base) => {
          const CONTEXTS = ['action', 'all', 'audio', 'browser_action', 'editable', 'frame', 'image', 'launcher', 'link', 'page', 'page_action', 'selection', 'tab', 'video']
          const TYPES = ['checkbox', 'normal', 'radio', 'separator']
          const CREATE_SIG =
            'contextMenus.create(contextMenus.CreateProperties createProperties, optional function callback)'
          const UPDATE_SIG =
            'contextMenus.update([integer|string] id, object updateProperties, optional function callback)'
          const REMOVE_SIG = 'contextMenus.remove([integer|string] menuItemId, optional function callback)'
          // An event page or service worker gets no generated ids and no
          // onclick, as in Chrome: the main process says why.
          const lazy =
            manifest.manifest_version === 3 || (manifest as any).background?.persistent === false
          let menuCounter = 0
          const menuCallbacks = new Map<string, Function>()
          const callbackKey = (id: unknown) => `${typeof id}:${String(id)}`

          // Chrome's bindings check these before the call is made, and throw.
          const checkProps = (signature: string, param: string, props: any) => {
            const fail = (detail: string) =>
              new Error(`Error in invocation of ${signature}: Error at parameter '${param}': ${detail}`)
            if (props.type !== undefined && !TYPES.includes(props.type)) {
              throw fail(`Error at property 'type': Value must be one of ${TYPES.join(', ')}.`)
            }
            if (props.contexts !== undefined) {
              if (!Array.isArray(props.contexts)) {
                throw fail(`Error at property 'contexts': Invalid type: expected array, found ${typeof props.contexts}.`)
              }
              props.contexts.forEach((c: unknown, i: number) => {
                if (typeof c !== 'string' || !CONTEXTS.includes(c)) {
                  throw fail(`Error at property 'contexts': Error at index ${i}: Value must be one of ${CONTEXTS.join(', ')}.`)
                }
              })
            }
          }

          let hasInternalListener = false
          const addInternalListener = () => {
            api.onClicked.addListener((info: any, tab: any) => {
              const callback = menuCallbacks.get(callbackKey(info.menuItemId))
              if (callback && tab) callback(info, tab)
            })
            hasInternalListener = true
          }
          const takeOnclick = (id: unknown, props: any) => {
            if (typeof props.onclick !== 'function') return
            if (lazy) {
              props.onclick = true
              return
            }
            if (!hasInternalListener) addInternalListener()
            menuCallbacks.set(callbackKey(id), props.onclick)
            delete props.onclick
          }

          const menuCreate = invokeExtension('contextMenus.create')
          const menuUpdate = invokeExtension('contextMenus.update')
          const menuRemove = invokeExtension('contextMenus.remove')
          const menuRemoveAll = invokeExtension('contextMenus.removeAll')

          const api: any = {
            ...base,
            create: function (createProperties: any, callback?: Function) {
              if (!createProperties || typeof createProperties !== 'object' || Array.isArray(createProperties) ||
                (callback !== undefined && typeof callback !== 'function')) {
                throw new Error(`Error in invocation of ${CREATE_SIG}: No matching signature.`)
              }
              checkProps(CREATE_SIG, 'createProperties', createProperties)
              const props = { ...createProperties }
              if (props.id === undefined && !lazy) props.id = ++menuCounter
              takeOnclick(props.id, props)
              const done = menuCreate(props, ...(callback ? [callback] : []))
              if (!callback) done.catch(() => {})
              return props.id
            },
            update: function (id: any, updateProperties: any, callback?: Function) {
              if ((typeof id !== 'string' && typeof id !== 'number') || !updateProperties ||
                typeof updateProperties !== 'object' || (callback !== undefined && typeof callback !== 'function')) {
                throw new Error(`Error in invocation of ${UPDATE_SIG}: No matching signature.`)
              }
              checkProps(UPDATE_SIG, 'updateProperties', updateProperties)
              const props = { ...updateProperties }
              takeOnclick(id, props)
              return menuUpdate(id, props, ...(callback ? [callback] : []))
            },
            remove: function (id: any, callback?: Function) {
              if ((typeof id !== 'string' && typeof id !== 'number') || (callback !== undefined && typeof callback !== 'function')) {
                throw new Error(`Error in invocation of ${REMOVE_SIG}: No matching signature.`)
              }
              const result = menuRemove(id, ...(callback ? [callback] : []))
              Promise.resolve(result).then(() => menuCallbacks.delete(callbackKey(id)), () => {})
              return result
            },
            removeAll: function (callback?: Function) {
              menuCallbacks.clear()
              return menuRemoveAll(...(callback ? [callback] : []))
            },
            onClicked: new ExtensionEvent<
              (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
            >('contextMenus.onClicked'),
          }

          return api
        },
      },

      contentSettings: {
        permission: 'contentSettings',
        factory: (base) => {
          const api: any = { ...base }
          const types = [
            'automaticDownloads',
            'autoVerify',
            'camera',
            'clipboard',
            'cookies',
            'images',
            'javascript',
            'location',
            'microphone',
            'notifications',
            'popups',
            'sound',
          ]
          // One ContentSetting per type; the main process gets the type first.
          for (const type of types) {
            const call = (method: string) => {
              const invoke = invokeExtension(`contentSettings.${method}`)
              return (...args: any[]) => invoke(type, ...args)
            }
            const getResourceIdentifiers = call('getResourceIdentifiers')
            api[type] = {
              get: call('get'),
              set: call('set'),
              clear: call('clear'),
              // Chrome calls back with no arguments at all, not undefined.
              getResourceIdentifiers: (...args: any[]) => {
                const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
                if (!callback) return getResourceIdentifiers(...args)
                return getResourceIdentifiers(...args, () => callback())
              },
            }
          }
          // Gone from Chrome, which keeps them as calls that do nothing and
          // return nothing, not even a promise.
          const nothing = (...args: any[]) => {
            const callback = args[args.length - 1]
            if (typeof callback === 'function') setTimeout(() => callback(), 0)
            return undefined
          }
          for (const type of ['fullscreen', 'mouselock', 'plugins', 'unsandboxedPlugins']) {
            api[type] = { get: nothing, set: nothing, clear: nothing, getResourceIdentifiers: nothing }
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
          // A page keeps getBackgroundPage, which gives null without a
          // background page, as Chrome's does.
          if (contextKind === 'worker') {
            delete api.getViews
            delete api.getBackgroundPage
          }
          if (manifest.manifest_version === 3) {
            for (const name of ['getURL', 'getExtensionTabs', 'sendRequest', 'onRequest', 'onRequestExternal', 'lastError']) {
              delete api[name]
            }
          }
          return api
        },
      },

      identity: {
        permission: 'identity',
        factory: (base) => {
          const redirectBase = extensionId ? `https://${extensionId}.chromiumapp.org/` : ''
          return {
            ...base,
            getRedirectURL: (path?: unknown) => {
              if (path !== undefined && path !== null && typeof path !== 'string') {
                throw new Error(
                  'Error in invocation of identity.getRedirectURL(optional string path): No matching signature.',
                )
              }
              return path ? redirectBase + (path as string).replace(/^\//, '') : redirectBase
            },
            launchWebAuthFlow: invokeExtension('identity.launchWebAuthFlow'),
            getAuthToken: invokeExtension('identity.getAuthToken'),
            getProfileUserInfo: invokeExtension('identity.getProfileUserInfo'),
            getAccounts: invokeExtension('identity.getAccounts'),
            removeCachedAuthToken: invokeExtension('identity.removeCachedAuthToken'),
            clearAllCachedAuthTokens: invokeExtension('identity.clearAllCachedAuthTokens'),
            onSignInChanged: new ExtensionEvent('identity.onSignInChanged'),
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
            onPermissionLevelChanged: new ExtensionEvent('notifications.onPermissionLevelChanged'),
            onShowSettings: new ExtensionEvent('notifications.onShowSettings'),
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
            addHostAccessRequest: invokeExtension('permissions.addHostAccessRequest'),
            removeHostAccessRequest: invokeExtension('permissions.removeHostAccessRequest'),
            onAdded: new ExtensionEvent('permissions.onAdded'),
            onRemoved: new ExtensionEvent('permissions.onRemoved'),
          }
        },
      },

      privacy: {
        permission: 'privacy',
        factory: (base) => {
          // Chrome 157's settings on desktop; protectedContentEnabled is
          // Windows and ChromeOS only.
          const groups: Record<string, string[]> = {
            network: ['networkPredictionEnabled', 'webRTCIPHandlingPolicy'],
            services: [
              'alternateErrorPagesEnabled',
              'autofillAddressEnabled',
              'autofillCreditCardEnabled',
              'autofillEnabled',
              'autofillSettings',
              'passwordSavingEnabled',
              'safeBrowsingEnabled',
              'safeBrowsingExtendedReportingEnabled',
              'searchSuggestEnabled',
              'spellingServiceEnabled',
              'translationServiceEnabled',
            ],
            websites: [
              'adMeasurementEnabled',
              'doNotTrackEnabled',
              'fledgeEnabled',
              'hyperlinkAuditingEnabled',
              'referrersEnabled',
              'thirdPartyCookiesAllowed',
              'topicsEnabled',
            ],
          }
          const api: any = { ...base }
          for (const [group, names] of Object.entries(groups)) {
            api[group] = {}
            for (const name of names) api[group][name] = chromeSetting(`privacy.${group}.${name}`)
          }
          return api
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
          // Native messaging only with its permission, as in Chrome.
          if (!declared.has('nativeMessaging')) {
            delete patched.connectNative
            delete patched.sendNativeMessage
          }
          if (declared.has('nativeMessaging')) patched.connectNative = (application: string) => {
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
          if (declared.has('nativeMessaging')) {
            patched.sendNativeMessage = invokeExtension('runtime.sendNativeMessage')
          }
          patched.requestUpdateCheck = invokeExtension('runtime.requestUpdateCheck')
          // Electron never fires these. The main process does, once the
          // extension has added its listener.
          patched.onInstalled = new ExtensionEvent('runtime.onInstalled')
          patched.onStartup = new ExtensionEvent('runtime.onStartup')
          patched.onExtensionLoaded = new ExtensionEvent('runtime.onExtensionLoaded')
          patched.onEnabled = new ExtensionEvent('runtime.onEnabled')
          return patched
        },
      },

      storage: {
        permission: 'storage',
        factory: (base) => {
          // local, sync and managed are the shell's; session is Electron's own,
          // which is Chrome's code and is shared with content scripts. They
          // check their arguments the same way, here, before any call is made.
          const SIG: Record<string, string> = {
            get: 'get(optional [string|array|object] keys, optional function callback)',
            getKeys: 'getKeys(optional function callback)',
            set: 'set(object items, optional function callback)',
            remove: 'remove([string|array] keys, optional function callback)',
            clear: 'clear(optional function callback)',
            getBytesInUse: 'getBytesInUse(optional [string|array] keys, optional function callback)',
            setAccessLevel: 'setAccessLevel(object accessOptions, optional function callback)',
          }
          const fail = (method: string, detail = 'No matching signature.') =>
            new Error(`Error in invocation of storage.${SIG[method]}: ${detail}`)

          // Splits (args..., callback) as Chrome's bindings do, refusing more
          // arguments than the method takes.
          const split = (method: string, args: any[], max: number) => {
            while (args.length && args[args.length - 1] === undefined) args.pop()
            const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
            if (args.length > max) throw fail(method)
            return { args, callback }
          }

          // Values as Chrome's V8ValueConverter turns them into JSON: functions,
          // undefined and symbols are left out of objects and become null in
          // arrays, as do numbers that are not finite; dates, maps and the like
          // become {}; a cycle becomes null; nothing deeper than 100 levels.
          const SKIP = {}
          const BINARY = new Error('Cannot serialize value to JSON')
          const storable = (value: any, depth: number, ancestors: Set<any>): any => {
            if (value === null) return null
            switch (typeof value) {
              case 'boolean':
              case 'string':
                return value
              case 'number':
                return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : SKIP
              case 'object':
                break
              default:
                return SKIP
            }
            if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw BINARY
            if (depth > 100) return SKIP
            if (ancestors.has(value)) return null
            ancestors.add(value)
            try {
              if (Array.isArray(value)) {
                const out: any[] = []
                for (let i = 0; i < value.length; i++) {
                  const item = storable(value[i], depth + 1, ancestors)
                  out.push(item === SKIP ? null : item)
                }
                return out
              }
              const out: any = {}
              for (const key of Object.keys(value)) {
                let item: any
                try {
                  item = storable(value[key], depth + 1, ancestors)
                } catch (e) {
                  if (e === BINARY) throw e
                  continue
                }
                if (item !== SKIP) {
                  Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true })
                }
              }
              return out
            } finally {
              ancestors.delete(value)
            }
          }
          const storableItems = (items: any) => storable(items, 0, new Set())

          const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
          const isKeyList = (v: unknown) => Array.isArray(v) && v.every((k) => typeof k === 'string')

          // A rejection from a check that Chrome makes in the browser, which
          // reaches a callback as runtime.lastError rather than as a throw.
          const rejectLater = (error: Error, callback?: Function) => {
            if (!callback) return Promise.reject(error)
            const runtime = (globalThis as any).chrome?.runtime
            queueMicrotask(() => {
              if (runtime) runtime.lastError = { message: error.message }
              try {
                callback()
              } finally {
                if (runtime) delete runtime.lastError
              }
            })
            return undefined
          }

          const makeArea = (area: string, readOnly = false) => {
            const call = (method: string) => invokeExtension(`storage.${area}.${method}`)
            const run = (method: string, args: any[], callback?: Function) =>
              call(method)(...args, ...(callback ? [callback] : []))
            const api: any = {
              get(...raw: any[]) {
                const { args, callback } = split('get', raw, 1)
                const [keys] = args
                if (keys !== undefined && keys !== null && typeof keys !== 'string') {
                  if (Array.isArray(keys)) {
                    if (!isKeyList(keys)) throw fail('get', "Error at parameter 'keys': Value did not match any choice.")
                  } else if (!isObject(keys)) {
                    throw fail('get')
                  }
                }
                let wanted = keys
                if (isObject(keys)) {
                  try {
                    wanted = storableItems(keys)
                  } catch (e: any) {
                    return rejectLater(e, callback)
                  }
                }
                return run('get', [wanted === undefined ? null : wanted], callback)
              },
              getKeys(...raw: any[]) {
                const { callback } = split('getKeys', raw, 0)
                return run('getKeys', [], callback)
              },
              getBytesInUse(...raw: any[]) {
                const { args, callback } = split('getBytesInUse', raw, 1)
                const [keys] = args
                if (keys !== undefined && keys !== null && typeof keys !== 'string' && !isKeyList(keys)) {
                  throw fail('getBytesInUse')
                }
                return run('getBytesInUse', [keys === undefined ? null : keys], callback)
              },
              set(...raw: any[]) {
                const { args, callback } = split('set', raw, 1)
                const [items] = args
                if (!items || typeof items !== 'object' || Array.isArray(items)) throw fail('set')
                if (readOnly) return run('set', [{}], callback)
                let converted: any
                try {
                  converted = storableItems(items)
                } catch (e: any) {
                  return rejectLater(e, callback)
                }
                return run('set', [converted], callback)
              },
              remove(...raw: any[]) {
                const { args, callback } = split('remove', raw, 1)
                const [keys] = args
                if (typeof keys !== 'string' && !isKeyList(keys)) throw fail('remove')
                return run('remove', [keys], callback)
              },
              clear(...raw: any[]) {
                const { callback } = split('clear', raw, 0)
                return run('clear', [], callback)
              },
              setAccessLevel(...raw: any[]) {
                const { args, callback } = split('setAccessLevel', raw, 1)
                const [options] = args
                if (!isObject(options)) throw fail('setAccessLevel')
                const level = options.accessLevel
                if (level !== 'TRUSTED_AND_UNTRUSTED_CONTEXTS' && level !== 'TRUSTED_CONTEXTS') {
                  throw fail(
                    'setAccessLevel',
                    level === undefined
                      ? "Error at parameter 'accessOptions': Missing required property 'accessLevel'."
                      : "Error at parameter 'accessOptions': Error at property 'accessLevel': Value must be one of TRUSTED_AND_UNTRUSTED_CONTEXTS, TRUSTED_CONTEXTS.",
                  )
                }
                return run('setAccessLevel', [{ accessLevel: level }], callback)
              },
            }
            return api
          }

          // storage.onChanged hears the shell's areas from the main process,
          // and Electron's own areas from Electron: session, and the local
          // store content scripts write to, whose changes an extension's
          // worker listens for. The two never report the same write.
          const shellChanged = new ExtensionEvent('storage.onChanged')
          const nativeChanged = (base as any)?.onChanged
          const makeEvent = (only?: string) => {
            const wrappers = new Map<Function, { shell: Function; native: Function }>()
            return {
              addListener(callback: Function) {
                if (typeof callback !== 'function' || wrappers.has(callback)) return
                const shell = (changes: any, area: string) => {
                  if (only && area !== only) return
                  if (only) callback(changes)
                  else callback(changes, area)
                }
                const native = (changes: any, area: string) => {
                  if (only && area !== only) return
                  if (only) callback(changes)
                  else callback(changes, area)
                }
                wrappers.set(callback, { shell, native })
                shellChanged.addListener(shell as any)
                try {
                  nativeChanged?.addListener?.(native)
                } catch {}
              },
              removeListener(callback: Function) {
                const wrapper = wrappers.get(callback)
                if (!wrapper) return
                wrappers.delete(callback)
                shellChanged.removeListener(wrapper.shell as any)
                try {
                  nativeChanged?.removeListener?.(wrapper.native)
                } catch {}
              },
              hasListener: (callback: Function) => wrappers.has(callback),
              hasListeners: () => wrappers.size > 0,
            }
          }

          const local = makeArea('local')
          local.onChanged = makeEvent('local')
          const sync = makeArea('sync')
          sync.onChanged = makeEvent('sync')
          const managed = makeArea('managed', true)
          managed.onChanged = makeEvent('managed')

          // Electron's own session area, with the same onChanged as the others.
          const nativeSession = (base as any)?.session
          let session: any = nativeSession
          if (nativeSession) {
            session = {}
            for (const key of ['get', 'getKeys', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel']) {
              if (typeof nativeSession[key] === 'function') session[key] = nativeSession[key].bind(nativeSession)
            }
            if ('QUOTA_BYTES' in nativeSession) session.QUOTA_BYTES = nativeSession.QUOTA_BYTES
            session.onChanged = makeEvent('session')
          }

          return {
            ...base,
            onChanged: makeEvent(),
            local,
            sync,
            managed,
            session,
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
    // Chromium sets its own bindings on `chrome` again whenever an extension
    // loads or unloads in the session, which put Electron's back in place of
    // these in every running service worker. It cannot replace a property
    // that is not configurable, so the namespaces on `chrome` itself are not.
    const ownRoots = new WeakSet<object>()
    const defineOn = (node: any, key: string, value: any, root: any) =>
      Object.defineProperty(node, key, {
        value,
        enumerable: true,
        configurable: node !== root,
        writable: true,
      })
    const setPath = (root: any, dotted: string, value: any) => {
      const parts = dotted.split('.')
      let node = root
      for (const part of parts.slice(0, -1)) {
        let next = node[part]
        if (!next || typeof next !== 'object' || (node === root && !ownRoots.has(next))) {
          const copy: any = {}
          if (next && typeof next === 'object') {
            for (const key of Object.keys(next)) {
              try {
                copy[key] = next[key]
              } catch {}
            }
          }
          defineOn(node, part, copy, root)
          if (node === root) ownRoots.add(copy)
          next = copy
        }
        node = next
      }
      defineOn(node, parts[parts.length - 1], value, root)
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
      // An offscreen document gets chrome.runtime and nothing else, as in Chrome.
      if (context.offscreen && apiName !== 'runtime') {
        deletePath(chrome, apiName)
        continue
      }
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
              // As on `chrome`: Chromium would put its own bindings back.
              configurable: false,
              writable: true,
            })
          } else if (root in browserAlias) {
            delete browserAlias[root]
          }
        } catch (_) {}
      }
    }

    // Chrome's old page timing functions, which some code checks for to tell
    // it runs in Chrome. Electron leaves them out. A worker has no navigation,
    // so its times are those of its start.
    const navigationEntry = (): any => {
      try {
        return (performance.getEntriesByType?.('navigation') || [])[0]
      } catch {
        return undefined
      }
    }
    const epochSeconds = (ms?: number) =>
      typeof ms === 'number' && ms > 0 ? (performance.timeOrigin + ms) / 1000 : 0
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = function loadTimes() {
        const nav = navigationEntry()
        return {
          requestTime: epochSeconds(nav?.requestStart) || performance.timeOrigin / 1000,
          startLoadTime: performance.timeOrigin / 1000,
          commitLoadTime: epochSeconds(nav?.responseStart),
          finishDocumentLoadTime: epochSeconds(nav?.domContentLoadedEventEnd),
          finishLoadTime: epochSeconds(nav?.loadEventEnd),
          firstPaintTime: 0,
          firstPaintAfterLoadTime: 0,
          navigationType:
            nav?.type === 'reload' ? 'Reload' : nav?.type === 'back_forward' ? 'BackForward' : 'Other',
          wasFetchedViaSpdy: nav?.nextHopProtocol === 'h2',
          wasNpnNegotiated: !!nav?.nextHopProtocol && nav.nextHopProtocol !== 'http/1.1',
          npnNegotiatedProtocol: nav?.nextHopProtocol || 'unknown',
          wasAlternateProtocolAvailable: false,
          connectionInfo: nav?.nextHopProtocol || 'unknown',
        }
      }
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = function csi() {
        const nav = navigationEntry()
        return {
          startE: Math.round(performance.timeOrigin),
          onloadT: nav?.loadEventEnd ? Math.round(performance.timeOrigin + nav.loadEventEnd) : 0,
          pageT: performance.now(),
          tran: 15,
        }
      }
    }

    // Remove access to internals

    if (context.offscreen) {
      // Electron's own namespaces too; Chrome's page timing functions stay.
      for (const key of Object.keys(chrome)) {
        if (key === 'runtime' || key === 'csi' || key === 'loadTimes') continue
        try {
          delete chrome[key]
        } catch {}
      }
    }

    delete (globalThis as any).electron

    // Chrome does not freeze the chrome object, and extensions rely on that:
    // compatibility shims assign to it (e.g. `chrome.browserAction = chrome.action`),
    // which throws in strict-mode module workers when frozen and fails the
    // service worker's script evaluation (registration status 15).

    void 0 // no return
  }

  // Which kind of extension page this is, which only the main process knows:
  // an offscreen document gets a smaller chrome object. Asked once, while the
  // page loads, before any of its scripts run.
  let context: { offscreen?: boolean } = {}
  if (process.type !== 'service-worker') {
    try {
      context = ipcRenderer.sendSync('crx-context-info') || {}
    } catch {}
  }

  if (!process.contextIsolated) {
    console.warn(`injectExtensionAPIs: context isolation disabled in ${location.href}`)
    mainWorldScript(API_CONSTANTS, API_SCHEMA, context)
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
        args: [API_CONSTANTS, API_SCHEMA, context],
      })
    } else {
      // TODO(mv3): remove webFrame usage
      webFrame.executeJavaScript(
        `(${mainWorldScript})(${JSON.stringify(API_CONSTANTS)}, ${JSON.stringify(API_SCHEMA)}, ${JSON.stringify(context)});`,
      )
    }
  } catch (error) {
    console.error(`injectExtensionAPIs error (${location.href})`)
    console.error(error)
  }
}
