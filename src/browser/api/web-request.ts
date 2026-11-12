import { webContents as electronWebContents } from 'electron'

import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesPattern, tryParseMatchPattern } from '../match-pattern'
import type { DeclarativeNetRequestAPI } from './declarative-net-request'

/**
 * chrome.webRequest
 *
 * The host owns the session's webRequest hooks (Electron lets one handler
 * have each) and hands every request to the notify* methods. Here each
 * request goes to the listeners whose filter matches, and only to
 * extensions Chrome would show it to: host access to the URL, and for
 * anything but a top-level navigation, to the page that made it too.
 */

const EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onAuthRequired',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred',
] as const
type EventName = (typeof EVENTS)[number]

/** Events whose listeners may change the request, with what they may ask for. */
const BLOCKING_EVENTS = new Set<EventName>(['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived', 'onAuthRequired'])

const MAX_LISTENERS_PER_EXTENSION = 1000
const MAX_FILTER_URLS = 1000

interface ListenerEntry {
  id: string
  extensionId: string
  filter: chrome.webRequest.RequestFilter
  extraInfoSpec: string[]
  blocking: boolean
  /** Identifies the registration, so a restarted worker's listener replaces its old self. */
  key: string
}

export interface WebRequestBlockingResponse {
  cancel?: boolean
  redirectUrl?: string
  redirectURL?: string
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  authCredentials?: {
    username: string
    password: string
  }
}

type ElectronHeaders = Record<string, string | string[]>

// Chrome hands extensions headers as [{ name, value }] and takes them back the
// same way; Electron's webRequest uses { name: value | [values] }. Extensions
// such as Browsec read details.responseHeaders as Chrome's array.
function toChromeHeaders(headers?: ElectronHeaders): chrome.webRequest.HttpHeader[] | undefined {
  if (!headers) return undefined
  if (Array.isArray(headers)) return headers
  const list: chrome.webRequest.HttpHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    for (const one of Array.isArray(value) ? value : [value]) list.push({ name, value: String(one) })
  }
  return list
}

function fromChromeHeaders(list: chrome.webRequest.HttpHeader[]): Record<string, string[]> {
  const headers: Record<string, string[]> = {}
  for (const header of list || []) {
    if (!header || !header.name) continue
    const value =
      header.value != null
        ? String(header.value)
        : header.binaryValue
          ? Buffer.from(header.binaryValue).toString()
          : ''
    ;(headers[header.name] = headers[header.name] || []).push(value)
  }
  return headers
}

function originsMatch(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

const originOf = (url: string | undefined) => {
  if (!url) return undefined
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/** What is known about a request, from which each event's details are made. */
export interface WebRequestDetails {
  url: string
  method: string
  tabId: number
  windowId?: number
  requestId?: string
  documentId?: string
  parentDocumentId?: string
  frameType?: string
  documentLifecycle?: string
  frameId?: number
  parentFrameId?: number
  type?: string
  timeStamp?: number
  /** Chrome's initiator: the origin that made the request. */
  initiator?: string
  /** The page that made the request, for declarativeNetRequest's domain rules. */
  documentUrl?: string
  requestBody?: chrome.webRequest.WebRequestBody
  requestHeaders?: chrome.webRequest.HttpHeader[]
  responseHeaders?: chrome.webRequest.HttpHeader[]
  statusCode?: number
  statusLine?: string
  redirectUrl?: string
  ip?: string
  fromCache?: boolean
  error?: string
  isProxy?: boolean
  scheme?: string
  realm?: string
  challenger?: {
    host: string
    port: number
  }
}

interface ElectronRequestDetails {
  id?: string | number
  url?: string
  method?: string
  resourceType?: string
  timestamp?: number
  referrer?: string
  initiatorOrigin?: string
  webContents?: Electron.WebContents
  frame?: Electron.WebFrameMain | null
  webContentsId?: number
  uploadData?: Array<{ bytes?: Buffer; file?: string }>
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
  statusLine?: string
  redirectURL?: string
  fromCache?: boolean
  error?: string
  ip?: string
  isProxy?: boolean
  scheme?: string
  realm?: string
  challenger?: {
    host: string
    port: number
  }
}

interface PendingBlockingRequest<T = WebRequestBlockingResponse> {
  resolve: (result: T) => void
  results: Map<string, any>
  /** The blocking listeners the event went to, by listener id: the extension each belongs to. */
  awaiting: Map<string, string>
  timeoutHandle: ReturnType<typeof setTimeout>
  merge: (results: Map<string, any>) => T
}

const BLOCKING_RESPONSE_TIMEOUT_MS = 2000

const isIpLiteral = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')

export class WebRequestAPI {
  private listeners = new Map<EventName, ListenerEntry[]>(EVENTS.map((name) => [name, []]))
  private requestIdCounter = 0
  private listenerIdCounter = 0
  private pendingBlocking = new Map<string, PendingBlockingRequest>()
  /** Server addresses Electron reported on a redirect, by request id. */
  private requestIps = new Map<string, string>()
  private watchedSenders = new WeakSet<object>()

  constructor(
    private ctx: ExtensionContext,
    private dnr: DeclarativeNetRequestAPI | null = null,
  ) {
    const handle = this.ctx.router.apiHandler()
    for (const name of EVENTS) {
      const suffix = name[0].toUpperCase() + name.slice(1)
      handle(
        `webRequest.add${suffix}Listener`,
        (event: ExtensionEvent, filter: any, extraInfoSpec?: any, ordinal?: number) =>
          this.addListener(name, event, filter, extraInfoSpec, ordinal),
      )
      handle(`webRequest.remove${suffix}Listener`, (event: ExtensionEvent, listenerId?: string) =>
        this.removeListener(name, event, listenerId),
      )
    }

    // Each stage keeps its own pending entry: a request carries one id through
    // every stage, so a single map would let one stage's verdict settle
    // another's promise.
    for (const name of BLOCKING_EVENTS) {
      handle(`webRequest.${name}.response`, this.handleBlockingResponseFor(name))
    }

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event: unknown, extension: Electron.Extension) => {
      for (const name of EVENTS) {
        this.listeners.set(name, this.list(name).filter((e) => e.extensionId !== extension.id))
      }
    })
  }

  private list(name: EventName) {
    return this.listeners.get(name)!
  }

  private hasPermission(extension: Electron.Extension, permission: string) {
    const permissions = this.ctx.permissions
    if (permissions) return permissions.has(extension, permission)
    return ((extension.manifest?.permissions || []) as string[]).includes(permission)
  }

  /**
   * Registers one listener. An extension may hold several per event with
   * different filters: uBlock Origin keeps a broad filtering listener next to
   * a narrow guard for its own resources. The id returned goes back with
   * every event, and the renderer hands an event only to the listener it is
   * addressed to.
   *
   * A registration with the same key (sender, filter, spec and its place
   * among identical ones) replaces the old one, so a restarted service
   * worker does not pile up listeners nobody answers for.
   */
  private addListener(
    name: EventName,
    event: ExtensionEvent,
    filter: any,
    extraInfoSpec?: any,
    ordinal?: number,
  ) {
    const { extension } = event
    if (!filter || typeof filter !== 'object' || !Array.isArray(filter.urls)) return
    const urls = filter.urls
      .filter((u: unknown): u is string => typeof u === 'string' && !!tryParseMatchPattern(u))
      .slice(0, MAX_FILTER_URLS)
    // Chrome drops a listener whose patterns are all invalid.
    if (urls.length === 0) return
    const clean: chrome.webRequest.RequestFilter = { urls }
    if (Array.isArray(filter.types)) {
      clean.types = filter.types.filter((t: unknown) => typeof t === 'string').slice(0, 32)
    }
    if (Number.isInteger(filter.tabId)) clean.tabId = filter.tabId
    if (Number.isInteger(filter.windowId)) clean.windowId = filter.windowId

    const spec: string[] = Array.isArray(extraInfoSpec)
      ? extraInfoSpec.filter((s: unknown): s is string => typeof s === 'string').slice(0, 16)
      : []
    let blocking = false
    if (BLOCKING_EVENTS.has(name)) {
      if (name === 'onAuthRequired') {
        blocking = spec.includes('blocking') || spec.includes('asyncBlocking')
        if (blocking && !this.hasPermission(extension, 'webRequestBlocking') && !this.hasPermission(extension, 'webRequestAuthProvider')) {
          return
        }
      } else {
        blocking = spec.includes('blocking')
        if (blocking && !this.hasPermission(extension, 'webRequestBlocking')) return
      }
    }

    const sender = event.sender as any
    let senderKey = 'unknown'
    try {
      senderKey = event.type === 'service-worker' ? `sw:${sender?.scope}` : `frame:${sender?.id}`
    } catch {}
    // The renderer counts identical listeners in its context, so a restarted
    // worker's first one replaces the old first one, and two alike both stay.
    const nth = Number.isInteger(ordinal) && (ordinal as number) >= 0 ? (ordinal as number) : 0
    const key = JSON.stringify([senderKey, clean, spec, nth])
    const current = this.list(name)
    const next = current.filter((e) => !(e.extensionId === extension.id && e.key === key))
    if (next.filter((e) => e.extensionId === extension.id).length >= MAX_LISTENERS_PER_EXTENSION) return
    const entry: ListenerEntry = {
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: clean,
      extraInfoSpec: spec,
      blocking,
      key,
    }
    next.push(entry)
    this.listeners.set(name, next)
    if (event.type === 'frame' && typeof sender?.once === 'function' && !this.watchedSenders.has(sender)) {
      this.watchedSenders.add(sender)
      sender.once('destroyed', () => {
        const prefix = JSON.stringify([senderKey]).slice(0, -1)
        for (const each of EVENTS) {
          this.listeners.set(each, this.list(each).filter((e) => !e.key.startsWith(prefix)))
        }
      })
    }
    return entry.id
  }

  private removeListener(name: EventName, { extension }: ExtensionEvent, listenerId?: string) {
    if (!extension) return
    this.listeners.set(
      name,
      this.list(name).filter((e) => {
        if (e.extensionId !== extension.id) return true
        return typeof listenerId === 'string' && e.id !== listenerId
      }),
    )
  }

  private handleBlockingResponseFor = (stage: string) => (
    { extension }: ExtensionEvent,
    requestId: string,
    listenerIdOrResult: string | WebRequestBlockingResponse | undefined,
    maybeResult?: WebRequestBlockingResponse,
  ) => {
    const pending = this.pendingBlocking.get(`${stage}:${requestId}`)
    if (!pending || !extension) return
    // Only a blocking listener the event went to answers for it, once, from
    // its own extension. Any other answer would let an extension with no
    // access to the page cancel or redirect it, or overrule another one.
    const listenerId = typeof listenerIdOrResult === 'string' ? listenerIdOrResult : undefined
    if (!listenerId || pending.awaiting.get(listenerId) !== extension.id || pending.results.has(listenerId)) return
    const result = maybeResult
    pending.results.set(listenerId, result && typeof result === 'object' ? result : {})
    if (pending.results.size >= pending.awaiting.size) {
      this.settlePending(`${stage}:${requestId}`)
    }
  }

  /** @param pendingKey `${stage}:${requestId}` */
  private settlePending(pendingKey: string): void {
    const pending = this.pendingBlocking.get(pendingKey)
    if (!pending) return
    clearTimeout(pending.timeoutHandle)
    this.pendingBlocking.delete(pendingKey)
    const merged = pending.merge(pending.results)
    pending.resolve(merged)
  }

  private mergeCancelOrRedirect(
    results: Map<string, WebRequestBlockingResponse>,
  ): WebRequestBlockingResponse {
    for (const r of results.values()) {
      if (r.cancel === true) return { cancel: true }
    }
    for (const r of results.values()) {
      if (typeof r.redirectUrl === 'string' && r.redirectUrl.length > 0) {
        return { redirectUrl: r.redirectUrl }
      }
    }
    return {}
  }

  /** Apply DNR result; loadURL fallback when main-frame redirect/cancel is ignored. */
  private applyDnrBeforeRequestResult(
    details: Electron.OnBeforeRequestListenerDetails,
    dnrResult: WebRequestBlockingResponse,
  ): WebRequestBlockingResponse {
    const redirectUrl =
      typeof dnrResult.redirectUrl === 'string' && dnrResult.redirectUrl
        ? dnrResult.redirectUrl
        : typeof dnrResult.redirectURL === 'string'
          ? dnrResult.redirectURL
          : undefined

    if (
      redirectUrl &&
      redirectUrl.startsWith('chrome-extension://') &&
      details.resourceType === 'mainFrame' &&
      typeof details.webContentsId === 'number'
    ) {
      const wc = electronWebContents.fromId(details.webContentsId)
      if (wc && !wc.isDestroyed()) {
        const target = redirectUrl
        queueMicrotask(() => {
          if (!wc.isDestroyed()) {
            void wc.loadURL(target).catch((err) => {
              console.warn('[webRequest] DNR redirect loadURL failed:', err?.message || err)
            })
          }
        })
        return { cancel: true }
      }
    }

    // main_frame cancel is unreliable; clear the tab if the blocked URL still commits
    if (
      dnrResult.cancel === true &&
      details.resourceType === 'mainFrame' &&
      typeof details.webContentsId === 'number'
    ) {
      const wc = electronWebContents.fromId(details.webContentsId)
      if (wc && !wc.isDestroyed()) {
        const blockedUrl = details.url
        queueMicrotask(() => {
          if (wc.isDestroyed()) return
          try {
            const current = wc.getURL()
            if (
              !current ||
              current === 'about:blank' ||
              current === blockedUrl ||
              originsMatch(current, blockedUrl)
            ) {
              void wc.loadURL('about:blank')
            }
          } catch {
            void wc.loadURL('about:blank')
          }
        })
      }
      return { cancel: true }
    }

    if (dnrResult.cancel === true) return { cancel: true }
    if (redirectUrl) return { redirectUrl }
    return dnrResult
  }

  private extractAuthCredentialsFromBlockingResult(
    r: WebRequestBlockingResponse | undefined,
  ): { username: string; password: string } | undefined {
    if (!r || r.cancel === true) return undefined
    const ac = r.authCredentials as { username?: unknown; password?: unknown } | undefined
    if (ac && (ac.username != null || ac.password != null)) {
      return { username: String(ac.username ?? ''), password: String(ac.password ?? '') }
    }
    const any = r as Record<string, unknown>
    if (typeof any.username === 'string' || typeof any.password === 'string') {
      return {
        username: typeof any.username === 'string' ? any.username : '',
        password: typeof any.password === 'string' ? any.password : '',
      }
    }
    return undefined
  }

  private mergeAuthRequired(
    results: Map<string, WebRequestBlockingResponse>,
  ): WebRequestBlockingResponse {
    for (const r of results.values()) {
      const creds = this.extractAuthCredentialsFromBlockingResult(r)
      if (creds && (creds.username !== '' || creds.password !== '')) {
        return { authCredentials: creds }
      }
    }
    for (const r of results.values()) {
      if (r?.cancel === true) return { cancel: true }
    }
    return {}
  }

  /** Chrome's ResourceType for Electron's. */
  private normalizeResourceType(resourceType?: string): string {
    switch (resourceType) {
      case 'mainFrame':
        return 'main_frame'
      case 'subFrame':
        return 'sub_frame'
      case 'xhr':
      case 'fetch':
      case 'xmlhttprequest':
        return 'xmlhttprequest'
      case 'cspReport':
        return 'csp_report'
      case 'webSocket':
      case 'websocket':
        return 'websocket'
      case 'img':
      case 'image':
        return 'image'
      case 'script':
      case 'stylesheet':
      case 'font':
      case 'media':
      case 'object':
      case 'ping':
        return resourceType
      default:
        return 'other'
    }
  }

  /**
   * The page a request came from, for declarativeNetRequest. Referrers are
   * often stripped, so the requesting frame and then the tab stand in.
   */
  private resolveDocumentUrl(details: ElectronRequestDetails): string | undefined {
    const web = (url: unknown): boolean =>
      typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))
    const ref = details.referrer
    if (web(ref)) return ref as string
    try {
      const mf = (details.webContents as any)?.mainFrame
      if (mf && (web(mf.url) || (typeof mf.url === 'string' && mf.url.startsWith('chrome-extension://')))) {
        return mf.url
      }
    } catch {}
    try {
      if (web(details.frame?.url)) return details.frame!.url
    } catch {}
    const wc =
      details.webContents ??
      (typeof details.webContentsId === 'number' ? electronWebContents.fromId(details.webContentsId) : undefined)
    try {
      if (wc && !wc.isDestroyed()) {
        const url = wc.getURL()
        if (web(url) || url.startsWith('chrome-extension://')) return url
      }
    } catch {}
    if (typeof ref === 'string' && ref.startsWith('chrome-extension://')) return ref
    try {
      const url = details.frame?.url
      if (typeof url === 'string' && url.startsWith('chrome-extension://')) return url
    } catch {}
    if (details.initiatorOrigin && details.initiatorOrigin !== 'null') return details.initiatorOrigin + '/'
    return undefined
  }

  private buildDetails(
    details: ElectronRequestDetails,
    opts?: { includeRequestBody?: boolean },
  ): WebRequestDetails {
    const rawWebContentsId = details.webContentsId
    const tabId =
      typeof rawWebContentsId === 'number'
        ? this.ctx.store.getTabIdForWebContentsId(rawWebContentsId)
        : -1
    const windowId =
      typeof rawWebContentsId === 'number'
        ? this.ctx.store.getWindowIdForWebContentsId(rawWebContentsId)
        : undefined
    const type = this.normalizeResourceType(details.resourceType)

    // The frame that made the request; for a frame's own navigation, that frame.
    let frame: Electron.WebFrameMain | null = null
    try {
      frame = details.frame && !details.frame.isDestroyed() ? details.frame : null
    } catch {}
    const idOf = (f: Electron.WebFrameMain) => (f === f.top ? 0 : f.frameTreeNodeId)
    let frameId = -1
    let parentFrameId = -1
    let frameType: string | undefined
    let documentId: string | undefined
    let parentDocumentId: string | undefined
    if (type === 'main_frame') {
      frameId = 0
      frameType = 'outermost_frame'
    } else if (frame) {
      try {
        frameId = idOf(frame)
        parentFrameId = frame.parent ? idOf(frame.parent) : -1
        frameType = frame.parent ? 'sub_frame' : 'outermost_frame'
        if (type === 'sub_frame' && frame.parent) {
          parentDocumentId = tabId >= 0 ? this.ctx.store.getDocumentId(tabId, parentFrameId) : undefined
        } else {
          documentId = tabId >= 0 ? this.ctx.store.getDocumentId(tabId, frameId) : undefined
          if (frame.parent && tabId >= 0) parentDocumentId = this.ctx.store.getDocumentId(tabId, parentFrameId)
        }
      } catch {}
    } else if (tabId >= 0) {
      frameId = 0
      frameType = 'outermost_frame'
      documentId = this.ctx.store.getDocumentId(tabId, 0)
    }

    let initiator: string | undefined
    if (typeof details.initiatorOrigin === 'string' && details.initiatorOrigin) {
      initiator = details.initiatorOrigin
    } else if (type !== 'main_frame') {
      initiator = originOf(this.resolveDocumentUrl(details))
    }

    const requestId = details.id != null ? String(details.id) : undefined
    let ip = details.ip
    if (!ip && requestId) ip = this.requestIps.get(requestId)
    if (!ip) {
      try {
        const host = new URL(details.url || '').hostname
        if (isIpLiteral(host)) ip = host.replace(/^\[|\]$/g, '')
      } catch {}
    }

    return {
      url: details.url || '',
      method: details.method || 'GET',
      tabId,
      windowId,
      requestId,
      documentId,
      parentDocumentId,
      frameType,
      documentLifecycle: frameType ? 'active' : undefined,
      frameId,
      parentFrameId,
      type,
      timeStamp: details.timestamp != null ? details.timestamp : Date.now(),
      initiator,
      documentUrl: type === 'main_frame' ? undefined : this.resolveDocumentUrl(details),
      requestBody: opts?.includeRequestBody ? this.normalizeRequestBody(details) : undefined,
      requestHeaders: toChromeHeaders(details.requestHeaders),
      responseHeaders: toChromeHeaders(details.responseHeaders),
      statusCode: details.statusCode,
      statusLine: details.statusLine,
      redirectUrl: details.redirectURL,
      ip,
      fromCache: details.fromCache,
      error: details.error,
      isProxy: details.isProxy,
      scheme: details.scheme,
      realm: details.realm,
      challenger: details.challenger,
    }
  }

  /** The details Chrome gives a listener of `event`, key for key. */
  private toChrome(event: EventName, info: WebRequestDetails, spec: string[]): Record<string, any> {
    const out: Record<string, any> = {
      requestId: info.requestId,
      url: info.url,
      method: info.method,
      frameId: info.frameId ?? -1,
      parentFrameId: info.parentFrameId ?? -1,
      tabId: info.tabId,
      type: info.type,
      timeStamp: info.timeStamp,
    }
    if (info.documentId) out.documentId = info.documentId
    if (info.parentDocumentId) out.parentDocumentId = info.parentDocumentId
    if (info.frameType) out.frameType = info.frameType
    if (info.documentLifecycle) out.documentLifecycle = info.documentLifecycle
    if (info.initiator) out.initiator = info.initiator
    const extra = spec.includes('extraHeaders')
    const wantsResponseHeaders = spec.includes('responseHeaders') || extra
    const status = () => {
      if (typeof info.statusCode === 'number') out.statusCode = info.statusCode
      out.statusLine = info.statusLine ?? (typeof info.statusCode === 'number' ? `HTTP/1.1 ${info.statusCode}` : '')
    }
    const response = () => {
      if (info.ip) out.ip = info.ip
      out.fromCache = !!info.fromCache
    }
    switch (event) {
      case 'onBeforeRequest':
        if (spec.includes('requestBody') && info.requestBody) out.requestBody = info.requestBody
        break
      case 'onBeforeSendHeaders':
      case 'onSendHeaders':
        if ((spec.includes('requestHeaders') || extra) && info.requestHeaders) out.requestHeaders = info.requestHeaders
        break
      case 'onHeadersReceived':
        status()
        if (wantsResponseHeaders && info.responseHeaders) out.responseHeaders = info.responseHeaders
        break
      case 'onAuthRequired':
        status()
        out.scheme = info.scheme ?? ''
        if (info.realm) out.realm = info.realm
        out.challenger = info.challenger ?? { host: '', port: 0 }
        out.isProxy = !!info.isProxy
        if (wantsResponseHeaders && info.responseHeaders) out.responseHeaders = info.responseHeaders
        break
      case 'onResponseStarted':
      case 'onCompleted':
        response()
        status()
        if (wantsResponseHeaders && info.responseHeaders) out.responseHeaders = info.responseHeaders
        break
      case 'onBeforeRedirect':
        response()
        status()
        out.redirectUrl = info.redirectUrl ?? ''
        if (wantsResponseHeaders && info.responseHeaders) out.responseHeaders = info.responseHeaders
        break
      case 'onErrorOccurred':
        response()
        out.error = info.error ?? 'net::ERR_FAILED'
        break
    }
    return out
  }

  private normalizeRequestBody(
    details: ElectronRequestDetails,
  ): chrome.webRequest.WebRequestBody | undefined {
    const method = (details.method || 'GET').toUpperCase()
    const hasBodyMethod = method === 'POST' || method === 'PUT' || method === 'PATCH'
    if (!hasBodyMethod) return undefined

    const uploadData = details.uploadData
    if (!uploadData || uploadData.length === 0) return undefined

    const buffers: Buffer[] = []
    for (const part of uploadData) {
      if (part.bytes && Buffer.isBuffer(part.bytes) && part.bytes.length > 0) {
        buffers.push(part.bytes)
      }
    }

    if (buffers.length === 0) return undefined

    const combined = Buffer.concat(buffers)
    const bytes = combined.buffer.slice(
      combined.byteOffset,
      combined.byteOffset + combined.byteLength,
    )

    const body: chrome.webRequest.WebRequestBody & {
      formData?: Record<string, string[]>
    } = {
      raw: [
        {
          bytes: bytes as ArrayBuffer,
        },
      ],
    } as any

    try {
      const text = combined.toString('utf8')

      if (text.includes('=') && (text.includes('&') || !text.includes('\n'))) {
        const params = new URLSearchParams(text)
        const formData: Record<string, string[]> = {}
        for (const [key, value] of params.entries()) {
          if (!formData[key]) formData[key] = []
          formData[key].push(value)
        }
        if (Object.keys(formData).length > 0) {
          body.formData = formData
        }
      } else if (text.includes('Content-Disposition: form-data')) {
        // Best-effort multipart/form-data parsing.
        const firstLineEnd = text.indexOf('\r\n')
        const firstLine = firstLineEnd !== -1 ? text.slice(0, firstLineEnd) : ''
        const boundaryMatch = firstLine.match(/^-+([^\r\n]+)/)
        const boundary = boundaryMatch && boundaryMatch[1]
        if (boundary) {
          const parts = text.split(`--${boundary}`)
          const formData: Record<string, string[]> = {}
          for (const part of parts) {
            if (!part || part === '--\r\n' || part === '--') continue
            const [rawHeaders, ...rest] = part.split('\r\n\r\n')
            if (!rawHeaders || rest.length === 0) continue
            const nameMatch = rawHeaders.match(/name="([^"]+)"/)
            if (!nameMatch) continue
            const name = nameMatch[1]
            const value = rest.join('\r\n\r\n').replace(/\r\n--\s*$/, '').trim()
            if (!formData[name]) formData[name] = []
            formData[name].push(value)
          }
          if (Object.keys(formData).length > 0) {
            body.formData = formData
          }
        }
      }
    } catch {
      // Keep raw body if parsing fails.
    }

    return body as any
  }

  private listenerMatchesRequest(details: WebRequestDetails, filter: chrome.webRequest.RequestFilter) {
    const urls = filter.urls
    if (!urls || urls.length === 0) return false
    if (!urls.some((pattern) => matchesPattern(pattern, details.url))) return false

    const types = filter.types
    if (types && types.length > 0) {
      if (!types.includes((details.type || 'other') as chrome.webRequest.ResourceType)) return false
    }

    if (typeof filter.tabId === 'number' && filter.tabId !== details.tabId) return false

    if (typeof filter.windowId === 'number') {
      if (typeof details.windowId !== 'number' || filter.windowId !== details.windowId) {
        return false
      }
    }

    return true
  }

  /**
   * Chrome shows an extension a request only with host access to its URL,
   * and, unless it is a top-level navigation, to the origin that made it.
   * That keeps other extensions' requests and those of browser pages out of
   * sight. Requests the browser makes for itself have neither a page nor an
   * origin, and are not shown at all.
   */
  private visibleTo(extensionId: string, info: WebRequestDetails) {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const extension = sessionExtensions.getExtension?.(extensionId)
    const permissions = this.ctx.permissions
    if (!permissions) return true
    if (!extension) return false
    const tabId = info.tabId >= 0 ? info.tabId : undefined
    if (!permissions.hasHostAccess(extension, info.url, { tabId })) return false
    const navigation = info.type === 'main_frame'
    if (!navigation) {
      if (!info.initiator) {
        if (info.tabId < 0 && !info.frameType) return false
      } else if (info.initiator !== 'null') {
        if (!permissions.hasHostAccess(extension, info.initiator + '/', { tabId })) return false
      }
    }
    return true
  }

  private findMatchingListeners(name: EventName, details: WebRequestDetails): ListenerEntry[] {
    const visible = new Map<string, boolean>()
    return this.list(name).filter((entry) => {
      if (!this.listenerMatchesRequest(details, entry.filter)) return false
      let ok = visible.get(entry.extensionId)
      if (ok === undefined) {
        ok = this.visibleTo(entry.extensionId, details)
        visible.set(entry.extensionId, ok)
      }
      return ok
    })
  }

  private mergeRequestHeaders(
    original: Record<string, string | string[]> | undefined,
    results: Map<string, any>,
  ): { requestHeaders?: Record<string, string | string[]> } {
    const base: Record<string, string | string[]> = { ...(original || {}) }

    for (const r of results.values()) {
      if (r && Array.isArray(r.requestHeaders)) {
        // Chrome's list is the whole new set, so a header left out is gone.
        for (const key of Object.keys(base)) delete base[key]
        for (const [key, values] of Object.entries(fromChromeHeaders(r.requestHeaders))) {
          base[key] = values.join(', ')
        }
      } else if (r && r.requestHeaders && typeof r.requestHeaders === 'object') {
        Object.assign(base, r.requestHeaders as Record<string, string | string[]>)
      }
    }

    return Object.keys(base).length > 0 ? { requestHeaders: base } : {}
  }

  private mergeResponseHeaders(
    original: Record<string, string | string[]> | undefined,
    results: Map<string, any>,
  ): { responseHeaders?: Record<string, string | string[]> } {
    const base: Record<string, string | string[]> = { ...(original || {}) }

    for (const r of results.values()) {
      if (r && Array.isArray(r.responseHeaders)) {
        for (const key of Object.keys(base)) delete base[key]
        Object.assign(base, fromChromeHeaders(r.responseHeaders))
      } else if (r && r.responseHeaders && typeof r.responseHeaders === 'object') {
        Object.assign(base, r.responseHeaders as Record<string, string | string[]>)
      }
    }

    return Object.keys(base).length > 0 ? { responseHeaders: base } : {}
  }

  /**
   * Sends `event` to every matching listener, each with its own id. With
   * blocking listeners among them, resolves once each has answered (or the
   * time is up) with the merged answer; otherwise at once with {}.
   */
  private dispatch<T>(
    event: EventName,
    info: WebRequestDetails,
    merge?: (results: Map<string, any>) => T,
  ): Promise<T | {}> {
    const matching = this.findMatchingListeners(event, info)
    if (matching.length === 0) return Promise.resolve({})
    const requestId = info.requestId || `wr-${++this.requestIdCounter}`
    const payload = { ...info, requestId }
    const blocking = merge ? matching.filter((e) => e.blocking) : []
    const send = () => {
      for (const entry of matching) {
        this.ctx.router.sendEvent(entry.extensionId, `webRequest.${event}`, {
          ...this.toChrome(event, payload, entry.extraInfoSpec),
          listenerId: entry.id,
        })
      }
    }
    if (blocking.length === 0 || !merge) {
      send()
      return Promise.resolve({})
    }
    return new Promise<T>((resolve) => {
      const key = `${event}:${requestId}`
      const timeoutHandle = setTimeout(() => this.settlePending(key), BLOCKING_RESPONSE_TIMEOUT_MS)
      this.pendingBlocking.set(key, {
        resolve: resolve as any,
        results: new Map(),
        awaiting: new Map(blocking.map((entry) => [entry.id, entry.extensionId])),
        timeoutHandle,
        merge: merge as any,
      })
      send()
    })
  }

  async notifyOnBeforeRequest(
    details: Electron.OnBeforeRequestListenerDetails,
  ): Promise<WebRequestBlockingResponse> {
    if (!details?.url) return {}
    const raw = details as unknown as ElectronRequestDetails
    const probe = this.buildDetails(raw)

    if (this.dnr) {
      const dnrResult = this.dnr.evaluateOnBeforeRequest(probe)
      // Electron onBeforeRequest only honors cancel/redirect. Header mutations
      // from modifyHeaders are applied in the sendHeaders / headersReceived stages.
      if (dnrResult?.cancel === true || typeof dnrResult?.redirectUrl === 'string') {
        return this.applyDnrBeforeRequestResult(details, dnrResult)
      }
    }

    const wantsBody = this.list('onBeforeRequest').some((e) => e.extraInfoSpec.includes('requestBody'))
    const info = wantsBody ? this.buildDetails(raw, { includeRequestBody: true }) : probe
    return (await this.dispatch('onBeforeRequest', info, (results) =>
      this.mergeCancelOrRedirect(results as Map<string, WebRequestBlockingResponse>),
    )) as WebRequestBlockingResponse
  }

  async notifyOnBeforeSendHeaders(
    details: Electron.OnBeforeSendHeadersListenerDetails,
  ): Promise<{ requestHeaders?: Record<string, string | string[]> }> {
    if (!details?.url) return {}
    const info = this.buildDetails(details as unknown as ElectronRequestDetails)
    const result = (await this.dispatch('onBeforeSendHeaders', info, (results) =>
      this.mergeRequestHeaders(details.requestHeaders as any, results),
    )) as { requestHeaders?: Record<string, string | string[]> }
    // declarativeNetRequest changes headers after the listeners, as in Chrome.
    const changed = this.dnr?.modifyHeaders('request', info, result.requestHeaders ?? (details.requestHeaders as any) ?? {})
    return changed ? { requestHeaders: changed } : result
  }

  async notifyOnSendHeaders(details: Electron.OnSendHeadersListenerDetails): Promise<void> {
    if (!details?.url) return
    await this.dispatch('onSendHeaders', this.buildDetails(details as unknown as ElectronRequestDetails))
  }

  async notifyOnHeadersReceived(
    details: Electron.OnHeadersReceivedListenerDetails,
  ): Promise<{ responseHeaders?: Record<string, string | string[]> }> {
    if (!details?.url) return {}
    const info = this.buildDetails(details as unknown as ElectronRequestDetails)
    const result = (await this.dispatch('onHeadersReceived', info, (results) =>
      this.mergeResponseHeaders(details.responseHeaders as any, results),
    )) as { responseHeaders?: Record<string, string | string[]> }
    const changed = this.dnr?.modifyHeaders('response', info, result.responseHeaders ?? (details.responseHeaders as any) ?? {})
    return changed ? { responseHeaders: changed } : result
  }

  async notifyOnBeforeRedirect(details: Electron.OnBeforeRedirectListenerDetails): Promise<void> {
    if (!details?.url) return
    const raw = details as unknown as ElectronRequestDetails
    if (raw.ip && raw.id != null) {
      this.requestIps.set(String(raw.id), raw.ip)
      // Only the last few are worth keeping; a request ends long before.
      if (this.requestIps.size > 500) this.requestIps.delete(this.requestIps.keys().next().value!)
    }
    await this.dispatch('onBeforeRedirect', this.buildDetails(raw))
  }

  async notifyOnResponseStarted(details: Electron.OnResponseStartedListenerDetails): Promise<void> {
    if (!details?.url) return
    await this.dispatch('onResponseStarted', this.buildDetails(details as unknown as ElectronRequestDetails))
  }

  async notifyOnCompleted(details: Electron.OnCompletedListenerDetails): Promise<void> {
    if (!details?.url) return
    const raw = details as unknown as ElectronRequestDetails
    await this.dispatch('onCompleted', this.buildDetails(raw))
    if (raw.id != null) this.requestIps.delete(String(raw.id))
  }

  async notifyOnErrorOccurred(details: Electron.OnErrorOccurredListenerDetails): Promise<void> {
    if (!details?.url) return
    const raw = details as unknown as ElectronRequestDetails
    await this.dispatch('onErrorOccurred', this.buildDetails(raw))
    if (raw.id != null) this.requestIps.delete(String(raw.id))
  }

  async notifyOnAuthRequired(
    details: ElectronRequestDetails,
  ): Promise<{ cancel?: boolean; authCredentials?: { username: string; password: string } }> {
    if (!details?.url) return {}
    return this.dispatch('onAuthRequired', this.buildDetails(details), (results) =>
      this.mergeAuthRequired(results as Map<string, WebRequestBlockingResponse>),
    ) as any
  }
}
