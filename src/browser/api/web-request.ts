import { webContents as electronWebContents } from 'electron'

import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesPattern } from './common'
import type { DeclarativeNetRequestAPI } from './declarative-net-request'

interface ListenerEntry {
  id: string
  extensionId: string
  filter: chrome.webRequest.RequestFilter
  extraInfoSpec?: string[]
}

export interface WebRequestBlockingResponse {
  cancel?: boolean
  redirectUrl?: string
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  authCredentials?: {
    username: string
    password: string
  }
}

export interface WebRequestDetails {
  url: string
  method: string
  tabId: number
  windowId?: number
  requestId?: string
  documentId?: string
  frameId?: number
  parentFrameId?: number
  type?: string
  timeStamp?: number
  initiator?: string
  requestBody?: chrome.webRequest.WebRequestBody
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
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
  webContents?: Electron.WebContents
  frame?: Electron.WebFrameMain | null
  webContentsId?: number
  frameId?: number
  parentFrameId?: number
  uploadData?: Array<{ bytes?: Buffer; file?: string }>
  requestHeaders?: Record<string, string | string[]>
  responseHeaders?: Record<string, string | string[]>
  statusCode?: number
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
  expectedCount: number
  timeoutHandle: ReturnType<typeof setTimeout>
  merge: (results: Map<string, any>) => T
}

const BLOCKING_RESPONSE_TIMEOUT_MS = 2000

export class WebRequestAPI {
  private onBeforeRequestListeners: ListenerEntry[] = []
  private onBeforeSendHeadersListeners: ListenerEntry[] = []
  private onSendHeadersListeners: ListenerEntry[] = []
  private onHeadersReceivedListeners: ListenerEntry[] = []
  private onResponseStartedListeners: ListenerEntry[] = []
  private onCompletedListeners: ListenerEntry[] = []
  private onErrorOccurredListeners: ListenerEntry[] = []
  private onAuthRequiredListeners: ListenerEntry[] = []

  private requestIdCounter = 0
  private listenerIdCounter = 0
  private pendingBlocking = new Map<string, PendingBlockingRequest>()

  constructor(
    private ctx: ExtensionContext,
    private dnr: DeclarativeNetRequestAPI | null = null,
  ) {
    const handle = this.ctx.router.apiHandler()
    handle('webRequest.addOnBeforeRequestListener', this.addOnBeforeRequestListener, {
      permission: 'webRequest',
    })
    handle('webRequest.removeOnBeforeRequestListener', this.removeOnBeforeRequestListener, {
      permission: 'webRequest',
    })
    handle(
      'webRequest.addOnBeforeSendHeadersListener',
      this.addOnBeforeSendHeadersListener,
      {
        permission: 'webRequest',
      },
    )
    handle('webRequest.removeOnBeforeSendHeadersListener', this.removeOnBeforeSendHeadersListener, {
      permission: 'webRequest',
    })
    handle('webRequest.addOnSendHeadersListener', this.addOnSendHeadersListener, {
      permission: 'webRequest',
    })
    handle('webRequest.removeOnSendHeadersListener', this.removeOnSendHeadersListener, {
      permission: 'webRequest',
    })
    handle('webRequest.addOnHeadersReceivedListener', this.addOnHeadersReceivedListener, {
      permission: 'webRequest',
    })
    handle('webRequest.removeOnHeadersReceivedListener', this.removeOnHeadersReceivedListener, {
      permission: 'webRequest',
    })
    handle(
      'webRequest.addOnResponseStartedListener',
      this.addOnResponseStartedListener,
      {
        permission: 'webRequest',
      },
    )
    handle('webRequest.removeOnResponseStartedListener', this.removeOnResponseStartedListener, {
      permission: 'webRequest',
    })
    handle('webRequest.addOnCompletedListener', this.addOnCompletedListener, {
      permission: 'webRequest',
    })
    handle('webRequest.removeOnCompletedListener', this.removeOnCompletedListener, {
      permission: 'webRequest',
    })
    handle(
      'webRequest.addOnErrorOccurredListener',
      this.addOnErrorOccurredListener,
      {
        permission: 'webRequest',
      },
    )
    handle('webRequest.removeOnErrorOccurredListener', this.removeOnErrorOccurredListener, {
      permission: 'webRequest',
    })
    handle('webRequest.addOnAuthRequiredListener', this.addOnAuthRequiredListener, {
      permission: 'webRequest',
    })
    handle('webRequest.removeOnAuthRequiredListener', this.removeOnAuthRequiredListener, {
      permission: 'webRequest',
    })

    handle('webRequest.onBeforeRequest.response', this.handleBlockingResponse)
    handle('webRequest.onBeforeSendHeaders.response', this.handleBlockingResponse)
    handle('webRequest.onHeadersReceived.response', this.handleBlockingResponse)
    handle('webRequest.onAuthRequired.response', this.handleBlockingResponse)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      const id = extension.id
      this.onBeforeRequestListeners = this.onBeforeRequestListeners.filter((e) => e.extensionId !== id)
      this.onBeforeSendHeadersListeners = this.onBeforeSendHeadersListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onSendHeadersListeners = this.onSendHeadersListeners.filter((e) => e.extensionId !== id)
      this.onHeadersReceivedListeners = this.onHeadersReceivedListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onResponseStartedListeners = this.onResponseStartedListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onCompletedListeners = this.onCompletedListeners.filter((e) => e.extensionId !== id)
      this.onErrorOccurredListeners = this.onErrorOccurredListeners.filter(
        (e) => e.extensionId !== id,
      )
      this.onAuthRequiredListeners = this.onAuthRequiredListeners.filter(
        (e) => e.extensionId !== id,
      )
    })
  }

  private addOnBeforeRequestListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    const wantsBlocking =
      Array.isArray(extraInfoSpec) && extraInfoSpec.includes('blocking')
    if (wantsBlocking) {
      const perms = (extension.manifest?.permissions || []) as string[]
      if (!perms.includes('webRequestBlocking')) return
    }
    this.onBeforeRequestListeners = this.onBeforeRequestListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onBeforeRequestListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnBeforeRequestListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onBeforeRequestListeners = this.onBeforeRequestListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnBeforeSendHeadersListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    const wantsBlocking =
      Array.isArray(extraInfoSpec) && extraInfoSpec.includes('blocking')
    if (wantsBlocking) {
      const perms = (extension.manifest?.permissions || []) as string[]
      if (!perms.includes('webRequestBlocking')) return
    }
    this.onBeforeSendHeadersListeners = this.onBeforeSendHeadersListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onBeforeSendHeadersListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnBeforeSendHeadersListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onBeforeSendHeadersListeners = this.onBeforeSendHeadersListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnSendHeadersListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onSendHeadersListeners = this.onSendHeadersListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onSendHeadersListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnSendHeadersListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onSendHeadersListeners = this.onSendHeadersListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnHeadersReceivedListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    const wantsBlocking =
      Array.isArray(extraInfoSpec) && extraInfoSpec.includes('blocking')
    if (wantsBlocking) {
      const perms = (extension.manifest?.permissions || []) as string[]
      if (!perms.includes('webRequestBlocking')) return
    }
    this.onHeadersReceivedListeners = this.onHeadersReceivedListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onHeadersReceivedListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnHeadersReceivedListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onHeadersReceivedListeners = this.onHeadersReceivedListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnResponseStartedListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onResponseStartedListeners = this.onResponseStartedListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onResponseStartedListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnResponseStartedListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onResponseStartedListeners = this.onResponseStartedListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnCompletedListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onCompletedListeners = this.onCompletedListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onCompletedListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnCompletedListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onCompletedListeners = this.onCompletedListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnErrorOccurredListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return
    this.onErrorOccurredListeners = this.onErrorOccurredListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onErrorOccurredListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnErrorOccurredListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onErrorOccurredListeners = this.onErrorOccurredListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private addOnAuthRequiredListener = (
    { extension }: ExtensionEvent,
    filter: chrome.webRequest.RequestFilter,
    extraInfoSpec?: string[],
  ) => {
    if (!filter?.urls || !Array.isArray(filter.urls)) return

    const wantsBlocking =
      Array.isArray(extraInfoSpec) &&
      (extraInfoSpec.includes('blocking') || extraInfoSpec.includes('asyncBlocking'))
    if (wantsBlocking) {
      const perms = (extension.manifest?.permissions || []) as string[]
      if (!perms.includes('webRequestBlocking') && !perms.includes('webRequestAuthProvider')) {
        return
      }
    }

    this.onAuthRequiredListeners = this.onAuthRequiredListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
    this.onAuthRequiredListeners.push({
      id: `wr-${++this.listenerIdCounter}`,
      extensionId: extension.id,
      filter: { ...filter },
      extraInfoSpec,
    })
  }

  private removeOnAuthRequiredListener = ({ extension }: ExtensionEvent) => {
    if (!extension) return
    this.onAuthRequiredListeners = this.onAuthRequiredListeners.filter(
      (e) => e.extensionId !== extension.id,
    )
  }

  private handleBlockingResponse = (
    { extension }: ExtensionEvent,
    requestId: string,
    listenerIdOrResult: string | WebRequestBlockingResponse | undefined,
    maybeResult?: WebRequestBlockingResponse,
  ) => {
    const pending = this.pendingBlocking.get(requestId)
    if (!pending) return
    // New signature: (requestId, listenerId, result). Backwards compatible with (requestId, result).
    const listenerId =
      typeof listenerIdOrResult === 'string' ? listenerIdOrResult : extension.id
    const result =
      typeof listenerIdOrResult === 'string' ? maybeResult : listenerIdOrResult

    pending.results.set(listenerId, result || {})
    if (pending.results.size >= pending.expectedCount) {
      this.settlePending(requestId)
    }
  }

  private settlePending(requestId: string): void {
    const pending = this.pendingBlocking.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeoutHandle)
    this.pendingBlocking.delete(requestId)
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
      if (r.redirectUrl && r.redirectUrl.length > 0) return { redirectUrl: r.redirectUrl }
    }
    return {}
  }

  private extractAuthCredentialsFromBlockingResult(
    r: WebRequestBlockingResponse | undefined,
  ): { username: string; password: string } | undefined {
    if (!r || r.cancel === true) return undefined
    const ac = r.authCredentials as { username?: string; password?: string } | undefined
    if (ac && (ac.username != null || ac.password != null)) {
      return { username: ac.username ?? '', password: ac.password ?? '' }
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

  private normalizeResourceType(resourceType?: string): string {
    switch (resourceType) {
      case 'mainFrame':
        return 'main_frame'
      case 'subFrame':
        return 'sub_frame'
      case 'xhr':
      case 'xmlhttprequest':
        return 'xmlhttprequest'
      case 'script':
      case 'img':
      case 'image':
      case 'stylesheet':
      case 'font':
      case 'media':
      case 'fetch':
        return resourceType.toLowerCase()
      case 'ping':
      case 'websocket':
        return resourceType.toLowerCase()
      default:
        return 'other'
    }
  }

  private filterDetailsForListener(
    details: WebRequestDetails,
    extraInfoSpec?: string[],
  ): WebRequestDetails {
    if (!Array.isArray(extraInfoSpec) || extraInfoSpec.length === 0) {
      const { requestHeaders, responseHeaders, requestBody, ...rest } = details
      return { ...rest }
    }

    const includes = (key: string) => extraInfoSpec.includes(key)

    const includeReqHeaders = includes('requestHeaders') || includes('extraHeaders')
    const includeResHeaders = includes('responseHeaders') || includes('extraHeaders')
    const includeRequestBody = includes('requestBody')

    const clone: WebRequestDetails = { ...details }

    if (!includeReqHeaders && 'requestHeaders' in clone) {
      delete clone.requestHeaders
    }
    if (!includeResHeaders && 'responseHeaders' in clone) {
      delete clone.responseHeaders
    }
    if (!includeRequestBody && 'requestBody' in clone) {
      delete clone.requestBody
    }

    return clone
  }

  private getOrCreateRequestId(details: ElectronRequestDetails): string | undefined {
    if (details.id != null) {
      return String(details.id)
    }
    return undefined
  }

  /**
   * Referrer is often empty under strict referrer policies; DNR rules then mis-classify
   * first-party subresources as third-party. Fall back to the requesting frame URL or tab URL.
   *
   * For webview requests, the most reliable source is details.webContents.mainFrame?.url
   * (available Electron >= 25), which exposes the top-level page URL even when the
   * referrer is stripped and the frame object is null for subresource requests.
   */
  private resolveInitiator(details: ElectronRequestDetails): string | undefined {
    const ref = details.referrer
    if (typeof ref === 'string' && ref.length > 0) {
      try {
        const u = new URL(ref)
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          return ref
        }
      } catch {
        /* continue */
      }
    }

    // Fast path: mainFrame.url is the most reliable source for webview subresource requests.
    try {
      const mf = (details.webContents as any)?.mainFrame
      if (mf && typeof mf.url === 'string') {
        if (mf.url.startsWith('http://') || mf.url.startsWith('https://') || mf.url.startsWith('chrome-extension://')) {
          return mf.url
        }
      }
    } catch {
      /* continue */
    }

    try {
      const frameUrl = details.frame?.url
      if (typeof frameUrl === 'string' && (frameUrl.startsWith('http://') || frameUrl.startsWith('https://'))) {
        return frameUrl
      }
    } catch {
      /* continue */
    }

    // Fallback: webContents.getURL() — reliable once the webview has navigated.
    try {
      const wc = details.webContents
      if (wc && typeof (wc as any).isDestroyed === 'function' && !(wc as any).isDestroyed()) {
        const tabUrl = wc.getURL()
        if (tabUrl.startsWith('http://') || tabUrl.startsWith('https://')) {
          return tabUrl
        }
      }
    } catch {
      /* continue */
    }

    const wid = details.webContentsId
    if (typeof wid === 'number') {
      try {
        const wc = electronWebContents.fromId(wid)
        if (wc && !wc.isDestroyed()) {
          const tabUrl = wc.getURL()
          if (tabUrl.startsWith('http://') || tabUrl.startsWith('https://')) {
            return tabUrl
          }
        }
      } catch {
        /* continue */
      }
    }

    // chrome-extension:// initiator fallbacks (for extension-to-extension requests)
    if (typeof ref === 'string' && ref.startsWith('chrome-extension://')) {
      try {
        new URL(ref)
        return ref
      } catch {
        /* continue */
      }
    }
    try {
      const frameUrl = details.frame?.url
      if (typeof frameUrl === 'string' && frameUrl.startsWith('chrome-extension://')) {
        return frameUrl
      }
    } catch {
      /* continue */
    }
    try {
      const wc = details.webContents
      if (wc && typeof (wc as any).isDestroyed === 'function' && !(wc as any).isDestroyed()) {
        const u = wc.getURL()
        if (u.startsWith('chrome-extension://')) return u
      }
    } catch {
      /* continue */
    }
    if (typeof wid === 'number') {
      try {
        const wc = electronWebContents.fromId(wid)
        if (wc && !wc.isDestroyed()) {
          const u = wc.getURL()
          if (u.startsWith('chrome-extension://')) return u
        }
      } catch {
        /* continue */
      }
    }
    return undefined
  }

  private extensionIdFromChromeInitiator(initiator?: string): string | undefined {
    if (!initiator || !initiator.startsWith('chrome-extension://')) return undefined
    try {
      const h = new URL(initiator).hostname
      return h || undefined
    } catch {
      return undefined
    }
  }

  private scopeListenersToInitiatorExtension<T extends { extensionId: string }>(
    listeners: T[],
    initiator?: string,
  ): T[] {
    const ext = this.extensionIdFromChromeInitiator(initiator)
    if (!ext) return listeners
    return listeners.filter((e) => e.extensionId === ext)
  }

  private buildDetails(
    details: ElectronRequestDetails,
    opts?: { includeRequestBody?: boolean },
  ): WebRequestDetails {
    const rawWebContentsId = (details as any).webContentsId
    const tabId =
      typeof rawWebContentsId === 'number'
        ? this.ctx.store.getTabIdForWebContentsId(rawWebContentsId)
        : -1
    const windowId =
      typeof rawWebContentsId === 'number'
        ? this.ctx.store.getWindowIdForWebContentsId(rawWebContentsId)
        : undefined

    const requestId = this.getOrCreateRequestId(details)
    const frameId = typeof details.frameId === 'number' ? details.frameId : 0
    const documentId = tabId >= 0 ? this.ctx.store.getDocumentId(tabId, frameId) : undefined

    return {
      url: details.url || '',
      method: details.method || 'GET',
      tabId,
      windowId,
      requestId,
      documentId,
      frameId,
      parentFrameId:
        typeof details.parentFrameId === 'number' ? details.parentFrameId : -1,
      type: this.normalizeResourceType(details.resourceType),
      timeStamp: details.timestamp != null ? details.timestamp : Date.now(),
      initiator: this.resolveInitiator(details),
      requestBody: opts?.includeRequestBody ? this.normalizeRequestBody(details) : undefined,
      requestHeaders: details.requestHeaders,
      responseHeaders: details.responseHeaders,
      statusCode: details.statusCode,
      ip: details.ip,
      fromCache: details.fromCache,
      error: details.error,
      isProxy: details.isProxy,
      scheme: details.scheme,
      realm: details.realm,
      challenger: details.challenger,
    }
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
        const firstLine =
          firstLineEnd !== -1 ? text.slice(0, firstLineEnd) : ''
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

  /** Map our normalized type strings to Chrome filter ResourceType labels where they differ. */
  private typeForRequestFilterMatch(detailType?: string): string {
    const t = detailType || 'other'
    if (t === 'img') return 'image'
    return t
  }

  private listenerMatchesRequest(details: WebRequestDetails, filter: chrome.webRequest.RequestFilter) {
    const urls = filter.urls
    if (!urls || urls.length === 0) return false
    if (!urls.some((pattern) => matchesPattern(pattern, details.url))) return false

    const types = filter.types
    if (types && types.length > 0) {
      const t = this.typeForRequestFilterMatch(details.type)
      if (!types.includes(t as chrome.webRequest.ResourceType)) return false
    }

    if (typeof filter.tabId === 'number' && filter.tabId !== details.tabId) return false

    if (typeof filter.windowId === 'number') {
      if (typeof details.windowId !== 'number' || filter.windowId !== details.windowId) {
        return false
      }
    }

    return true
  }

  private findMatchingListeners(list: ListenerEntry[], details: WebRequestDetails): ListenerEntry[] {
    return list.filter((entry) => this.listenerMatchesRequest(details, entry.filter))
  }

  private mergeRequestHeaders(
    original: Record<string, string | string[]> | undefined,
    results: Map<string, any>,
  ): { requestHeaders?: Record<string, string | string[]> } {
    const base: Record<string, string | string[]> = { ...(original || {}) }

    for (const r of results.values()) {
      if (r && r.requestHeaders) {
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
      if (r && r.responseHeaders) {
        Object.assign(base, r.responseHeaders as Record<string, string | string[]>)
      }
    }

    return Object.keys(base).length > 0 ? { responseHeaders: base } : {}
  }

  async notifyOnBeforeRequest(
    details: Electron.OnBeforeRequestListenerDetails,
  ): Promise<WebRequestBlockingResponse> {
    const url = details.url
    if (!url) return {}

    const probe = this.buildDetails(details as unknown as ElectronRequestDetails, {
      includeRequestBody: false,
    })

    if (this.dnr) {
      const dnrResult = this.dnr.evaluateOnBeforeRequest(probe)
      if (
        dnrResult?.cancel === true ||
        typeof dnrResult?.redirectUrl === 'string' ||
        dnrResult?.requestHeaders
      ) {
        return dnrResult
      }
    }

    const matching = this.scopeListenersToInitiatorExtension(
      this.findMatchingListeners(this.onBeforeRequestListeners, probe),
      probe.initiator,
    )
    if (matching.length === 0) return {}

    const wantsRequestBody = matching.some((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('requestBody')
    })
    const payloadBase = wantsRequestBody
      ? this.buildDetails(details as unknown as ElectronRequestDetails, {
          includeRequestBody: true,
    })
      : probe

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId = { ...payloadBase, requestId }

    const hasBlocking = matching.some((e) =>
      Array.isArray(e.extraInfoSpec) && e.extraInfoSpec.includes('blocking'),
    )

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadWithId,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onBeforeRequest',
          filtered,
        )
      }
      return {}
    }

    const blockingEntries = matching.filter(
      (e) => Array.isArray(e.extraInfoSpec) && e.extraInfoSpec.includes('blocking'),
    )

    return new Promise<WebRequestBlockingResponse>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: blockingEntries.length,
        timeoutHandle,
        merge: (results) => this.mergeCancelOrRedirect(results as Map<string, WebRequestBlockingResponse>),
      })

      for (const entry of matching) {
        const isBlocking =
          Array.isArray(entry.extraInfoSpec) && entry.extraInfoSpec.includes('blocking')

        const toSend = isBlocking
          ? ({ ...payloadWithId, listenerId: entry.id } as any)
          : payloadWithId

        const filtered = this.filterDetailsForListener(
          toSend,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(entry.extensionId, 'webRequest.onBeforeRequest', filtered)
      }
    })
  }

  async notifyOnBeforeSendHeaders(
    details: Electron.OnBeforeSendHeadersListenerDetails,
  ): Promise<{ requestHeaders?: Record<string, string | string[]> }> {
    const url = details.url
    if (!url) return {}

    const baseDetails = this.buildDetails(details as unknown as ElectronRequestDetails)
    const payloadBase: WebRequestDetails = {
      ...baseDetails,
      requestHeaders: details.requestHeaders as any,
    }

    const matching = this.scopeListenersToInitiatorExtension(
      this.findMatchingListeners(this.onBeforeSendHeadersListeners, payloadBase),
      payloadBase.initiator,
    )
    if (matching.length === 0) return {}

    const hasBlocking = matching.some((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking')
    })

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId: WebRequestDetails = { ...payloadBase, requestId }

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadWithId,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onBeforeSendHeaders',
          filtered,
        )
      }
      return {}
    }

    const blockingEntries = matching.filter((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking')
    })

    return new Promise<{ requestHeaders?: Record<string, string | string[]> }>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: blockingEntries.length,
        timeoutHandle,
        merge: (results) =>
          this.mergeRequestHeaders(details.requestHeaders as any, results),
      })

      for (const entry of matching) {
        const isBlocking = Array.isArray(entry.extraInfoSpec)
          ? entry.extraInfoSpec.includes('blocking')
          : false

        const toSend = isBlocking
          ? ({ ...payloadWithId, listenerId: entry.id } as any)
          : payloadWithId

        const filtered = this.filterDetailsForListener(toSend, entry.extraInfoSpec)
        this.ctx.router.sendEvent(entry.extensionId, 'webRequest.onBeforeSendHeaders', filtered)
      }
    })
  }

  async notifyOnSendHeaders(details: Electron.OnSendHeadersListenerDetails): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      requestHeaders: details.requestHeaders as any,
    }

    const matching = this.findMatchingListeners(this.onSendHeadersListeners, payloadBase)
    if (matching.length === 0) return

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId = { ...payloadBase, requestId }

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadWithId,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onSendHeaders',
        filtered,
      )
    }
  }

  async notifyOnHeadersReceived(
    details: Electron.OnHeadersReceivedListenerDetails,
  ): Promise<{ responseHeaders?: Record<string, string | string[]> }> {
    const url = details.url
    if (!url) return {}

    const baseDetails = this.buildDetails(details as unknown as ElectronRequestDetails)
    const payloadBase: WebRequestDetails = {
      ...baseDetails,
      statusCode: (details as any).statusCode,
      responseHeaders: details.responseHeaders as any,
    }

    const matching = this.scopeListenersToInitiatorExtension(
      this.findMatchingListeners(this.onHeadersReceivedListeners, payloadBase),
      payloadBase.initiator,
    )
    if (matching.length === 0) return {}

    const hasBlocking = matching.some((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking')
    })

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId: WebRequestDetails = { ...payloadBase, requestId }

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(
          payloadWithId,
          entry.extraInfoSpec,
        )
        this.ctx.router.sendEvent(
          entry.extensionId,
          'webRequest.onHeadersReceived',
          filtered,
        )
      }
      return {}
    }

    const blockingEntries = matching.filter((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking')
    })

    return new Promise<{ responseHeaders?: Record<string, string | string[]> }>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: blockingEntries.length,
        timeoutHandle,
        merge: (results) =>
          this.mergeResponseHeaders(details.responseHeaders as any, results),
      })

      for (const entry of matching) {
        const isBlocking = Array.isArray(entry.extraInfoSpec)
          ? entry.extraInfoSpec.includes('blocking')
          : false

        const toSend = isBlocking
          ? ({ ...payloadWithId, listenerId: entry.id } as any)
          : payloadWithId

        const filtered = this.filterDetailsForListener(toSend, entry.extraInfoSpec)
        this.ctx.router.sendEvent(entry.extensionId, 'webRequest.onHeadersReceived', filtered)
      }
    })
  }

  async notifyOnResponseStarted(
    details: Electron.OnResponseStartedListenerDetails,
  ): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      statusCode: (details as any).statusCode,
      responseHeaders: details.responseHeaders as any,
      ip: (details as any).ip,
      fromCache: (details as any).fromCache,
    }

    const matching = this.findMatchingListeners(this.onResponseStartedListeners, payloadBase)
    if (matching.length === 0) return

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId = { ...payloadBase, requestId }

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadWithId,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onResponseStarted',
        filtered,
      )
    }
  }

  async notifyOnCompleted(details: Electron.OnCompletedListenerDetails): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      statusCode: (details as any).statusCode,
      responseHeaders: details.responseHeaders as any,
      ip: (details as any).ip,
      fromCache: (details as any).fromCache,
    }

    const matching = this.findMatchingListeners(this.onCompletedListeners, payloadBase)
    if (matching.length === 0) return

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId = { ...payloadBase, requestId }

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadWithId,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onCompleted',
        filtered,
      )
    }
  }

  async notifyOnErrorOccurred(
    details: Electron.OnErrorOccurredListenerDetails,
  ): Promise<void> {
    const url = details.url
    if (!url) return

    const payloadBase: WebRequestDetails = {
      ...this.buildDetails(details as unknown as ElectronRequestDetails),
      error: (details as any).error,
    }

    const matching = this.findMatchingListeners(this.onErrorOccurredListeners, payloadBase)
    if (matching.length === 0) return

    const requestId =
      payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId = { ...payloadBase, requestId }

    for (const entry of matching) {
      const filtered = this.filterDetailsForListener(
        payloadWithId,
        entry.extraInfoSpec,
      )
      this.ctx.router.sendEvent(
        entry.extensionId,
        'webRequest.onErrorOccurred',
        filtered,
      )
    }
  }

  async notifyOnAuthRequired(
    details: ElectronRequestDetails,
  ): Promise<{ cancel?: boolean; authCredentials?: { username: string; password: string } }> {
    const url = details.url
    if (!url) return {}

    const payloadBase = this.buildDetails(details)
    const matching = this.findMatchingListeners(this.onAuthRequiredListeners, payloadBase)
    if (matching.length === 0) return {}

    const hasBlocking = matching.some((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking') || e.extraInfoSpec.includes('asyncBlocking')
    })

    const requestId = payloadBase.requestId || `wr-${++this.requestIdCounter}`
    const payloadWithId: WebRequestDetails = { ...payloadBase, requestId }

    if (!hasBlocking) {
      for (const entry of matching) {
        const filtered = this.filterDetailsForListener(payloadWithId, entry.extraInfoSpec)
        this.ctx.router.sendEvent(entry.extensionId, 'webRequest.onAuthRequired', filtered)
      }
      return {}
    }

    const blockingEntries = matching.filter((e) => {
      if (!Array.isArray(e.extraInfoSpec)) return false
      return e.extraInfoSpec.includes('blocking') || e.extraInfoSpec.includes('asyncBlocking')
    })

    return new Promise<{ cancel?: boolean; authCredentials?: { username: string; password: string } }>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.settlePending(requestId)
      }, BLOCKING_RESPONSE_TIMEOUT_MS)

      this.pendingBlocking.set(requestId, {
        resolve,
        results: new Map(),
        expectedCount: blockingEntries.length,
        timeoutHandle,
        merge: (results) => this.mergeAuthRequired(results as Map<string, WebRequestBlockingResponse>),
      })

      for (const entry of matching) {
        const isBlocking = Array.isArray(entry.extraInfoSpec)
          ? entry.extraInfoSpec.includes('blocking') || entry.extraInfoSpec.includes('asyncBlocking')
          : false

        const toSend = isBlocking
          ? ({ ...payloadWithId, listenerId: entry.id } as any)
          : payloadWithId

        const filtered = this.filterDetailsForListener(toSend, entry.extraInfoSpec)
        this.ctx.router.sendEvent(entry.extensionId, 'webRequest.onAuthRequired', filtered)
      }
    })
  }
}
