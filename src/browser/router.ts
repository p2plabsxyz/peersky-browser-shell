import { app, ipcMain, Session } from 'electron'
import debug from 'debug'

import { resolvePartition } from './partition'
import type { ExtensionPermissions } from './permissions'

/** What the calling context adds to a call, besides its arguments. */
export interface CallMeta {
  /** The call came while the page had a user gesture (a click, a key press). */
  gesture?: boolean
}

const normalizeMeta = (meta: unknown): CallMeta =>
  meta && typeof meta === 'object' ? { gesture: (meta as CallMeta).gesture === true } : {}

/**
 * The permission each API namespace needs, as Chrome hides the namespace from
 * an extension without it. Handlers may name their own instead. Namespaces
 * missing here (tabs, windows, runtime, permissions, ...) need none.
 */
const NAMESPACE_PERMISSIONS: Record<string, string | string[]> = {
  alarms: 'alarms',
  bookmarks: 'bookmarks',
  browsingData: 'browsingData',
  contentSettings: 'contentSettings',
  contextMenus: 'contextMenus',
  cookies: 'cookies',
  debugger: 'debugger',
  declarativeContent: 'declarativeContent',
  declarativeNetRequest: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'],
  desktopCapture: 'desktopCapture',
  downloads: 'downloads',
  fontSettings: 'fontSettings',
  history: 'history',
  identity: 'identity',
  idle: 'idle',
  notifications: 'notifications',
  offscreen: 'offscreen',
  pageCapture: 'pageCapture',
  power: 'power',
  privacy: 'privacy',
  proxy: 'proxy',
  readingList: 'readingList',
  scripting: 'scripting',
  search: 'search',
  sessions: 'sessions',
  sidePanel: 'sidePanel',
  storage: 'storage',
  'system.cpu': 'system.cpu',
  'system.display': 'system.display',
  'system.memory': 'system.memory',
  'system.storage': 'system.storage',
  tabCapture: 'tabCapture',
  tabGroups: 'tabGroups',
  topSites: 'topSites',
  tts: 'tts',
  userScripts: 'userScripts',
  webNavigation: 'webNavigation',
  webRequest: 'webRequest',
}

/** The permission a handler such as 'storage.local.get' needs, if any. */
export const permissionForHandler = (handlerName: string): string | string[] | undefined => {
  const [first, second] = handlerName.split('.')
  return NAMESPACE_PERMISSIONS[`${first}.${second}`] ?? NAMESPACE_PERMISSIONS[first]
}

// Shorten base64 encoded icons
const shortenValues = (k: string, v: any) =>
  typeof v === 'string' && v.length > 128 ? v.substr(0, 128) + '...' : v

debug.formatters.r = (value: any) => {
  return value ? JSON.stringify(value, shortenValues, '  ') : value
}

/**
 * How long to leave an extension's service worker alone after it fails to start.
 *
 * A worker that cannot start cannot start for the next event either, and a busy
 * extension is the target of many events a second, so retrying per event costs a
 * round trip each time and produces a line of output each time.
 */
const SW_START_RETRY_DELAY_MS = 30_000

export type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainServiceWorkerEvent
export type IpcInvokeEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainServiceWorkerInvokeEvent
export type IpcAnyEvent = IpcEvent | IpcInvokeEvent

const getSessionFromEvent = (event: IpcAnyEvent): Electron.Session => {
  if (event.type === 'service-worker') {
    return event.session
  } else {
    return event.sender.session
  }
}

/** The page or worker an IPC came from. */
const eventSenderUrl = (event: IpcAnyEvent): string | undefined => {
  try {
    if (event.type === 'service-worker') return (event as any).serviceWorker?.scope
    return (event as any).senderFrame?.url
  } catch {
    return undefined
  }
}

/** Events that need a permission their namespace does not need for its calls. */
const EVENT_PERMISSIONS: Record<string, string> = {
  'management.onDisabled': 'management',
  'management.onEnabled': 'management',
  'management.onInstalled': 'management',
  'management.onUninstalled': 'management',
}

const getHostFromEvent = (event: IpcAnyEvent) => {
  if (event.type === 'service-worker') {
    return event.serviceWorker
  } else {
    return event.sender
  }
}

const d = debug('electron-chrome-extensions:router')

const DEFAULT_SESSION = '_self'

interface RoutingDelegateObserver {
  session: Electron.Session
  onExtensionMessage(
    event: Electron.IpcMainInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    meta: CallMeta,
    ...args: any[]
  ): Promise<void>
  addListener(listener: EventListener, extensionId: string, eventName: string, senderUrl?: string): void
  removeListener(listener: EventListener, extensionId: string, eventName: string, senderUrl?: string): void
}

let gRoutingDelegate: RoutingDelegate

/**
 * Handles event routing IPCs and delivers them to the observer with the
 * associated session.
 */
class RoutingDelegate {
  static get() {
    return gRoutingDelegate || (gRoutingDelegate = new RoutingDelegate())
  }

  private sessionMap: WeakMap<Session, RoutingDelegateObserver> = new WeakMap()
  private workers: WeakSet<any> = new WeakSet()

  private constructor() {
    ipcMain.handle('crx-msg', this.onRouterMessage)
    ipcMain.handle('crx-msg-remote', this.onRemoteMessage)
    ipcMain.on('crx-add-listener', this.onAddListener)
    ipcMain.on('crx-remove-listener', this.onRemoveListener)
  }

  addObserver(observer: RoutingDelegateObserver) {
    this.sessionMap.set(observer.session, observer)

    const maybeListenForWorkerEvents = ({
      runningStatus,
      versionId,
    }: Electron.Event<Electron.ServiceWorkersRunningStatusChangedEventParams>) => {
      if (runningStatus !== 'starting') return

      const serviceWorker = (observer.session as any).serviceWorkers.getWorkerFromVersionID(
        versionId,
      )
      if (
        serviceWorker?.scope?.startsWith('chrome-extension://') &&
        !this.workers.has(serviceWorker)
      ) {
        d(`listening to service worker [versionId:${versionId}, scope:${serviceWorker.scope}]`)
        this.workers.add(serviceWorker)
        serviceWorker.ipc.handle('crx-msg', this.onRouterMessage)
        serviceWorker.ipc.handle('crx-msg-remote', this.onRemoteMessage)
        serviceWorker.ipc.on('crx-add-listener', this.onAddListener)
        serviceWorker.ipc.on('crx-remove-listener', this.onRemoveListener)
      }
    }
    observer.session.serviceWorkers.on('running-status-changed', maybeListenForWorkerEvents)
  }

  private onRouterMessage = async (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    handlerName: string,
    meta: CallMeta,
    ...args: any[]
  ) => {
    d(`received '${handlerName}'`, args)

    const observer = this.sessionMap.get(getSessionFromEvent(event))
    if (!observer) return undefined

    try {
      return await observer.onExtensionMessage(
        event,
        extensionId,
        handlerName,
        normalizeMeta(meta),
        ...args,
      )
    } catch (err) {
      // The extension sees the failure as a rejected promise or as
      // runtime.lastError, with the message Chrome gives.
      d('handler failed for %s: %o', handlerName, err)
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  }

  private onRemoteMessage = async (
    event: Electron.IpcMainInvokeEvent,
    sessionPartition: string,
    handlerName: string,
    ...args: any[]
  ) => {
    d(`received remote '${handlerName}' for '${sessionPartition}'`, args)

    const ses =
      sessionPartition === DEFAULT_SESSION
        ? getSessionFromEvent(event)
        : resolvePartition(sessionPartition)

    const observer = this.sessionMap.get(ses)

    return observer?.onExtensionMessage(event, undefined, handlerName, {}, ...args)
  }

  private onAddListener = (event: IpcAnyEvent, extensionId: string, eventName: string) => {
    const observer = this.sessionMap.get(getSessionFromEvent(event))
    const listener: EventListener =
      event.type === 'frame'
        ? {
            type: event.type,
            extensionId,
            host: event.sender,
          }
        : {
            type: event.type,
            extensionId,
          }
    return observer?.addListener(listener, extensionId, eventName, eventSenderUrl(event))
  }

  private onRemoveListener = (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    eventName: string,
  ) => {
    const observer = this.sessionMap.get(getSessionFromEvent(event))
    const listener: EventListener =
      event.type === 'frame'
        ? {
            type: event.type,
            extensionId,
            host: event.sender,
          }
        : {
            type: event.type,
            extensionId,
          }
    return observer?.removeListener(listener, extensionId, eventName, eventSenderUrl(event))
  }
}

export type ExtensionSender = Electron.WebContents | Electron.ServiceWorkerMain
// export interface ExtensionSender {
//   id?: number
//   ipc: Electron.IpcMain | Electron.IpcMainServiceWorker
//   send: Electron.WebFrameMain['send']
// }

type ExtendedExtension = Omit<Electron.Extension, 'manifest'> & {
  manifest: chrome.runtime.Manifest
}

export type ExtensionEvent = (
  | { type: 'frame'; sender: Electron.WebContents; extension: ExtendedExtension }
  | { type: 'service-worker'; sender: Electron.ServiceWorkerMain; extension: ExtendedExtension }
) & {
  /** The calling page had a user gesture when it made the call. */
  gesture?: boolean
}

export type HandlerCallback = (event: ExtensionEvent, ...args: any[]) => any

export interface HandlerOptions {
  /** Whether the handler can be invoked on behalf of a different session. */
  allowRemote?: boolean
  /** Whether an extension context is required to invoke the handler. */
  extensionContext: boolean
  /**
   * Permission the handler needs; any one of a list will do. Defaults to the
   * namespace's permission. `null` needs none, for the few calls Chrome
   * allows without it, such as management.getSelf.
   */
  permission?: chrome.runtime.ManifestPermissions | string | string[] | null
}

interface Handler extends HandlerOptions {
  callback: HandlerCallback
}

/** e.g. 'tabs.query' */
type EventName = string

type HandlerMap = Map<EventName, Handler>

type FrameEventListener = { type: 'frame'; host: Electron.WebContents; extensionId: string }
type SWEventListener = { type: 'service-worker'; extensionId: string }
type EventListener = FrameEventListener | SWEventListener

const getHostId = (host: FrameEventListener['host']) => host.id
const getHostUrl = (host: FrameEventListener['host']) => host.getURL?.()

const eventListenerEquals = (a: EventListener) => (b: EventListener) => {
  if (a === b) return true
  if (a.extensionId !== b.extensionId) return false
  if (a.type !== b.type) return false
  if (a.type === 'frame' && b.type === 'frame') {
    return a.host === b.host
  }
  return true
}

/**
 * Events where delaying SW delivery by 200ms can miss first paint / scriptlets.
 * Only speeds up delivery when a listener is already registered — never wakes idle SWs.
 * Every webRequest event goes at once, so a listener sees a request's stages
 * in the order Chrome gives them.
 */
function isUrgentNavigationEvent(eventName: string) {
  return (
    // storage.session changes reach the worker at once from Electron, so the
    // shell's areas must not wait either, or a worker hears them out of order.
    eventName === 'storage.onChanged' ||
    eventName.startsWith('webNavigation.') ||
    eventName.startsWith('webRequest.')
  )
}

export class ExtensionRouter {
  private handlers: HandlerMap = new Map()
  private listeners: Map<EventName, EventListener[]> = new Map()
  private permissions?: ExtensionPermissions
  /** Events that wait for the extension to add a listener: `${extensionId} ${eventName}`. */
  private waiting: Map<string, { args: any[]; expires: number }[]> = new Map()

  /**
   * Collection of all extension hosts in the session.
   *
   * Currently the router has no ability to wake up non-persistent background
   * scripts to deliver events. For now we just hold a reference to them to
   * prevent them from being terminated.
   */
  private extensionHosts: Set<Electron.WebContents> = new Set()
  /** extensionId -> when to retry its worker, and what was dropped meanwhile */
  private swStartFailures: Map<string, { retryAfter: number; suppressed: number }> = new Map()

  private extensionWorkers: Set<any> = new Set()

  constructor(
    public session: Electron.Session,
    private delegate: RoutingDelegate = RoutingDelegate.get(),
  ) {
    this.delegate.addObserver(this)

    const sessionExtensions = session.extensions || session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.filterListeners((listener) => listener.extensionId !== extension.id)
    })

    app.on('web-contents-created', (event, webContents) => {
      if (webContents.session === this.session && webContents.getType() === 'backgroundPage') {
        d(`storing reference to background host [url:'${webContents.getURL()}']`)
        this.extensionHosts.add(webContents)
      }
    })

    session.serviceWorkers.on(
      'running-status-changed' as any,
      ({ runningStatus, versionId }: any) => {
        if (runningStatus !== 'starting') return

        const serviceWorker = (session as any).serviceWorkers.getWorkerFromVersionID(versionId)
        if (!serviceWorker) return

        const { scope } = serviceWorker
        if (!scope.startsWith('chrome-extension:')) return

        if (this.extensionHosts.has(serviceWorker)) {
          d('%s running status changed to %s', scope, runningStatus)
        } else {
          d(`storing reference to background service worker [url:'${scope}']`)
          this.extensionWorkers.add(serviceWorker)
        }
      },
    )
  }

  private filterListeners(predicate: (listener: EventListener) => boolean) {
    for (const [eventName, listeners] of this.listeners) {
      const filteredListeners = listeners.filter(predicate)
      const delta = listeners.length - filteredListeners.length

      if (filteredListeners.length > 0) {
        this.listeners.set(eventName, filteredListeners)
      } else {
        this.listeners.delete(eventName)
      }

      if (delta > 0) {
        d(`removed ${delta} listener(s) for '${eventName}'`)
      }
    }
  }

  private observeListenerHost(host: FrameEventListener['host']) {
    const hostId = getHostId(host)
    d(`observing listener [id:${hostId}, url:'${getHostUrl(host)}']`)
    host.once('destroyed', () => {
      d(`extension host destroyed [id:${hostId}]`)
      this.filterListeners((listener) => listener.type !== 'frame' || listener.host !== host)
    })
  }

  addListener(listener: EventListener, extensionId: string, eventName: string, senderUrl?: string) {
    const { listeners, session } = this

    const sessionExtensions = session.extensions || session
    const extension = sessionExtensions.getExtension(extensionId)
    if (!extension) {
      throw new Error(`extension not registered in session [extensionId:${extensionId}]`)
    }

    // An extension listens only as itself, and only to events of APIs it
    // holds the permission for: the event's name comes from its own page,
    // which could ask for any.
    if (senderUrl !== undefined && !senderUrl.startsWith(`chrome-extension://${extensionId}/`)) {
      d(`ignoring '${eventName}' listener: sent from outside ${extensionId}`)
      return
    }
    if (!this.mayHear(extension, eventName)) {
      d(`ignoring '${eventName}' listener: ${extensionId} lacks the permission`)
      return
    }

    if (!listeners.has(eventName)) {
      listeners.set(eventName, [])
    }

    const eventListeners = listeners.get(eventName)!
    const existingEventListener = eventListeners.find(eventListenerEquals(listener))

    if (existingEventListener) {
      d(`ignoring existing '${eventName}' event listener for ${extensionId}`)
    } else {
      d(`adding '${eventName}' event listener for ${extensionId}`)
      eventListeners.push(listener)
      if (listener.type === 'frame' && listener.host) {
        this.observeListenerHost(listener.host)
      }
    }

    // A worker that adds a listener is running, whatever an earlier start
    // attempt said: forget that failure, or its events would wait it out.
    if (listener.type === 'service-worker') this.swStartFailures.delete(extensionId)

    const key = `${extensionId} ${eventName}`
    const waiting = this.waiting.get(key)
    if (waiting) {
      this.waiting.delete(key)
      const now = Date.now()
      for (const entry of waiting) {
        if (entry.expires < now) continue
        this.deliverToServiceWorkerOrHost(listener, extensionId, `crx-${eventName}`, entry.args, 0)
      }
    }
  }

  /** Whether the extension has a listener for the event now, in any of its contexts. */
  hasListener(extensionId: string, eventName: string) {
    return !!this.listeners.get(eventName)?.some((l) => l.extensionId === extensionId)
  }

  /**
   * Sends an event that the extension may not be listening for yet, such as
   * runtime.onInstalled, which fires before its service worker has run. The
   * event goes to listeners there now, or else to the first one added within
   * `waitMs`.
   */
  sendEventWhenListening(extensionId: string, eventName: string, args: any[], waitMs = 30_000) {
    const hasListener = this.listeners.get(eventName)?.some((l) => l.extensionId === extensionId)
    if (hasListener) {
      this.sendEvent(extensionId, eventName, ...args)
      return
    }
    const key = `${extensionId} ${eventName}`
    const list = this.waiting.get(key) || []
    list.push({ args, expires: Date.now() + waitMs })
    this.waiting.set(key, list)
    // Starting the worker runs its top-level code, which adds the listener. It
    // may not be registered yet; it starts by itself then, so a failure here
    // is not one to remember.
    this.session.serviceWorkers
      .startWorkerForScope(`chrome-extension://${extensionId}/`)
      .catch(() => {})
  }

  /**
   * Start an extension's service worker so an event can be delivered to it.
   *
   * Resolves null when there is nothing to deliver to — either the worker just
   * failed to start, or it is inside the retry delay from an earlier failure.
   * Callers treat that as "not delivered" rather than as an error to report,
   * because reporting is handled here, once per retry window rather than once
   * per event.
   */
  private async startExtensionWorker(extensionId: string, eventName: string) {
    const failure = this.swStartFailures.get(extensionId)
    if (failure && Date.now() < failure.retryAfter) {
      failure.suppressed++
      d('skipping service worker start for %s (%s): within retry delay', extensionId, eventName)
      return null
    }

    // A worker that has added listeners exists; right after an extension
    // loads it may still be installing, and starting it fails until it is
    // active. Keep trying for a few seconds then, rather than dropping events.
    const attempts = this.hasWorkerListener(extensionId) ? 25 : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const serviceWorker = await this.session.serviceWorkers.startWorkerForScope(
          `chrome-extension://${extensionId}/`,
        )
        const recovered = this.swStartFailures.get(extensionId)
        if (recovered) {
          this.swStartFailures.delete(extensionId)
          console.log(
            `[electron-chrome-extensions] service worker for ${extensionId} started; ` +
              `${recovered.suppressed} event(s) were dropped while it was down`,
          )
        }
        return serviceWorker
      } catch (error) {
        lastError = error
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    this.reportWorkerStartFailure(extensionId, eventName, lastError)
    return null
  }

  private hasWorkerListener(extensionId: string) {
    for (const list of this.listeners.values()) {
      if (list.some((l) => l.type === 'service-worker' && l.extensionId === extensionId)) return true
    }
    return false
  }

  /**
   * Report a worker that would not start, naming it and what it cost.
   *
   * Only reached on an actual attempt, and attempts are spaced by
   * SW_START_RETRY_DELAY_MS, so a permanently broken worker costs one line per
   * retry window instead of one per event.
   */
  private reportWorkerStartFailure(extensionId: string, eventName: string, error: unknown) {
    const previous = this.swStartFailures.get(extensionId)
    const suppressed = previous?.suppressed ?? 0
    this.swStartFailures.set(extensionId, {
      retryAfter: Date.now() + SW_START_RETRY_DELAY_MS,
      suppressed: 0,
    })

    const dropped = suppressed > 0 ? ` and ${suppressed} further event(s)` : ''
    const cause = error instanceof Error ? error.message : String(error)
    console.error(
      `[electron-chrome-extensions] service worker for ${extensionId} failed to start, so ` +
        `'${eventName}'${dropped} did not reach it. Retrying in ${SW_START_RETRY_DELAY_MS / 1000}s. ` +
        `Cause: ${cause}`,
    )
  }

  private deliverToServiceWorkerOrHost(
    listener: EventListener,
    extensionId: string,
    ipcName: string,
    args: any[],
    delayMs: number,
  ) {
    if (listener.type === 'service-worker') {
      const argsCopy = [...args]
      void this.startExtensionWorker(extensionId, ipcName).then((serviceWorker) => {
        if (!serviceWorker) return
        const send = () => {
          if ((serviceWorker as any).isDestroyed?.()) return
          try {
            serviceWorker.send(ipcName, ...argsCopy)
          } catch (err) {
            d('service worker send failed for %s: %o', ipcName, err)
          }
        }
        if (delayMs > 0) setTimeout(send, delayMs)
        else send()
      })
      return
    }

    if (listener.host.isDestroyed()) return
    try {
      listener.host.send(ipcName, ...args)
    } catch (err) {
      d('send %s to extension %s failed: %o', ipcName, extensionId, err)
    }
  }

  removeListener(listener: EventListener, extensionId: string, eventName: string, senderUrl?: string) {
    if (senderUrl !== undefined && !senderUrl.startsWith(`chrome-extension://${extensionId}/`)) return
    const { listeners } = this

    const eventListeners = listeners.get(eventName)
    if (!eventListeners) {
      console.error(`event listener not registered for '${eventName}'`)
      return
    }

    const index = eventListeners.findIndex(eventListenerEquals(listener))

    if (index >= 0) {
      d(`removing '${eventName}' event listener for ${extensionId}`)
      eventListeners.splice(index, 1)
    }

    if (eventListeners.length === 0) {
      listeners.delete(eventName)
    }
  }

  /** Whether the extension holds the permission an event needs, now. */
  private mayHear(extension: Electron.Extension | string, eventName: string) {
    const required = EVENT_PERMISSIONS[eventName] ?? permissionForHandler(eventName)
    if (!required) return true
    const ext =
      typeof extension === 'string'
        ? (this.session.extensions || this.session).getExtension(extension)
        : extension
    if (!ext) return false
    const anyOf = Array.isArray(required) ? required : [required]
    return anyOf.some((p) => this.hasPermission(ext, p))
  }

  private getHandler(handlerName: string) {
    const handler = this.handlers.get(handlerName)
    if (!handler) {
      throw new Error(`${handlerName} is not a registered handler`)
    }

    return handler
  }

  /** The session's permissions, which every handler call is checked against. */
  setPermissions(permissions: ExtensionPermissions) {
    this.permissions = permissions
  }

  /**
   * Where the call came from. An extension may only call as itself: its id
   * must be the origin of the page or worker that sent the call.
   */
  private senderUrl(event: IpcInvokeEvent): string | undefined {
    if (event.type === 'service-worker') return event.serviceWorker?.scope
    try {
      return (event as Electron.IpcMainInvokeEvent).senderFrame?.url
    } catch {
      return undefined
    }
  }

  async onExtensionMessage(
    event: IpcInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    meta: CallMeta,
    ...args: any[]
  ) {
    const { session } = this
    const eventSession = getSessionFromEvent(event)
    const eventSessionExtensions = eventSession.extensions || eventSession
    const handler = this.getHandler(handlerName)

    if (eventSession !== session && !handler.allowRemote) {
      throw new Error(`${handlerName} does not support calling from a remote session`)
    }

    const extension = extensionId ? eventSessionExtensions.getExtension(extensionId) : undefined
    if (!extension && handler.extensionContext) {
      throw new Error(`${handlerName} was sent from an unknown extension context`)
    }

    if (extension) {
      const from = this.senderUrl(event)
      if (!from || !from.startsWith(`chrome-extension://${extension.id}/`)) {
        throw new Error(`${handlerName} was sent from outside the extension`)
      }
    }

    const required = handler.permission === undefined ? permissionForHandler(handlerName) : handler.permission
    if (required) {
      const anyOf = Array.isArray(required) ? required : [required]
      const allowed = !!extension && anyOf.some((p) => this.hasPermission(extension, p))
      if (!allowed) {
        throw new Error(`'${handlerName}' requires the '${anyOf[0]}' permission.`)
      }
    }

    // Some handlers allow calls without a loaded extension context.
    const extensionForEvent = extension ?? (extensionId ? { id: extensionId, manifest: {} } as ExtendedExtension : undefined)
    const gesture = meta?.gesture === true
    const extEvent: ExtensionEvent =
      event.type === 'frame'
        ? { type: event.type, sender: event.sender, extension: extensionForEvent!, gesture }
        : { type: event.type, sender: event.serviceWorker, extension: extensionForEvent!, gesture }

    const result = await handler.callback(extEvent, ...args)

    d(`${handlerName} result: %r`, result)

    return result
  }

  private hasPermission(extension: Electron.Extension, permission: string) {
    if (this.permissions) return this.permissions.has(extension, permission)
    return !!(extension.manifest as chrome.runtime.Manifest).permissions?.includes(permission as any)
  }

  private handle(name: string, callback: HandlerCallback, opts?: Partial<HandlerOptions>): void {
    const permission = opts?.permission
    this.handlers.set(name, {
      callback,
      extensionContext: typeof opts?.extensionContext === 'boolean' ? opts.extensionContext : true,
      allowRemote: typeof opts?.allowRemote === 'boolean' ? opts.allowRemote : false,
      permission:
        permission === null || typeof permission === 'string' || Array.isArray(permission)
          ? permission
          : undefined,
    })
  }

  /** Returns a callback to register API handlers for the given context. */
  apiHandler() {
    return (name: string, callback: HandlerCallback, opts?: Partial<HandlerOptions>) => {
      this.handle(name, callback, opts)
    }
  }

  /**
   * Sends extension event to the host for the given extension ID if it
   * registered a listener for it.
   */
  sendEvent(targetExtensionId: string | undefined, eventName: string, ...args: any[]) {
    const { listeners } = this
    const eventListeners = listeners.get(eventName)
    const ipcName = `crx-${eventName}`
    const swDelayMs = isUrgentNavigationEvent(eventName) ? 0 : 200

    if (!eventListeners || eventListeners.length === 0) {
      d(`sendEvent: no listeners for '${eventName}' (extension: ${targetExtensionId ?? 'any'})`)
      this.deliverToTargetExtensionWhenNoListener(targetExtensionId, eventName, ipcName, args)
      return
    }

    const deadListeners: EventListener[] = []
    let matchedCount = 0
    let sentCount = 0
    let serviceWorkerAsync = 0
    const allowed = new Map<string, boolean>()
    const mayHear = (extensionId: string) => {
      if (!allowed.has(extensionId)) allowed.set(extensionId, this.mayHear(extensionId, eventName))
      return allowed.get(extensionId)!
    }
    for (const listener of eventListeners) {
      const { type, extensionId } = listener

      if (targetExtensionId && targetExtensionId !== extensionId) {
        continue
      }
      // A permission given up since the listener was added counts too.
      if (!mayHear(extensionId)) continue
      matchedCount++

      if (type === 'service-worker') {
        serviceWorkerAsync++
        this.deliverToServiceWorkerOrHost(listener, extensionId, ipcName, args, swDelayMs)
      } else {
        if (listener.host.isDestroyed()) {
          deadListeners.push(listener)
          continue
        }
        try {
          listener.host.send(ipcName, ...args)
          sentCount++
        } catch (err) {
          d('send %s to extension %s failed (host may be tearing down): %o', eventName, extensionId, err)
          deadListeners.push(listener)
        }
      }
    }

    if (deadListeners.length > 0) {
      const deadSet = new Set(deadListeners)
      const filtered = eventListeners.filter((l) => !deadSet.has(l))
      if (filtered.length > 0) {
        listeners.set(eventName, filtered)
      } else {
        listeners.delete(eventName)
      }
      d(`removed ${deadListeners.length} dead listener(s) for '${eventName}'`)
    }

    // Only fall back when we did not match any listener for the target extension.
    if (matchedCount === 0 && targetExtensionId) {
      this.deliverToTargetExtensionWhenNoListener(targetExtensionId, eventName, ipcName, args)
    }

    if (serviceWorkerAsync > 0) {
      d(
        `sendEvent '${eventName}': ${sentCount} frame host(s); ${serviceWorkerAsync} service worker delivery(s) scheduled`,
      )
    } else {
      d(`sent '${eventName}' event to ${sentCount} listeners`)
    }
  }

  /**
   * Delivers an event to every listener for `eventName`, using a different
   * argument list per extension (e.g. chrome.types.ChromeSettingGetDetails).
   */
  sendEventForEachListener(eventName: string, mapArgs: (extensionId: string) => any[]) {
    const { listeners } = this
    const eventListeners = listeners.get(eventName)
    const ipcName = `crx-${eventName}`
    const swDelayMs = isUrgentNavigationEvent(eventName) ? 0 : 200

    if (!eventListeners || eventListeners.length === 0) {
      d(`sendEventForEachListener: no listeners for '${eventName}'`)
      return
    }

    const deadListeners: EventListener[] = []
    let sentCount = 0
    let serviceWorkerAsync = 0
    const allowed = new Map<string, boolean>()
    for (const listener of eventListeners) {
      const { type, extensionId } = listener
      if (!allowed.has(extensionId)) allowed.set(extensionId, this.mayHear(extensionId, eventName))
      if (!allowed.get(extensionId)) continue
      const args = mapArgs(extensionId)

      if (type === 'service-worker') {
        serviceWorkerAsync++
        this.deliverToServiceWorkerOrHost(listener, extensionId, ipcName, args, swDelayMs)
      } else {
        if (listener.host.isDestroyed()) {
          deadListeners.push(listener)
          continue
        }
        try {
          listener.host.send(ipcName, ...args)
          sentCount++
        } catch (err) {
          d('send %s to extension %s failed (host may be tearing down): %o', eventName, extensionId, err)
          deadListeners.push(listener)
        }
      }
    }

    if (deadListeners.length > 0) {
      const deadSet = new Set(deadListeners)
      const filtered = eventListeners.filter((l) => !deadSet.has(l))
      if (filtered.length > 0) {
        listeners.set(eventName, filtered)
      } else {
        listeners.delete(eventName)
      }
      d(`removed ${deadListeners.length} dead listener(s) for '${eventName}'`)
    }

    if (serviceWorkerAsync > 0) {
      d(
        `sendEventForEachListener '${eventName}': ${sentCount} frame host(s); ${serviceWorkerAsync} service worker delivery(s) scheduled`,
      )
    } else {
      d(`sendEventForEachListener '${eventName}' event to ${sentCount} listeners`)
    }
  }

  /**
   * For action-click events: MV3 service workers start lazily. When the host
   * triggers a click for an extension that has not yet run its worker, no listener exists.
   * Start the worker for the target extension and deliver the event after it has had time to
   * run and register its IPC listener.
   */
  private deliverToTargetExtensionWhenNoListener(
    targetExtensionId: string | undefined,
    eventName: string,
    ipcName: string,
    args: any[],
  ) {
    if (
      !targetExtensionId ||
      (eventName !== 'browserAction.onClicked' && eventName !== 'action.onClicked')
    ) {
      return
    }
    const argsCopy = [...args]
    void this.startExtensionWorker(targetExtensionId, eventName).then((serviceWorker) => {
      if (!serviceWorker || (serviceWorker as any).isDestroyed?.()) return
      setTimeout(() => {
        if ((serviceWorker as any).isDestroyed?.()) return
        try {
          serviceWorker.send(ipcName, ...argsCopy)
        } catch (err) {
          d('service worker send failed for %s: %o', eventName, err)
        }
      }, 400)
    })
  }

  /** Broadcasts extension event to all extension hosts listening for it. */
  broadcastEvent(eventName: string, ...args: any[]) {
    this.sendEvent(undefined, eventName, ...args)
  }
}
