import { randomUUID } from 'node:crypto'
import debug from 'debug'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const d = debug('electron-chrome-extensions:debugger')

/**
 * chrome.debugger
 *
 * An extension attaches to tabs only: never to the host's own windows, to
 * browser pages, to local files without file access, or to another
 * extension's pages. A tab or one of its frames that goes to such a page is
 * detached, on a redirect too.
 *
 * Electron's debugger client is a trusted one: through it a page's session
 * could list every target and attach to the host's windows and other
 * extensions' workers, read local files and clear any origin's data. So each
 * command is checked here as Chrome checks an extension's client: only the
 * domains Chrome lists for chrome.debugger, only the page's own frames and
 * workers through Target, and only the page's own origin where a command
 * names one.
 */

const SUPPORTED_VERSIONS = new Set(['1.0', '1.1', '1.2', '1.3'])

/** The DevTools domains Chrome lets an extension use (developer.chrome.com/docs/extensions/reference/api/debugger). */
const ALLOWED_DOMAINS = new Set([
  'Accessibility',
  'Audits',
  'CacheStorage',
  'Console',
  'CSS',
  'Database',
  'Debugger',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'Emulation',
  'Fetch',
  'IO',
  'Input',
  'Inspector',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'Profiler',
  'Runtime',
  'Storage',
  'Target',
  'WebAudio',
  'WebAuthn',
])

/**
 * Commands in those domains that reach past the page: the whole browser's
 * cookies and cache, downloads to disk, and fetches the browser makes itself.
 * Tracing, in Chrome's list too, is left out: Electron's records every process.
 */
const BLOCKED_METHODS = new Set([
  'Page.setDownloadBehavior',
  'Network.getAllCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Network.loadNetworkResource',
])

/** Through Target an extension only auto-attaches the page's own frames and workers, as in Chrome. */
const TARGET_METHODS = new Set(['Target.setAutoAttach', 'Target.detachFromTarget'])

/** Storage commands allowed, each for the page's own origin only. */
const STORAGE_METHODS = new Set([
  'Storage.getStorageKeyForFrame',
  'Storage.clearDataForOrigin',
  'Storage.clearDataForStorageKey',
  'Storage.getUsageAndQuota',
  'Storage.trackCacheStorageForOrigin',
  'Storage.untrackCacheStorageForOrigin',
  'Storage.trackCacheStorageForStorageKey',
  'Storage.untrackCacheStorageForStorageKey',
  'Storage.trackIndexedDBForOrigin',
  'Storage.untrackIndexedDBForOrigin',
  'Storage.trackIndexedDBForStorageKey',
  'Storage.untrackIndexedDBForStorageKey',
])

/** Network commands that name cookies' sites: the extension needs host access to each. */
const COOKIE_METHODS = new Set(['Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies'])

/** Schemes of web content a debugger may see. Everything else is the browser's own. */
const OPEN_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:', 'ftp:'])

type Attachment = {
  tabId: number
  /** Child sessions of the page's own frames and workers, by session id: their target id. */
  sessions: Map<string, string>
  onDetach: (event: Electron.Event, reason: string) => void
  onMessage: (event: Electron.Event, method: string, params: any, sessionId?: string) => void
  onNavigate: (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void
  onCommitted: (event: Electron.Event, url: string) => void
  onDestroyed: () => void
}

export class DebuggerAPI {
  /** tabId -> the extension attached to it. Electron has one debugger per page. */
  private attached = new Map<number, { extensionId: string; entry: Attachment }>()
  private targetIds = new WeakMap<Electron.WebContents, string>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('debugger.attach', this.attach)
    handle('debugger.detach', this.detach)
    handle('debugger.getTargets', this.getTargets)
    handle('debugger.sendCommand', this.sendCommand)

    const sessionExtensions = ctx.session.extensions || (ctx.session as any)
    sessionExtensions.on('extension-unloaded', (_event: any, extension: Electron.Extension) => {
      for (const [tabId, { extensionId }] of [...this.attached]) {
        if (extensionId === extension.id) this.release(tabId, { detach: true })
      }
    })
  }

  private targetId(tab: Electron.WebContents) {
    let id = this.targetIds.get(tab)
    if (!id) {
      id = randomUUID().replace(/-/g, '').toUpperCase()
      this.targetIds.set(tab, id)
    }
    return id
  }

  /** Chrome's refusal for a page the extension may not debug, or undefined. */
  private refusal(extension: Electron.Extension, url: string): string | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url ? 'Cannot attach to this target.' : undefined
    }
    if (parsed.protocol === 'chrome:') return 'Cannot access a chrome:// URL'
    if (parsed.protocol === 'chrome-extension:') {
      return parsed.hostname === extension.id
        ? undefined
        : 'Cannot access a chrome-extension:// URL of different extension'
    }
    if (parsed.protocol === 'file:') {
      return this.ctx.permissions.hasHostAccess(extension, url) ? undefined : `Cannot access contents of url "${url}".`
    }
    if (!OPEN_SCHEMES.has(parsed.protocol)) return 'Cannot attach to this target.'
    if (parsed.protocol === 'about:' && parsed.href !== 'about:blank' && parsed.href !== 'about:srcdoc') {
      return 'Cannot attach to this target.'
    }
    return undefined
  }

  /** The tab a Debuggee names, or Chrome's error. */
  private resolve(extension: Electron.Extension, target: chrome.debugger.Debuggee) {
    if (!target || typeof target !== 'object') {
      throw new Error("Error at parameter 'target': Invalid type: expected debugger.Debuggee.")
    }
    if (typeof target.extensionId === 'string') {
      if (target.extensionId !== extension.id) {
        throw new Error('Cannot access a chrome-extension:// URL of different extension')
      }
      throw new Error(`No background page with given id ${target.extensionId}.`)
    }
    if (typeof target.targetId === 'string') {
      const tab = [...this.ctx.store.tabs].find((t) => !t.isDestroyed() && this.targetIds.get(t) === target.targetId)
      if (!tab) throw new Error(`No target with given id ${target.targetId}.`)
      return { tab, tabId: tab.id, kind: 'target', label: target.targetId }
    }
    if (!Number.isInteger(target.tabId)) {
      throw new Error('Either tab id or extension id must be specified.')
    }
    const tab = this.ctx.store.getTabById(target.tabId as number)
    if (!tab || tab.isDestroyed()) throw new Error(`No tab with given id ${target.tabId}.`)
    return { tab, tabId: tab.id, kind: 'tab', label: String(target.tabId) }
  }

  private attach = async (
    { extension }: ExtensionEvent,
    target: chrome.debugger.Debuggee,
    requiredVersion?: string,
  ) => {
    const { tab, tabId, kind, label } = this.resolve(extension, target)
    if (typeof requiredVersion !== 'string' || !SUPPORTED_VERSIONS.has(requiredVersion)) {
      throw new Error(`Requested protocol version is not supported: ${String(requiredVersion).slice(0, 32)}.`)
    }
    const refused = this.refusal(extension, tab.getURL())
    if (refused) throw new Error(refused)
    if (this.attached.has(tabId) || tab.debugger.isAttached()) {
      throw new Error(`Another debugger is already attached to the ${kind} with id: ${label}.`)
    }

    const extensionId = extension.id
    const source = (sessionId?: string) => {
      const out: Record<string, any> = kind === 'tab' ? { tabId } : { targetId: label }
      if (sessionId) out.sessionId = sessionId
      return out
    }
    const leave = () => {
      // The tab is going somewhere the extension may not debug.
      if (this.release(tabId, { detach: true })) {
        this.ctx.router.sendEvent(extensionId, 'debugger.onDetach', source(), 'target_closed')
      }
    }
    const sessions = new Map<string, string>()
    const dropSession = (sessionId: string) => {
      sessions.delete(sessionId)
      tab.debugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
    const entry: Attachment = {
      tabId,
      sessions,
      onDetach: (_event, reason) => {
        // Electron says "target closed" or "Render process gone."; Chrome has two reasons.
        const chromeReason = /closed|gone|crash/i.test(String(reason)) ? 'target_closed' : 'canceled_by_user'
        d(`debugger detached from tab ${tabId}: ${chromeReason}`)
        if (this.release(tabId, { detach: false })) {
          this.ctx.router.sendEvent(extensionId, 'debugger.onDetach', source(), chromeReason)
        }
      },
      onMessage: (_event, method, params, sessionId) => {
        // Nothing from a session the extension was not given.
        if (sessionId && !sessions.has(sessionId)) return
        if (method === 'Target.attachedToTarget') {
          const child = params?.sessionId
          const info = params?.targetInfo || {}
          if (typeof child !== 'string') return
          // A frame or worker of another extension, or of the browser, stays out of reach.
          if (this.refusal(extension, String(info.url ?? '')) || !['iframe', 'worker', 'shared_worker', 'service_worker', 'page'].includes(info.type)) {
            dropSession(child)
            return
          }
          sessions.set(child, String(info.targetId ?? ''))
        } else if (method === 'Target.detachedFromTarget') {
          if (typeof params?.sessionId === 'string') sessions.delete(params.sessionId)
        } else if (method === 'Target.targetInfoChanged') {
          const info = params?.targetInfo || {}
          const child = [...sessions].find(([, targetId]) => targetId && targetId === info.targetId)?.[0]
          if (child && this.refusal(extension, String(info.url ?? ''))) {
            dropSession(child)
            return
          }
        }
        this.ctx.router.sendEvent(extensionId, 'debugger.onEvent', source(sessionId), method, params)
      },
      onNavigate: (details) => {
        if (!details.isMainFrame || details.isSameDocument) return
        if (this.refusal(extension, details.url)) leave()
      },
      onCommitted: (_event, url) => {
        if (this.refusal(extension, url)) leave()
      },
      onDestroyed: () => {
        if (this.release(tabId, { detach: false })) {
          this.ctx.router.sendEvent(extensionId, 'debugger.onDetach', source(), 'target_closed')
        }
      },
    }

    try {
      tab.debugger.attach(requiredVersion)
    } catch (err: any) {
      const message = String(err?.message || err)
      if (/already attached/i.test(message)) {
        throw new Error(`Another debugger is already attached to the ${kind} with id: ${label}.`)
      }
      throw new Error(message)
    }
    tab.debugger.on('detach', entry.onDetach)
    tab.debugger.on('message', entry.onMessage)
    tab.on('did-start-navigation', entry.onNavigate)
    // A redirect can take an allowed address somewhere refused.
    tab.on('did-redirect-navigation', entry.onNavigate)
    tab.on('did-navigate', entry.onCommitted)
    tab.once('destroyed', entry.onDestroyed)
    this.attached.set(tabId, { extensionId, entry })
    d(`extension ${extensionId} attached debugger to tab ${tabId}`)
  }

  /** Forgets an attachment; resolves whether there was one. */
  private release(tabId: number, opts: { detach: boolean }) {
    const current = this.attached.get(tabId)
    if (!current) return false
    this.attached.delete(tabId)
    const tab = this.ctx.store.getTabById(tabId)
    if (tab && !tab.isDestroyed()) {
      tab.debugger.removeListener('detach', current.entry.onDetach)
      tab.debugger.removeListener('message', current.entry.onMessage)
      tab.removeListener('did-start-navigation', current.entry.onNavigate)
      tab.removeListener('did-redirect-navigation', current.entry.onNavigate)
      tab.removeListener('did-navigate', current.entry.onCommitted)
      tab.removeListener('destroyed', current.entry.onDestroyed)
      if (opts.detach) {
        try {
          tab.debugger.detach()
        } catch {}
      }
    }
    return true
  }

  private attachedTab(extension: Electron.Extension, target: chrome.debugger.Debuggee) {
    let resolved: ReturnType<DebuggerAPI['resolve']>
    try {
      resolved = this.resolve(extension, target)
    } catch (error) {
      const kind = typeof target?.targetId === 'string' ? 'target' : 'tab'
      const label = kind === 'target' ? target.targetId : target?.tabId
      if (/^No (tab|target) with given id/.test((error as Error).message)) {
        throw new Error(`Debugger is not attached to the ${kind} with id: ${label}.`)
      }
      throw error
    }
    const current = this.attached.get(resolved.tabId)
    if (!current || current.extensionId !== extension.id) {
      throw new Error(`Debugger is not attached to the ${resolved.kind} with id: ${resolved.label}.`)
    }
    return resolved
  }

  private detach = async ({ extension }: ExtensionEvent, target: chrome.debugger.Debuggee) => {
    const { tabId } = this.attachedTab(extension, target)
    // Chrome sends no onDetach to the extension that detached itself.
    this.release(tabId, { detach: true })
    d(`extension ${extension.id} detached debugger from tab ${tabId}`)
  }

  private getTargets = (_event: ExtensionEvent): chrome.debugger.TargetInfo[] => {
    const results: chrome.debugger.TargetInfo[] = []
    for (const tab of this.ctx.store.tabs) {
      if (tab.isDestroyed()) continue
      results.push({
        type: 'page' as const,
        id: this.targetId(tab),
        tabId: tab.id,
        attached: this.attached.has(tab.id) || tab.debugger.isAttached(),
        title: tab.getTitle(),
        url: tab.getURL(),
      })
    }
    return results
  }

  /** Chrome passes a failed command's protocol error on as JSON. */
  private protocolError(message: string) {
    let code = -32000
    if (/wasn't found|not found/i.test(message)) code = -32601
    else if (/invalid param/i.test(message)) code = -32602
    return new Error(JSON.stringify({ code, message }))
  }

  /** Refuses a command Chrome refuses an extension's client, as a protocol error. */
  private checkCommand(
    extension: Electron.Extension,
    tab: Electron.WebContents,
    method: string,
    params: Record<string, any>,
  ) {
    const domain = method.split('.')[0]
    if (!ALLOWED_DOMAINS.has(domain) || BLOCKED_METHODS.has(method)) {
      throw this.protocolError(`'${method}' wasn't found`)
    }
    if (domain === 'Target') {
      if (!TARGET_METHODS.has(method)) throw this.protocolError('Not allowed')
      if (method === 'Target.setAutoAttach' && params.flatten !== true) {
        throw this.protocolError('Only flatten protocol is supported with chrome.debugger')
      }
      if (method === 'Target.detachFromTarget') {
        const current = this.attached.get(tab.id)
        if (typeof params.sessionId !== 'string' || !current?.entry.sessions.has(params.sessionId)) {
          throw this.protocolError('Session with given id not found.')
        }
      }
      return
    }
    if (method === 'DOM.setFileInputFiles' && !this.ctx.permissions.hasHostAccess(extension, 'file:///')) {
      // Chrome lets only an extension with file access put local files in a page.
      throw this.protocolError('Not allowed')
    }
    if (domain === 'Storage' || domain === 'CacheStorage') {
      if (domain === 'Storage' && !STORAGE_METHODS.has(method)) throw this.protocolError('Not allowed')
      let origin: string
      try {
        origin = new URL(tab.getURL()).origin
      } catch {
        throw this.protocolError('Not allowed')
      }
      const named = [params.origin, params.securityOrigin, params.storageKey, params.cacheId].filter(
        (value) => value !== undefined,
      )
      const own = (value: unknown) =>
        typeof value === 'string' &&
        origin !== 'null' &&
        (value === origin || value.startsWith(`${origin}/`) || value.startsWith(`${origin}|`))
      if (named.some((value) => !own(value))) throw this.protocolError('Not allowed')
      if (domain === 'CacheStorage' && named.length === 0 && method !== 'CacheStorage.requestCacheNames') {
        throw this.protocolError('Not allowed')
      }
      return
    }
    if (COOKIE_METHODS.has(method)) {
      const urls: string[] = []
      const add = (cookie: any) => {
        if (typeof cookie?.url === 'string') urls.push(cookie.url)
        else if (typeof cookie?.domain === 'string') urls.push(`https://${cookie.domain.replace(/^\./, '')}/`)
      }
      if (method === 'Network.getCookies') {
        for (const url of Array.isArray(params.urls) ? params.urls : []) urls.push(String(url))
      } else if (method === 'Network.setCookies') {
        for (const cookie of Array.isArray(params.cookies) ? params.cookies : []) add(cookie)
        if (urls.length !== (Array.isArray(params.cookies) ? params.cookies.length : 0)) throw this.protocolError('Not allowed')
      } else {
        add(params)
        if (urls.length === 0) throw this.protocolError('Not allowed')
      }
      if (urls.some((url) => !this.ctx.permissions.hasHostAccess(extension, url))) {
        throw this.protocolError('Not allowed')
      }
    }
  }

  private sendCommand = async (
    { extension }: ExtensionEvent,
    target: chrome.debugger.Debuggee & { sessionId?: string },
    method: string,
    commandParams?: Record<string, any>,
  ) => {
    const { tab, tabId } = this.attachedTab(extension, target)
    if (typeof method !== 'string' || method.length > 256) {
      throw new Error("Error at parameter 'method': Invalid type: expected string.")
    }
    if (commandParams !== undefined && (commandParams === null || typeof commandParams !== 'object')) {
      throw new Error("Error at parameter 'commandParams': Invalid type: expected object.")
    }
    const current = this.attached.get(tabId)!
    // A page the extension may not debug, reached in a way no event told.
    if (this.refusal(extension, tab.getURL())) {
      if (this.release(tabId, { detach: true })) {
        this.ctx.router.sendEvent(extension.id, 'debugger.onDetach', { tabId }, 'target_closed')
      }
      throw new Error('Detached while handling command.')
    }
    if (target.sessionId !== undefined && !current.entry.sessions.has(String(target.sessionId))) {
      throw this.protocolError('Session with given id not found.')
    }
    this.checkCommand(extension, tab, method, commandParams || {})
    if (method === 'Page.navigate') {
      const url = String(commandParams?.url ?? '')
      const refused = this.refusal(extension, url)
      if (refused) throw this.protocolError(refused)
    }

    // CDP Page.reload can make a new page and drop the debugger; a native
    // reload keeps the same page and session.
    if (method === 'Page.reload' && !target.sessionId) {
      const params = (commandParams || {}) as { scriptToEvaluateOnLoad?: string; ignoreCache?: boolean }
      if (params.scriptToEvaluateOnLoad) {
        try {
          await tab.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: params.scriptToEvaluateOnLoad,
          })
        } catch (e) {
          d(`Page.addScriptToEvaluateOnNewDocument failed: ${e}`)
        }
      }
      if (params.ignoreCache) tab.reloadIgnoringCache()
      else tab.reload()
      return {}
    }

    d(`sending CDP command ${method} to tab ${tabId}`)
    try {
      return await tab.debugger.sendCommand(method, commandParams, target.sessionId)
    } catch (error) {
      if (!this.attached.has(tabId)) throw new Error('Detached while handling command.')
      throw this.protocolError(String((error as Error)?.message || error))
    }
  }
}
