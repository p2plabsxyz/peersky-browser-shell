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
 * extension's pages. A tab that navigates to such a page is detached. The
 * DevTools commands that reach past the page (the browser itself, other
 * targets, the file system) are refused, as Chrome refuses them for
 * extensions.
 */

const SUPPORTED_VERSIONS = new Set(['1.0', '1.1', '1.2', '1.3'])

/** Commands Chrome does not let an extension's debugger client run. */
const BLOCKED_METHODS = new Set([
  'Target.attachToBrowserTarget',
  'Target.createBrowserContext',
  'Target.disposeBrowserContext',
  'Target.exposeDevToolsProtocol',
  'Target.setRemoteLocations',
  'Target.setDiscoverTargets',
  'Target.getBrowserContexts',
  'Page.setDownloadBehavior',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
])
const BLOCKED_DOMAINS = ['Browser.', 'SystemInfo.', 'Tethering.', 'Extensions.', 'PWA.', 'Cast.']

/** Schemes of web content a debugger may see. Everything else is the browser's own. */
const OPEN_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:', 'ftp:'])

type Attachment = {
  tabId: number
  onDetach: (event: Electron.Event, reason: string) => void
  onMessage: (event: Electron.Event, method: string, params: object, sessionId?: string) => void
  onNavigate: (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void
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
    const entry: Attachment = {
      tabId,
      onDetach: (_event, reason) => {
        // Electron says "target closed" or "Render process gone."; Chrome has two reasons.
        const chromeReason = /closed|gone|crash/i.test(String(reason)) ? 'target_closed' : 'canceled_by_user'
        d(`debugger detached from tab ${tabId}: ${chromeReason}`)
        if (this.release(tabId, { detach: false })) {
          this.ctx.router.sendEvent(extensionId, 'debugger.onDetach', source(), chromeReason)
        }
      },
      onMessage: (_event, method, params, sessionId) => {
        this.ctx.router.sendEvent(extensionId, 'debugger.onEvent', source(sessionId), method, params)
      },
      onNavigate: (details) => {
        if (!details.isMainFrame || details.isSameDocument) return
        if (!this.refusal(extension, details.url)) return
        // The tab is going somewhere the extension may not debug.
        if (this.release(tabId, { detach: true })) {
          this.ctx.router.sendEvent(extensionId, 'debugger.onDetach', source(), 'target_closed')
        }
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
    if (BLOCKED_METHODS.has(method) || BLOCKED_DOMAINS.some((domain) => method.startsWith(domain))) {
      throw this.protocolError(`'${method}' wasn't found`)
    }
    if (method === 'Page.navigate' || method === 'Target.createTarget') {
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
