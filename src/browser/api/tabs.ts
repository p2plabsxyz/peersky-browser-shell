import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { parseMatchPattern, ParsedMatchPattern, urlMatches } from '../match-pattern'
import { TabContents } from './common'
import type { WindowsAPI, WindowDetails } from './windows'
import debug from 'debug'

const d = debug('electron-chrome-extensions:tabs')

/** A chrome.tabs.Tab with the fields Chrome 157 gives. */
export type TabDetails = chrome.tabs.Tab & {
  splitViewId?: number
  lastAccessed?: number
  pendingUrl?: string
}

// ------------------------------------------------------------ shared helpers

/**
 * The tab, window, group and session APIs of one session reach each other
 * through this, since each is built on its own and none owns the others.
 */
export interface TabGroupsLink {
  /** The group a tab is in, or -1. */
  groupIdOf(tabId: number): number
  /** A tab moved: it joins or leaves a group by where it now sits. */
  tabMoved(tabId: number): void
  /** A tab is gone from its window. */
  tabRemoved(tabId: number): void
  /** A tab is being pinned, and pinned tabs are never grouped. */
  leaveGroup(tabId: number): void
}

export interface SessionsLink {
  tabClosed(details: TabDetails, windowClosing: boolean): void
  windowClosed(windowId: number, details: WindowDetails | undefined): void
}

interface TabApis {
  tabs?: TabsAPI
  windows?: WindowsAPI
  groups?: TabGroupsLink
  sessions?: SessionsLink
}

const registry = new WeakMap<object, TabApis>()

export const tabApis = (ctx: ExtensionContext): TabApis => {
  let apis = registry.get(ctx.store)
  if (!apis) registry.set(ctx.store, (apis = {}))
  return apis
}

export const noTabError = (id: unknown) => new Error(`No tab with id: ${id}.`)
export const noWindowError = (id: unknown) => new Error(`No window with id: ${id}.`)

/** Chrome's wording for an argument its schema refuses. */
export function argumentError(
  signature: string,
  parameter: string,
  path: Array<string | number>,
  message: string,
) {
  const at = path
    .map((p) => (typeof p === 'number' ? `Error at index ${p}: ` : `Error at property '${p}': `))
    .join('')
  return new Error(`Error in invocation of ${signature}: Error at parameter '${parameter}': ${at}${message}`)
}

export const signatureError = (signature: string) =>
  new Error(`Error in invocation of ${signature}: No matching signature.`)

/** Chrome lists the allowed values of an enum in sorted order. */
export const oneOf = (values: readonly string[]) => `Value must be one of ${[...values].sort().join(', ')}.`

export type ValueType = 'integer' | 'number' | 'string' | 'boolean' | 'object' | 'array'

const typeName = (v: unknown) =>
  Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v

export const fits = (v: unknown, type: ValueType) => {
  switch (type) {
    case 'integer':
      return Number.isSafeInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v)
    case 'array':
      return Array.isArray(v)
    default:
      return typeof v === type
  }
}

export type PropRule = ValueType | readonly string[] | ((value: any) => string | undefined)

/**
 * Checks the properties of an object argument the way Chrome's bindings do,
 * so a wrong type or enum value fails with Chrome's message.
 */
export function checkProps(
  signature: string,
  parameter: string,
  value: unknown,
  rules: Record<string, PropRule>,
  opts: { optional?: boolean; required?: string[] } = {},
): Record<string, any> {
  if (value === undefined || value === null) {
    if (opts.optional) return {}
    throw signatureError(signature)
  }
  if (!fits(value, 'object')) throw signatureError(signature)
  const obj = value as Record<string, any>
  for (const key of opts.required || []) {
    if (obj[key] === undefined) {
      throw new Error(
        `Error in invocation of ${signature}: Error at parameter '${parameter}': Missing required property '${key}'.`,
      )
    }
  }
  for (const [key, rule] of Object.entries(rules)) {
    const v = obj[key]
    if (v === undefined) continue
    if (Array.isArray(rule)) {
      if (typeof v !== 'string') {
        throw argumentError(signature, parameter, [key], `Invalid type: expected string, found ${typeName(v)}.`)
      }
      if (!rule.includes(v)) throw argumentError(signature, parameter, [key], oneOf(rule))
    } else if (typeof rule === 'function') {
      const message = rule(v)
      if (message) throw argumentError(signature, parameter, [key], message)
    } else if (!fits(v, rule as ValueType)) {
      throw argumentError(signature, parameter, [key], `Invalid type: expected ${rule}, found ${typeName(v)}.`)
    }
  }
  return obj
}

/** An integer at least `min`, or Chrome's message for why not. */
export const intAtLeast = (min: number) => (v: unknown) => {
  if (!Number.isSafeInteger(v)) return `Invalid type: expected integer, found ${typeName(v)}.`
  if ((v as number) < min) return `Value must be at least ${min}.`
  return undefined
}

/** Ids may come as one integer or a list of them. */
export function readIdList(signature: string, value: unknown, max = 10_000): number[] {
  const list = Array.isArray(value) ? value : [value]
  if (!Array.isArray(value) && !Number.isSafeInteger(value)) throw signatureError(signature)
  if (list.length > max) throw signatureError(signature)
  for (const id of list) if (!Number.isSafeInteger(id)) throw signatureError(signature)
  return list as number[]
}

/**
 * Glob for tabs.query({ title }): `*` is any run and `?` one character, as
 * Chrome's base::MatchPattern. In a match pattern's path only `*` is special,
 * so `anyChar` is off there. Greedy with one backtrack point, so a pattern
 * full of stars cannot stall the main process the way a regular expression can.
 */
export function globMatch(pattern: string, text: string, anyChar = true): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && ((anyChar && pattern[p] === '?') || (pattern[p] !== '*' && pattern[p] === text[t]))) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/** The path glob of a match pattern, matched with globMatch for the same reason. */
function safePattern(parsed: ParsedMatchPattern): ParsedMatchPattern {
  if (parsed.allUrls) return parsed
  const source = parsed.source
  let glob: string
  if (parsed.scheme === 'urn') glob = source.slice(4)
  else {
    const start = source.indexOf('/', source.indexOf('://') + 3)
    glob = start < 0 ? '/*' : source.slice(start)
  }
  // urlMatches only calls test() on the path.
  return { ...parsed, path: { test: (s: string) => globMatch(glob, s, false) } as unknown as RegExp }
}

const JAVASCRIPT_URL_ERROR =
  'JavaScript URLs are not allowed in API based extension navigations. Use chrome.scripting.executeScript instead.'

// chrome:// URLs that crash or hang a process, which Chrome never lets an
// extension open.
const KILL_HOSTS = new Set([
  'kill', 'crash', 'crashdump', 'hang', 'shorthang', 'gpuclean', 'gpucrash', 'gpuhang',
  'memory-exhaust', 'memory-pressure-critical', 'memory-pressure-moderate', 'inducebrowsercrashforrealz',
  'inducebrowserdcheckforrealz', 'quit', 'restart', 'webuijserror', 'browser-crash', 'checkcrash',
])

/**
 * The URL an extension asked a tab to open, resolved against the extension as
 * Chrome resolves it. Browser pages and other extensions' pages are refused:
 * an extension must not drive the browser's own UI or another extension.
 */
export function prepareNavigationUrl(
  input: string,
  extension: Electron.Extension,
  permissions?: ExtensionContext['permissions'],
): string {
  let url: URL
  try {
    url = new URL(input, extension.url)
  } catch {
    throw new Error(`Invalid url: "${input}".`)
  }
  switch (url.protocol) {
    case 'javascript:':
      throw new Error(JAVASCRIPT_URL_ERROR)
    case 'chrome:':
      if (KILL_HOSTS.has(url.hostname)) throw new Error("I'm sorry. I'm afraid I can't do that.")
      throw new Error('Cannot navigate to a chrome:// page.')
    case 'devtools:': {
      const allowed = !!permissions?.has(extension, 'debugger')
      throw new Error(
        allowed
          ? 'Cannot navigate to a devtools:// page.'
          : 'Cannot navigate to a devtools:// page without either the devtools or debugger permission.',
      )
    }
    case 'chrome-untrusted:':
      throw new Error('Cannot navigate to a chrome-untrusted:// page.')
    case 'peersky:':
      throw new Error('Cannot navigate to a peersky:// page.')
    case 'chrome-extension:':
      if (url.hostname !== extension.id) throw new Error("Cannot navigate to another extension's page.")
      break
    case 'view-source:':
      // The page shown is the one inside, which the same rules apply to.
      prepareNavigationUrl(url.href.slice('view-source:'.length), extension, permissions)
      break
  }
  return url.href
}

/** Browser pages and other extensions' pages, which no extension reads from. */
const isInternalPage = (url: string, extension: Electron.Extension) => {
  const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
  if (['chrome:', 'devtools:', 'chrome-untrusted:', 'peersky:', 'view-source:'].includes(scheme)) return true
  return scheme === 'chrome-extension:' && !url.startsWith(`chrome-extension://${extension.id}/`)
}

const TAB_STATUSES = ['unloaded', 'loading', 'complete'] as const
const WINDOW_TYPES = ['normal', 'popup', 'panel', 'app', 'devtools'] as const
const IMAGE_FORMATS = ['jpeg', 'png'] as const
const ZOOM_MODES = ['automatic', 'manual', 'disabled'] as const
const ZOOM_SCOPES = ['per-origin', 'per-tab'] as const

const SIG = {
  get: 'tabs.get(integer tabId, optional function callback)',
  update: 'tabs.update(optional integer tabId, object updateProperties, optional function callback)',
  move: 'tabs.move([integer|array] tabIds, object moveProperties, optional function callback)',
  remove: 'tabs.remove([integer|array] tabIds, optional function callback)',
  create: 'tabs.create(object createProperties, optional function callback)',
  query: 'tabs.query(object queryInfo, optional function callback)',
  highlight: 'tabs.highlight(object highlightInfo, optional function callback)',
  duplicate: 'tabs.duplicate(integer tabId, optional function callback)',
  discard: 'tabs.discard(optional integer tabId, optional function callback)',
  reload: 'tabs.reload(optional integer tabId, optional object reloadProperties, optional function callback)',
  goBack: 'tabs.goBack(optional integer tabId, optional function callback)',
  goForward: 'tabs.goForward(optional integer tabId, optional function callback)',
  capture:
    'tabs.captureVisibleTab(optional integer windowId, optional object options, optional function callback)',
  getZoom: 'tabs.getZoom(optional integer tabId, optional function callback)',
  setZoom: 'tabs.setZoom(optional integer tabId, number zoomFactor, optional function callback)',
  getZoomSettings: 'tabs.getZoomSettings(optional integer tabId, optional function callback)',
  setZoomSettings:
    'tabs.setZoomSettings(optional integer tabId, object zoomSettings, optional function callback)',
  detectLanguage: 'tabs.detectLanguage(optional integer tabId, optional function callback)',
}

/** Favicon checks kept per URL, so a page loaded again is not checked again. */
const FAVICON_CACHE_MAX = 256
const FAVICON_DATA_URL_MAX = 256 * 1024
const FAVICON_TIMEOUT_MS = 5000

interface TabState {
  pinned: boolean
  discarded: boolean
  autoDiscardable: boolean
  lastAccessed: number
  openerTabId?: number
  pendingUrl?: string
  /** The favicon, once it is known to load. */
  favIconUrl?: string
  /** The last mute change made through the API. */
  muteChange?: { muted: boolean; extensionId: string }
}

export class TabsAPI {
  static TAB_ID_NONE = -1
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  private state = new Map<number, TabState>()
  private tabZoomSettings = new Map<number, chrome.tabs.ZoomSettings>()
  private tabZoomFactors = new Map<number, number>()
  private originZoomFactors = new Map<string, number>()
  private highlightedTabsByWindow = new Map<number, Set<number>>()
  private tabOrderByWindow = new Map<number, number[]>()
  /** Tabs whose removal was already announced. */
  private removed = new Set<number>()
  private observed = new WeakSet<Electron.WebContents>()
  private faviconChecks = new Map<string, Promise<boolean>>()
  private captureCalls = new Map<string, number[]>()

  constructor(private ctx: ExtensionContext) {
    tabApis(ctx).tabs = this
    const handle = this.ctx.router.apiHandler()
    handle('tabs.get', this.get.bind(this))
    handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    handle('tabs.getCurrent', this.getCurrent.bind(this))
    handle('tabs.create', this.create.bind(this))
    handle('tabs.insertCSS', this.insertCSS.bind(this))
    handle('tabs.query', this.query.bind(this))
    handle('tabs.reload', this.reload.bind(this))
    handle('tabs.update', this.update.bind(this))
    handle('tabs.remove', this.remove.bind(this))
    handle('tabs.move', this.move.bind(this))
    handle('tabs.highlight', this.highlight.bind(this))
    handle('tabs.goForward', this.goForward.bind(this))
    handle('tabs.goBack', this.goBack.bind(this))
    handle('tabs.duplicate', this.duplicate.bind(this))
    handle('tabs.discard', this.discard.bind(this))
    handle('tabs.detectLanguage', this.detectLanguage.bind(this))
    handle('tabs.getZoom', this.getZoom.bind(this))
    handle('tabs.setZoom', this.setZoom.bind(this))
    handle('tabs.getZoomSettings', this.getZoomSettings.bind(this))
    handle('tabs.setZoomSettings', this.setZoomSettings.bind(this))
    // Chrome asks for '<all_urls>' or activeTab here, not "tabs".
    handle('tabs.captureVisibleTab', this.captureVisibleTab.bind(this), { permission: null })

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
    this.ctx.store.on('tab-removed', (tabId: number) => this.onRemoved(tabId))
  }

  // ---------------------------------------------------------- tab model

  private stateOf(tabId: number): TabState {
    let st = this.state.get(tabId)
    if (!st) {
      st = { pinned: false, discarded: false, autoDiscardable: true, lastAccessed: Date.now() }
      this.state.set(tabId, st)
    }
    return st
  }

  /** The tracked tab with this id. */
  getTab(tabId: number): TabContents | undefined {
    return this.ctx.store.getTabById(tabId) as TabContents | undefined
  }

  private requireTab(tabId: unknown): TabContents {
    const tab = typeof tabId === 'number' ? this.getTab(tabId) : undefined
    if (!tab) throw noTabError(tabId)
    return tab
  }

  /** The tab a call is about: the one named, or the active tab of the caller's window. */
  private targetTab(event: ExtensionEvent, tabId: unknown): TabContents {
    if (tabId === undefined || tabId === null) {
      const win = this.currentWindow(event)
      const tab = win ? this.ctx.store.getActiveTabFromWindow(win) : undefined
      if (!tab) throw new Error('No selected tab')
      return tab as TabContents
    }
    return this.requireTab(tabId)
  }

  windowOf(tab: Electron.WebContents): Electron.BaseWindow | undefined {
    const win = this.ctx.store.tabToWindow.get(tab)
    return win && !win.isDestroyed() ? win : undefined
  }

  private windows(): WindowsAPI | undefined {
    return tabApis(this.ctx).windows
  }

  private windowType(win: Electron.BaseWindow) {
    return this.windows()?.typeOf(win) ?? 'normal'
  }

  /** The window Chrome calls "current" for this caller. */
  currentWindow(event: ExtensionEvent): Electron.BaseWindow | null {
    const store = this.ctx.store
    if (event.type === 'frame') {
      const sender = event.sender
      if (sender && !sender.isDestroyed()) {
        // An extension page shown in a tab: that tab's window.
        if (store.tabs.has(sender)) {
          const win = this.windowOf(sender)
          if (win) return win
        }
        // A popup: the browser window it belongs to.
        const own = BrowserWindow.fromWebContents(sender)
        const parent = own?.getParentWindow?.()
        for (const candidate of [parent, own]) {
          if (candidate && !candidate.isDestroyed() && store.windows.has(candidate)) return candidate
        }
      }
    }
    const win = store.getCurrentWindowForExtension(event.extension.id)
    if (win && !win.isDestroyed()) return win
    return null
  }

  /** The tabs of a window, in their order there. */
  windowTabs(win: Electron.BaseWindow | undefined): TabContents[] {
    if (!win || win.isDestroyed()) return []
    const tabs = Array.from(this.ctx.store.tabs).filter(
      (tab) => !tab.isDestroyed() && this.ctx.store.tabToWindow.get(tab) === win,
    ) as TabContents[]
    const getTabIndex = this.ctx.store.impl.getTabIndex
    const order = this.tabOrderByWindow.get(win.id) || []
    const ours = new Map(order.map((id, i) => [id, i]))
    const rank = (tab: TabContents) => {
      if (typeof getTabIndex === 'function') {
        const i = getTabIndex(tab, win)
        if (typeof i === 'number' && i >= 0) return i
      }
      return ours.get(tab.id) ?? Number.MAX_SAFE_INTEGER
    }
    const ranks = new Map(tabs.map((tab) => [tab.id, rank(tab)]))
    return tabs.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || (ours.get(a.id) ?? 0) - (ours.get(b.id) ?? 0))
  }

  private indexOf(tab: TabContents, win: Electron.BaseWindow | undefined) {
    if (!win) return -1
    return this.windowTabs(win).findIndex((candidate) => candidate.id === tab.id)
  }

  isPinned(tabId: number) {
    return !!this.state.get(tabId)?.pinned
  }

  private pinnedCount(win: Electron.BaseWindow, except?: number) {
    return this.windowTabs(win).filter((t) => t.id !== except && this.isPinned(t.id)).length
  }

  /**
   * Moves a tab within its window, through the host when it keeps the order,
   * and tells extensions. Returns the index it landed at.
   */
  async moveInWindow(tab: TabContents, win: Electron.BaseWindow, toIndex: number, opts: { silent?: boolean } = {}) {
    const fromIndex = this.indexOf(tab, win)
    if (fromIndex < 0) return -1
    const count = this.windowTabs(win).length
    const target = Math.max(0, Math.min(toIndex, count - 1))
    let landed = target
    if (target !== fromIndex) {
      if (typeof this.ctx.store.impl.moveTab === 'function') {
        const result = await this.ctx.store.impl.moveTab(tab, win, target)
        if (typeof result === 'number' && result >= 0) landed = result
      }
      this.reorder(win.id, tab.id, landed)
    }
    const actual = this.indexOf(tab, win)
    this.patchCachedPositions(win)
    if (actual !== fromIndex && !opts.silent) {
      this.ctx.router.broadcastEvent('tabs.onMoved', tab.id, {
        windowId: win.id,
        fromIndex,
        toIndex: actual,
      } satisfies chrome.tabs.TabMoveInfo)
    }
    return actual
  }

  private reorder(winId: number, tabId: number, toIndex: number) {
    const win = this.ctx.store.getWindowById(winId)
    // Start from the order as it is now, which the host may have changed.
    const current = win ? this.windowTabs(win).map((t) => t.id) : [...(this.tabOrderByWindow.get(winId) || [])]
    const from = current.indexOf(tabId)
    if (from >= 0) current.splice(from, 1)
    current.splice(Math.max(0, Math.min(toIndex, current.length)), 0, tabId)
    this.tabOrderByWindow.set(winId, current)
  }

  /** Index, active and highlighted change without an onUpdated; keep the cache right. */
  private patchCachedPositions(win: Electron.BaseWindow | undefined) {
    if (!win) return
    const active = this.ctx.store.getActiveTabFromWindow(win)
    const highlighted = this.highlightedTabsByWindow.get(win.id)
    this.windowTabs(win).forEach((tab, index) => {
      const cached = this.ctx.store.tabDetailsCache.get(tab.id)
      if (!cached) return
      cached.index = index
      cached.windowId = win.id
      cached.active = active?.id === tab.id
      cached.highlighted = cached.active || !!highlighted?.has(tab.id)
      cached.selected = cached.highlighted
    })
  }

  private mutedInfo(tab: TabContents, st: TabState): chrome.tabs.MutedInfo {
    const muted = tab.isAudioMuted()
    if (!st.muteChange) return { muted }
    if (st.muteChange.muted !== muted) return { muted, reason: 'user' }
    return { muted, reason: 'extension', extensionId: st.muteChange.extensionId }
  }

  /** Every field Chrome gives, before any is hidden from an extension. */
  createTabDetails(tab: TabContents, index?: number): TabDetails {
    const st = this.stateOf(tab.id)
    const win = this.windowOf(tab)
    const active = !!win && this.ctx.store.getActiveTabFromWindow(win)?.id === tab.id
    const highlighted = active || !!(win && this.highlightedTabsByWindow.get(win.id)?.has(tab.id))
    const [width = 0, height = 0] = win ? win.getContentSize() : []
    const url = tab.getURL()
    const details: TabDetails = {
      active,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: st.autoDiscardable,
      discarded: st.discarded,
      favIconUrl: st.favIconUrl,
      frozen: false,
      groupId: tabApis(this.ctx).groups?.groupIdOf(tab.id) ?? -1,
      height,
      highlighted,
      id: tab.id,
      incognito: !this.ctx.session.isPersistent(),
      index: typeof index === 'number' ? index : this.indexOf(tab, win),
      lastAccessed: st.lastAccessed,
      mutedInfo: this.mutedInfo(tab, st),
      openerTabId: st.openerTabId,
      pendingUrl: st.pendingUrl && st.pendingUrl !== url ? st.pendingUrl : undefined,
      pinned: st.pinned,
      selected: highlighted,
      splitViewId: -1,
      status: st.discarded ? 'unloaded' : tab.isLoading() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url,
      width,
      windowId: win ? win.id : -1,
    }
    for (const key of Object.keys(details) as (keyof TabDetails)[]) {
      if (details[key] === undefined) delete details[key]
    }
    if (typeof this.ctx.store.impl.assignTabDetails === 'function') {
      this.ctx.store.impl.assignTabDetails(details, tab)
    }
    return details
  }

  /** Fresh details, written to the cache other APIs read. */
  private snapshot(tab: TabContents) {
    const details = this.createTabDetails(tab)
    this.ctx.store.tabDetailsCache.set(tab.id, details)
    return details
  }

  private getExtension(extensionId: string) {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    return sessionExtensions.getExtension(extensionId) || undefined
  }

  /**
   * Whether the extension may see a tab's url, title and favicon: with the
   * "tabs" permission, or host access to the page (activeTab counts for the
   * tab it was granted on). Its own pages need "tabs" too, as in Chrome.
   */
  canSeeUrl(extension: Electron.Extension | undefined, url: string | undefined, tabId?: number) {
    if (!extension) return false
    if (this.ctx.permissions.has(extension, 'tabs')) return true
    if (!url || url.startsWith('chrome-extension:')) return false
    return this.ctx.permissions.hasHostAccess(extension, url, { tabId })
  }

  /** A tab as one extension may see it. */
  forExtension<T extends Partial<TabDetails>>(extension: Electron.Extension | undefined, details: T): T {
    const tab: any = { ...details }
    if (details.mutedInfo) tab.mutedInfo = { ...details.mutedInfo }
    const tabId = typeof details.id === 'number' ? details.id : undefined
    if (!this.canSeeUrl(extension, details.url, tabId)) {
      delete tab.url
      delete tab.title
      delete tab.favIconUrl
    }
    if (tab.pendingUrl !== undefined && !this.canSeeUrl(extension, details.pendingUrl, tabId)) {
      delete tab.pendingUrl
    }
    return tab
  }

  /** The details of a tab, as this extension may see them. */
  tabFor(extension: Electron.Extension | undefined, tab: TabContents) {
    return this.forExtension(extension, this.createTabDetails(tab))
  }

  /** The tabs of a window, as the extension may see them; for windows.* with populate. */
  windowTabsFor(extension: Electron.Extension | undefined, win: Electron.BaseWindow) {
    return this.windowTabs(win).map((tab, i) => this.forExtension(extension, this.createTabDetails(tab, i)))
  }

  /** Sends an event whose arguments hold tab urls, hiding them per extension. */
  private sendTabEvent(eventName: string, build: (extension: Electron.Extension | undefined) => any[]) {
    this.ctx.router.sendEventForEachListener(eventName, (extensionId) => build(this.getExtension(extensionId)))
  }

  /** Remembers the URL a tab was asked to open, shown as pendingUrl until it commits. */
  notePendingUrl(tab: Electron.WebContents, url: string | undefined) {
    if (!url) return
    this.stateOf(tab.id).pendingUrl = url
  }

  // ---------------------------------------------------------- tab lifecycle

  private observeTab(tab: TabContents) {
    const tabId = tab.id
    this.removed.delete(tabId)
    // A tab the host stopped tracking and added again keeps its listeners.
    const listening = this.observed.has(tab)
    this.observed.add(tab)
    const st = this.stateOf(tabId)
    const hint = this.ctx.store.pendingUrls?.get(tab)
    if (hint && tab.isLoading() && tab.getURL() !== hint) st.pendingUrl = hint

    const win = this.windowOf(tab)
    if (win) {
      const order = this.tabOrderByWindow.get(win.id) || []
      if (!order.includes(tabId)) {
        order.push(tabId)
        this.tabOrderByWindow.set(win.id, order)
      }
    }

    const updateEvents = [
      'page-title-updated', // title
      'did-start-loading', // status
      'did-stop-loading', // status
      'media-started-playing', // audible
      'media-paused', // audible
      'audio-state-changed', // audible
      'did-navigate-in-page', // url

      // Listen for 'tab-updated' to handle all other cases which don't have
      // an official Electron API such as discarded tabs. App developers can
      // emit this event to trigger chrome.tabs.onUpdated if a property has
      // changed.
      'tab-updated',
    ]

    const updateHandler = () => {
      this.applyStoredZoomForTab(tab)
      this.onUpdated(tabId)
    }

    const startNavigation = (details: any) => {
      if (!details?.isMainFrame || details.isSameDocument) return
      this.stateOf(tabId).pendingUrl = details.url
      this.onUpdated(tabId)
    }

    const committed = (_event: unknown, url: string) => {
      this.stateOf(tabId).pendingUrl = undefined
      // A new page has its own favicon, if it has one.
      this.stateOf(tabId).favIconUrl = undefined
      // activeTab lasts while the tab stays on the origin it was given for.
      this.ctx.permissions.revokeActiveTab(tabId, url)
      this.onUpdated(tabId)
    }

    const failed = (_event: unknown, code: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return
      this.stateOf(tabId).pendingUrl = undefined
      this.onUpdated(tabId)
    }

    const faviconHandler = (_event: Electron.Event, favicons: string[]) => {
      const candidate = Array.isArray(favicons) ? favicons.find((f) => typeof f === 'string') : undefined
      tab.favicon = candidate
      void this.checkFavicon(tab, candidate).then((url) => {
        if (tab.isDestroyed() || tab.favicon !== candidate) return
        if (this.stateOf(tabId).favIconUrl === url) return
        this.stateOf(tabId).favIconUrl = url
        this.onUpdated(tabId)
      })
    }

    if (!listening) {
      updateEvents.forEach((eventName) => tab.on(eventName as any, updateHandler))
      tab.on('did-start-navigation', startNavigation)
      tab.on('did-redirect-navigation', startNavigation)
      tab.on('did-navigate', committed)
      tab.on('did-fail-load', failed)
      tab.on('page-favicon-updated', faviconHandler)
      tab.once('destroyed', () => {
        // removeTab emits 'tab-removed' once, which announces it.
        this.ctx.store.removeTab(tab)
        this.onRemoved(tabId)
      })
    }

    this.applyStoredZoomForTab(tab)
    this.patchCachedPositions(win)
    const details = this.snapshot(tab)
    this.sendTabEvent('tabs.onCreated', (extension) => [this.forExtension(extension, details)])

    // The store makes the first tab of a window its active tab.
    if (win && this.ctx.store.getActiveTabFromWindow(win)?.id === tabId) {
      this.highlightedTabsByWindow.set(win.id, new Set([tabId]))
      this.ctx.router.broadcastEvent('tabs.onActivated', { tabId, windowId: win.id })
    }

    d(`Observing tab[${tabId}][${tab.getType()}] ${tab.getURL()}`)
  }

  /**
   * Chrome shows a favicon only once it loaded. Electron gives the page's
   * candidates, so each is fetched once, through the tab's own session.
   */
  private async checkFavicon(tab: TabContents, url: string | undefined): Promise<string | undefined> {
    if (!url) return undefined
    if (url.startsWith('data:')) return url.length <= FAVICON_DATA_URL_MAX && url.startsWith('data:image/') ? url : undefined
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return url
    let check = this.faviconChecks.get(url)
    if (!check) {
      check = this.fetchFavicon(tab.session, url)
      this.faviconChecks.set(url, check)
      if (this.faviconChecks.size > FAVICON_CACHE_MAX) {
        this.faviconChecks.delete(this.faviconChecks.keys().next().value as string)
      }
    }
    return (await check) ? url : undefined
  }

  private async fetchFavicon(session: Electron.Session, url: string): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS)
    try {
      const response = await session.fetch(url, { signal: controller.signal })
      const type = response.headers.get('content-type') || ''
      void response.body?.cancel().catch(() => {})
      return response.ok && (/^image\//i.test(type) || /octet-stream/i.test(type) || type === '')
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /** Tells extensions which tab is now active in its window. */
  onActivated(tabId: number) {
    this.activate(tabId, true)
  }

  private activate(tabId: number, announceHighlight: boolean) {
    const tab = this.getTab(tabId)
    if (!tab) return
    const win = this.windowOf(tab)
    const previous = win ? this.ctx.store.getActiveTabFromWindow(win) : undefined
    if (previous?.id === tabId) return

    this.ctx.store.setActiveTab(tab)
    const st = this.stateOf(tabId)
    st.lastAccessed = Date.now()
    // A discarded tab loads again when it is shown; the host that freed it reloads it.
    const wasDiscarded = st.discarded
    st.discarded = false
    if (win) this.highlightedTabsByWindow.set(win.id, new Set([tabId]))
    this.patchCachedPositions(win)
    const cached = this.ctx.store.tabDetailsCache.get(tabId)
    if (cached) (cached as TabDetails).lastAccessed = st.lastAccessed

    this.ctx.router.broadcastEvent('tabs.onActivated', { tabId, windowId: win ? win.id : -1 })
    if (win && announceHighlight) {
      this.ctx.router.broadcastEvent('tabs.onHighlighted', { windowId: win.id, tabIds: [tabId] })
    }
    if (wasDiscarded) this.onUpdated(tabId)
  }

  onUpdated(tabId: number) {
    const tab = this.getTab(tabId)
    if (!tab) return
    const prev = this.ctx.store.tabDetailsCache.get(tab.id) as TabDetails | undefined
    if (!prev) return
    const details = this.snapshot(tab)

    const compareProps: (keyof TabDetails)[] = [
      'audible',
      'autoDiscardable',
      'discarded',
      'favIconUrl',
      'frozen',
      'groupId',
      'pinned',
      'splitViewId',
      'status',
      'title',
      'url',
    ]
    const changeInfo: Record<string, any> = {}
    for (const prop of compareProps) {
      if (details[prop] !== prev[prop]) changeInfo[prop] = details[prop]
    }
    const muted = details.mutedInfo
    const was = prev.mutedInfo
    if (muted?.muted !== was?.muted || muted?.reason !== was?.reason || muted?.extensionId !== was?.extensionId) {
      changeInfo.mutedInfo = muted
    }
    if (Object.keys(changeInfo).length === 0) return

    this.sendTabEvent('tabs.onUpdated', (extension) => {
      const visible = this.forExtension(extension, details)
      const info: Record<string, any> = {}
      for (const [key, value] of Object.entries(changeInfo)) {
        if ((key === 'url' || key === 'title' || key === 'favIconUrl') && !(key in visible)) continue
        info[key] = value
      }
      return [tab.id, info, visible]
    })
  }

  private onRemoved(tabId: number) {
    if (this.removed.has(tabId)) return
    const details = this.ctx.store.tabDetailsCache.get(tabId) as TabDetails | undefined
    if (!details) return
    this.removed.add(tabId)
    // Ids are not reused for a long time, but the set must not grow forever.
    if (this.removed.size > 10_000) this.removed.delete(this.removed.values().next().value as number)
    this.ctx.store.tabDetailsCache.delete(tabId)

    const windowId = typeof details.windowId === 'number' ? details.windowId : -1
    const windowClosing = this.windows()?.isClosing(windowId) ?? false

    tabApis(this.ctx).groups?.tabRemoved(tabId)
    tabApis(this.ctx).sessions?.tabClosed(details, windowClosing)
    this.ctx.permissions.revokeActiveTab(tabId)

    this.ctx.router.broadcastEvent('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: windowClosing,
    } satisfies chrome.tabs.TabRemoveInfo)

    const order = this.tabOrderByWindow.get(windowId)
    if (order) this.tabOrderByWindow.set(windowId, order.filter((id) => id !== tabId))
    const highlighted = this.highlightedTabsByWindow.get(windowId)
    if (highlighted) {
      highlighted.delete(tabId)
      if (highlighted.size === 0) this.highlightedTabsByWindow.delete(windowId)
    }
    this.state.delete(tabId)
    this.tabZoomSettings.delete(tabId)
    this.tabZoomFactors.delete(tabId)
    this.patchCachedPositions(this.ctx.store.getWindowById(windowId))
  }

  /** A window is gone: forget what was kept for it. */
  forgetWindow(windowId: number) {
    this.tabOrderByWindow.delete(windowId)
    this.highlightedTabsByWindow.delete(windowId)
  }

  // ---------------------------------------------------------- handlers

  private get(event: ExtensionEvent, tabId: unknown) {
    if (!Number.isSafeInteger(tabId)) throw signatureError(SIG.get)
    return this.tabFor(event.extension as Electron.Extension, this.requireTab(tabId))
  }

  private getAllInWindow(event: ExtensionEvent, windowId: number = TabsAPI.WINDOW_ID_CURRENT) {
    const win =
      windowId === TabsAPI.WINDOW_ID_CURRENT ? this.currentWindow(event) : this.ctx.store.getWindowById(windowId)
    if (!win) throw noWindowError(windowId)
    return this.windowTabsFor(event.extension as Electron.Extension, win)
  }

  private getCurrent(event: ExtensionEvent) {
    // The tab the calling page is shown in; a worker or popup has none.
    if (event.type !== 'frame') return undefined
    const sender = event.sender
    if (!sender || sender.isDestroyed() || !this.ctx.store.tabs.has(sender)) return undefined
    return this.tabFor(event.extension as Electron.Extension, sender as TabContents)
  }

  private checkCaptureQuota(extensionId: string) {
    const now = Date.now()
    const calls = (this.captureCalls.get(extensionId) || []).filter((t) => now - t < 1000)
    if (calls.length >= 2) {
      throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')
    }
    calls.push(now)
    this.captureCalls.set(extensionId, calls)
  }

  /**
   * Capture the visible area of the active tab as a data URL, as Chrome does:
   * the extension needs '<all_urls>' or an activeTab grant for that tab, and
   * access to its page. Nothing is written to disk.
   */
  private async captureVisibleTab(event: ExtensionEvent, arg1?: unknown, arg2?: unknown): Promise<string> {
    let windowId: unknown
    let options: unknown
    if (arg1 === undefined || arg1 === null || typeof arg1 === 'number') {
      windowId = arg1
      options = arg2
    } else {
      options = arg1
    }
    if (windowId !== undefined && windowId !== null && !Number.isSafeInteger(windowId)) throw signatureError(SIG.capture)
    const opts = checkProps(SIG.capture, 'options', options, {
      format: IMAGE_FORMATS,
      quality: (v) =>
        !Number.isSafeInteger(v)
          ? `Invalid type: expected integer, found ${typeName(v)}.`
          : v < 0
            ? 'Value must be at least 0.'
            : v > 100
              ? 'Value must be at most 100.'
              : undefined,
    }, { optional: true })

    const extension = event.extension as Electron.Extension
    this.checkCaptureQuota(extension.id)

    const win =
      windowId === undefined || windowId === null || windowId === TabsAPI.WINDOW_ID_CURRENT
        ? this.currentWindow(event)
        : this.ctx.store.getWindowById(windowId as number)
    if (!win) throw windowId === undefined || windowId === null ? new Error('No current window') : noWindowError(windowId)
    const tab = this.ctx.store.getActiveTabFromWindow(win)
    if (!tab || tab.isDestroyed()) throw new Error('No active web contents to capture')

    const allUrls = this.ctx.permissions.origins(extension).includes('<all_urls>')
    if (!allUrls && !this.ctx.permissions.hasActiveTab(extension, tab.id)) {
      throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.")
    }
    const url = tab.getURL()
    let scheme = ''
    try {
      scheme = new URL(url).protocol
    } catch {}
    const ownPage = scheme === 'chrome-extension:' && url.startsWith(`chrome-extension://${extension.id}/`)
    if (!ownPage && !this.ctx.permissions.hasHostAccess(extension, url, { tabId: tab.id })) {
      if (scheme && !['http:', 'https:', 'file:', 'ftp:', 'data:', 'about:'].includes(scheme)) {
        throw new Error(`Cannot access a ${scheme}// URL`)
      }
      throw new Error(
        'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      )
    }

    const image = await tab.capturePage()
    if (!image || image.isEmpty()) throw new Error('Failed to capture tab: unknown error')
    if (opts.format === 'png') return image.toDataURL()
    const quality = typeof opts.quality === 'number' ? opts.quality : 92
    return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`
  }

  private resolveWindowArg(event: ExtensionEvent, windowId: unknown) {
    if (windowId === TabsAPI.WINDOW_ID_CURRENT) {
      const win = this.currentWindow(event)
      if (!win) throw new Error('No current window')
      return win
    }
    const win = this.ctx.store.getWindowById(windowId as number)
    if (!win) throw noWindowError(windowId)
    return win
  }

  private async create(event: ExtensionEvent, createProperties?: unknown) {
    const props = checkProps(SIG.create, 'createProperties', createProperties ?? {}, {
      active: 'boolean',
      index: 'integer',
      openerTabId: 'integer',
      pinned: 'boolean',
      selected: 'boolean',
      url: 'string',
      windowId: 'integer',
    })
    const extension = event.extension as Electron.Extension
    const url = typeof props.url === 'string' ? prepareNavigationUrl(props.url, extension, this.ctx.permissions) : undefined

    let win: Electron.BaseWindow | null | undefined
    if (typeof props.windowId === 'number') win = this.resolveWindowArg(event, props.windowId)
    else win = this.currentWindow(event)
    // A popup holds one tab: new tabs go to a normal window, as in Chrome.
    if (win && this.windowType(win) !== 'normal') win = this.windows()?.lastNormalWindow()
    if (typeof props.openerTabId === 'number') this.requireTab(props.openerTabId)

    const active = props.active ?? props.selected ?? true
    const pinned = props.pinned === true
    let index: number | undefined
    if (win) {
      const count = this.windowTabs(win).length
      const pinnedCount = this.pinnedCount(win)
      const wanted = typeof props.index === 'number' && props.index >= 0 ? props.index : count
      index = pinned ? Math.min(wanted, pinnedCount) : Math.max(pinnedCount, Math.min(wanted, count))
    }

    const tab = (await this.ctx.store.createTab({
      url,
      active,
      pinned,
      index,
      openerTabId: props.openerTabId,
      windowId: win ? win.id : TabsAPI.WINDOW_ID_NONE,
    })) as TabContents

    const st = this.stateOf(tab.id)
    if (typeof props.openerTabId === 'number') st.openerTabId = props.openerTabId
    if (url && tab.getURL() !== url && !st.pendingUrl) st.pendingUrl = url
    const placed = this.windowOf(tab)
    if (placed && typeof index === 'number') {
      const at = this.indexOf(tab, placed)
      if (at !== index) await this.moveInWindow(tab, placed, index, { silent: true })
    }
    if (pinned && placed) await this.setPinned(tab, placed, true)
    if (active) this.onActivated(tab.id)
    this.refreshCache(tab)
    return this.tabFor(event.extension as Electron.Extension, tab)
  }

  /** The cache holds what extensions were last told; fields set at creation belong there. */
  private refreshCache(tab: TabContents) {
    const cached = this.ctx.store.tabDetailsCache.get(tab.id) as TabDetails | undefined
    if (!cached) return
    const st = this.stateOf(tab.id)
    if (st.openerTabId !== undefined) cached.openerTabId = st.openerTabId
    this.patchCachedPositions(this.windowOf(tab))
  }

  private insertCSS(event: ExtensionEvent, tabId: number, details: chrome.tabs.InjectDetails) {
    const tab = this.requireTab(tabId)
    const extension = event.extension as Electron.Extension
    if (!this.ctx.permissions.hasHostAccess(extension, tab.getURL(), { tabId: tab.id, scriptable: true })) {
      throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')
    }
    if (details && typeof details.code === 'string') tab.insertCSS(details.code)
  }

  private query(event: ExtensionEvent, queryInfo?: unknown) {
    const info = checkProps(SIG.query, 'queryInfo', queryInfo ?? {}, {
      active: 'boolean',
      audible: 'boolean',
      autoDiscardable: 'boolean',
      currentWindow: 'boolean',
      discarded: 'boolean',
      frozen: 'boolean',
      groupId: intAtLeast(-1),
      highlighted: 'boolean',
      index: intAtLeast(0),
      lastFocusedWindow: 'boolean',
      muted: 'boolean',
      pinned: 'boolean',
      splitViewId: intAtLeast(-1),
      status: TAB_STATUSES,
      title: 'string',
      windowId: intAtLeast(-2),
      windowType: WINDOW_TYPES,
    })
    const extension = event.extension as Electron.Extension

    let patterns: ParsedMatchPattern[] | undefined
    if (info.url !== undefined) {
      const list = Array.isArray(info.url) ? info.url : [info.url]
      if (list.length > 1000) throw signatureError(SIG.query)
      patterns = list.map((p: unknown, i: number) => {
        if (typeof p !== 'string') {
          throw argumentError(SIG.query, 'queryInfo', Array.isArray(info.url) ? ['url', i] : ['url'], `Invalid type: expected string, found ${typeName(p)}.`)
        }
        try {
          return safePattern(parseMatchPattern(p))
        } catch {
          throw new Error(`Invalid url pattern '${p}'`)
        }
      })
    }

    const isSet = (value: unknown) => value !== undefined
    const currentWin = info.currentWindow !== undefined || info.windowId === TabsAPI.WINDOW_ID_CURRENT ? this.currentWindow(event) : null
    const lastFocusedId = this.ctx.store.getLastFocusedWindow()?.id

    const results: TabDetails[] = []
    for (const [tab, index] of this.allTabsInOrder()) {
      const t = this.createTabDetails(tab, index)
      if (isSet(info.active) && info.active !== t.active) continue
      if (isSet(info.pinned) && info.pinned !== t.pinned) continue
      if (isSet(info.audible) && info.audible !== t.audible) continue
      if (isSet(info.muted) && info.muted !== t.mutedInfo?.muted) continue
      if (isSet(info.highlighted) && info.highlighted !== t.highlighted) continue
      if (isSet(info.discarded) && info.discarded !== t.discarded) continue
      if (isSet(info.autoDiscardable) && info.autoDiscardable !== t.autoDiscardable) continue
      if (isSet(info.frozen) && info.frozen !== t.frozen) continue
      if (isSet(info.groupId) && info.groupId !== t.groupId) continue
      if (isSet(info.splitViewId) && info.splitViewId !== t.splitViewId) continue
      if (isSet(info.status) && info.status !== t.status) continue
      if (isSet(info.index) && info.index !== t.index) continue
      if (isSet(info.currentWindow) && info.currentWindow !== (!!currentWin && currentWin.id === t.windowId)) continue
      if (isSet(info.lastFocusedWindow) && info.lastFocusedWindow !== (lastFocusedId === t.windowId)) continue
      if (isSet(info.windowId)) {
        const wanted = info.windowId === TabsAPI.WINDOW_ID_CURRENT ? currentWin?.id : info.windowId
        if (wanted !== t.windowId) continue
      }
      if (isSet(info.windowType)) {
        const win = this.windowOf(tab)
        if (!win || this.windowType(win) !== info.windowType) continue
      }
      // Titles and urls are private: a tab the extension may not see never
      // matches a query on them, or the query would tell what it hides.
      if (isSet(info.title) || patterns) {
        if (!this.canSeeUrl(extension, t.url, t.id)) continue
        if (isSet(info.title) && !globMatch(info.title, t.title || '')) continue
        if (patterns && !patterns.some((p) => urlMatches(p, t.url || ''))) continue
      }
      results.push(this.forExtension(extension, t))
    }
    return results
  }

  /** Every tab with its index, window by window, each window's tabs in order. */
  private allTabsInOrder(): [TabContents, number][] {
    const out: [TabContents, number][] = []
    const seen = new Set<number>()
    for (const win of this.ctx.store.windows) {
      this.windowTabs(win).forEach((tab, i) => {
        out.push([tab, i])
        seen.add(tab.id)
      })
    }
    for (const tab of this.ctx.store.tabs) {
      if (!tab.isDestroyed() && !seen.has(tab.id)) out.push([tab as TabContents, -1])
    }
    return out
  }

  private reload(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const tabId = fits(arg1, 'object') ? undefined : arg1
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(SIG.reload)
    const props = checkProps(SIG.reload, 'reloadProperties', fits(arg1, 'object') ? arg1 : arg2, { bypassCache: 'boolean' }, { optional: true })
    const tab = this.targetTab(event, tabId)
    const st = this.stateOf(tab.id)
    st.discarded = false
    if (props.bypassCache) tab.reloadIgnoringCache()
    else tab.reload()
  }

  private async update(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    let tabId: unknown
    let updateProperties: unknown
    if (fits(arg1, 'object')) {
      updateProperties = arg1
    } else {
      tabId = arg1
      updateProperties = arg2
    }
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(SIG.update)
    const props = checkProps(SIG.update, 'updateProperties', updateProperties, {
      active: 'boolean',
      autoDiscardable: 'boolean',
      highlighted: 'boolean',
      muted: 'boolean',
      openerTabId: 'integer',
      pinned: 'boolean',
      selected: 'boolean',
      url: 'string',
    })
    const extension = event.extension as Electron.Extension
    const tab = this.targetTab(event, tabId)
    const url = typeof props.url === 'string' ? prepareNavigationUrl(props.url, extension, this.ctx.permissions) : undefined
    if (typeof props.openerTabId === 'number') this.requireTab(props.openerTabId)

    const st = this.stateOf(tab.id)
    const win = this.windowOf(tab)

    if (url) {
      st.pendingUrl = url
      st.discarded = false
      tab.loadURL(url).catch((error) => d('tabs.update navigation to %s failed: %o', url, error))
    }
    if (typeof props.muted === 'boolean') {
      tab.setAudioMuted(props.muted)
      st.muteChange = { muted: props.muted, extensionId: extension.id }
    }
    if (typeof props.autoDiscardable === 'boolean') st.autoDiscardable = props.autoDiscardable
    if (typeof props.openerTabId === 'number') st.openerTabId = props.openerTabId
    if (typeof props.pinned === 'boolean' && win) await this.setPinned(tab, win, props.pinned)

    const makeActive = props.active ?? (props.selected === true ? true : undefined)
    if (makeActive === true) this.onActivated(tab.id)
    if (typeof props.highlighted === 'boolean' && win) {
      const set = this.highlightedTabsByWindow.get(win.id) || new Set<number>()
      const active = this.ctx.store.getActiveTabFromWindow(win)
      if (props.highlighted) set.add(tab.id)
      else if (active?.id !== tab.id) set.delete(tab.id)
      if (active) set.add(active.id)
      this.highlightedTabsByWindow.set(win.id, set)
      this.patchCachedPositions(win)
      this.ctx.router.broadcastEvent('tabs.onHighlighted', { windowId: win.id, tabIds: [...set] })
    }

    this.onUpdated(tab.id)
    return this.tabFor(event.extension as Electron.Extension, tab)
  }

  /** Pins or unpins a tab; pinned tabs sit first in their window, and never in a group. */
  async setPinned(tab: TabContents, win: Electron.BaseWindow, pinned: boolean) {
    const st = this.stateOf(tab.id)
    if (st.pinned === pinned) return
    if (pinned) tabApis(this.ctx).groups?.leaveGroup(tab.id)
    // Pinned tabs end at the end of the pinned ones; an unpinned tab starts the rest.
    const target = this.pinnedCount(win, tab.id)
    st.pinned = pinned
    await this.moveInWindow(tab, win, target)
    if (typeof this.ctx.store.impl.pinTab === 'function') this.ctx.store.impl.pinTab(tab, win, pinned)
    this.onUpdated(tab.id)
  }

  private async remove(event: ExtensionEvent, tabIds: unknown) {
    const ids = readIdList(SIG.remove, tabIds)
    // Chrome closes them in order and stops at the first it cannot find.
    for (const tabId of ids) {
      const tab = this.requireTab(tabId)
      this.ctx.store.removeTab(tab)
    }
  }

  private async move(event: ExtensionEvent, tabIds: unknown, moveProperties: unknown) {
    const ids = readIdList(SIG.move, tabIds)
    const props = checkProps(SIG.move, 'moveProperties', moveProperties, {
      index: intAtLeast(-1),
      windowId: intAtLeast(-2),
    }, { required: ['index'] })
    const tabs = ids.map((id) => this.requireTab(id))
    if (!tabs.length) return []

    const moved: TabDetails[] = []
    let next = props.index as number
    for (const tab of tabs) {
      const source = this.windowOf(tab)
      if (!source) throw noTabError(tab.id)
      const destination = props.windowId === undefined ? source : this.resolveWindowArg(event, props.windowId)
      if (destination !== source) {
        throw new Error('Tabs can only be moved within their window in this browser.')
      }
      if (this.windowType(source) !== 'normal') {
        throw new Error('Tabs can only be moved to and from normal windows.')
      }
      const count = this.windowTabs(source).length
      const pinnedCount = this.pinnedCount(source, tab.id)
      let target = next === -1 ? count - 1 : Math.min(next, count - 1)
      // Pinned tabs stay among the pinned ones, the rest after them.
      target = this.isPinned(tab.id) ? Math.min(target, pinnedCount) : Math.max(target, pinnedCount)
      const landed = await this.moveInWindow(tab, source, target)
      tabApis(this.ctx).groups?.tabMoved(tab.id)
      if (next !== -1) next = landed + 1
      this.onUpdated(tab.id)
      moved.push(this.tabFor(event.extension as Electron.Extension, tab))
    }
    // Chrome gives a single Tab when one tab moved, even when asked with a list.
    return moved.length === 1 ? moved[0] : moved
  }

  private async highlight(event: ExtensionEvent, highlightInfo: unknown) {
    const info = checkProps(SIG.highlight, 'highlightInfo', highlightInfo, { windowId: intAtLeast(-2) }, { required: ['tabs'] })
    const indexes = Array.isArray(info.tabs) ? info.tabs : [info.tabs]
    if (indexes.length > 10_000 || indexes.some((i: unknown) => !Number.isSafeInteger(i))) throw signatureError(SIG.highlight)
    const win =
      info.windowId === undefined ? this.currentWindow(event) : this.resolveWindowArg(event, info.windowId)
    if (!win) throw new Error('No current window')

    const windowTabs = this.windowTabs(win)
    const selected: TabContents[] = []
    for (const index of indexes as number[]) {
      const tab = windowTabs[index]
      if (!tab) throw new Error(`No tab at index: ${index}.`)
      if (!selected.includes(tab)) selected.push(tab)
    }
    if (!selected.length) throw new Error('No highlighted tab')

    const requestedIds = selected.map((tab) => tab.id)
    const activeTabId = requestedIds[0]
    let actualIds = requestedIds
    if (typeof this.ctx.store.impl.highlightTabs === 'function') {
      const result = await this.ctx.store.impl.highlightTabs(win, requestedIds, activeTabId)
      if (Array.isArray(result) && result.length) actualIds = result
    }

    this.activate(activeTabId, false)
    this.highlightedTabsByWindow.set(win.id, new Set(actualIds))
    this.patchCachedPositions(win)
    this.ctx.router.broadcastEvent('tabs.onHighlighted', {
      windowId: win.id,
      tabIds: actualIds,
    } satisfies chrome.tabs.TabHighlightInfo)

    const windows = this.windows()
    return windows ? windows.windowFor(event.extension as Electron.Extension, win, { populate: true }) : { id: win.id }
  }

  private goForward(event: ExtensionEvent, tabId?: unknown) {
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(SIG.goForward)
    const tab = this.targetTab(event, tabId)
    if (!tab.navigationHistory.canGoForward()) throw new Error('Cannot find a next page in history.')
    tab.navigationHistory.goForward()
  }

  private goBack(event: ExtensionEvent, tabId?: unknown) {
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(SIG.goBack)
    const tab = this.targetTab(event, tabId)
    // Chrome uses the same words for both directions.
    if (!tab.navigationHistory.canGoBack()) throw new Error('Cannot find a next page in history.')
    tab.navigationHistory.goBack()
  }

  private async duplicate(event: ExtensionEvent, tabId: unknown) {
    if (!Number.isSafeInteger(tabId)) throw signatureError(SIG.duplicate)
    const tab = this.requireTab(tabId)
    const source = this.createTabDetails(tab)
    const url = tab.getURL() || source.pendingUrl
    // The page is the one the tab already shows, so it is not checked as an
    // extension-chosen URL; script URLs still never load.
    if (url && /^\s*javascript:/i.test(url)) throw new Error(JAVASCRIPT_URL_ERROR)
    const win = this.windowOf(tab)
    const copy = (await this.ctx.store.createTab({
      url: url || undefined,
      active: true,
      index: source.index + 1,
      openerTabId: tab.id,
      windowId: win ? win.id : TabsAPI.WINDOW_ID_NONE,
    })) as TabContents
    const st = this.stateOf(copy.id)
    st.openerTabId = tab.id
    if (url && copy.getURL() !== url && !st.pendingUrl) st.pendingUrl = url
    const placed = this.windowOf(copy)
    if (placed) {
      const at = this.indexOf(copy, placed)
      const wanted = this.indexOf(tab, placed) + 1
      if (wanted > 0 && at !== wanted) await this.moveInWindow(copy, placed, wanted, { silent: true })
    }
    this.onActivated(copy.id)
    this.refreshCache(copy)
    return this.tabFor(event.extension as Electron.Extension, copy)
  }

  private async discard(event: ExtensionEvent, tabId?: unknown) {
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(SIG.discard)
    let tab: TabContents | undefined
    if (tabId === undefined || tabId === null) {
      // Chrome picks the least important tab: here the one used longest ago.
      tab = this.allTabsInOrder()
        .map(([t]) => t)
        .filter((t) => {
          const st = this.stateOf(t.id)
          const win = this.windowOf(t)
          return !st.discarded && st.autoDiscardable && !(win && this.ctx.store.getActiveTabFromWindow(win)?.id === t.id)
        })
        .sort((a, b) => this.stateOf(a.id).lastAccessed - this.stateOf(b.id).lastAccessed)[0]
      if (!tab) throw new Error('Cannot find a tab to discard.')
    } else {
      tab = this.requireTab(tabId)
    }
    const st = this.stateOf(tab.id)
    const win = this.windowOf(tab)
    const isActive = !!win && this.ctx.store.getActiveTabFromWindow(win)?.id === tab.id
    if (st.discarded || isActive || !win) throw new Error(`Cannot discard tab with id: ${tab.id}.`)
    if (typeof this.ctx.store.impl.discardTab === 'function') {
      const ok = await this.ctx.store.impl.discardTab(tab, win)
      if (ok === false) throw new Error(`Cannot discard tab with id: ${tab.id}.`)
    }
    st.discarded = true
    st.pendingUrl = undefined
    this.onUpdated(tab.id)
    return this.tabFor(event.extension as Electron.Extension, tab)
  }

  /**
   * The language of a tab's page. Chrome guesses it from the text; this reads
   * what the page declares in <html lang>, in a world of its own so the page's
   * scripts cannot change the answer, and says 'und' when it declares none.
   */
  private async detectLanguage(event: ExtensionEvent, tabId?: unknown) {
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(SIG.detectLanguage)
    const tab = this.targetTab(event, tabId)
    if (this.stateOf(tab.id).discarded) throw new Error('Cannot determine language of an unloaded tab.')
    if (isInternalPage(tab.getURL(), event.extension as Electron.Extension)) return 'und'
    let lang: unknown
    try {
      lang = await Promise.race([
        tab.executeJavaScriptInIsolatedWorld(1999, [{ code: 'document.documentElement && document.documentElement.lang' }]),
        new Promise((resolve) => setTimeout(() => resolve(undefined), 2000)),
      ])
    } catch {
      lang = undefined
    }
    if (typeof lang !== 'string') return 'und'
    const tag = lang.trim().slice(0, 35)
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return 'und'
    const [primary, region] = tag.split('-')
    // Chrome answers with codes such as 'en', 'fr' and 'zh-TW'.
    return primary.toLowerCase() === 'zh' && region ? `zh-${region.toUpperCase()}` : primary.toLowerCase()
  }

  // ---------------------------------------------------------- zoom

  private getOriginKey(tab: TabContents): string | undefined {
    const rawUrl = tab.getURL()
    if (!rawUrl || typeof rawUrl !== 'string') return undefined
    try {
      const parsed = new URL(rawUrl)
      if (parsed.origin === 'null') return undefined
      return parsed.origin
    } catch {
      return undefined
    }
  }

  private getTabZoomSettings(tabId: number): chrome.tabs.ZoomSettings {
    const settings = this.tabZoomSettings.get(tabId)
    if (settings) return settings
    return {
      mode: 'automatic',
      scope: 'per-origin',
      defaultZoomFactor: 1,
    }
  }

  private setTabZoomFactor(tab: TabContents, factor: number) {
    tab.setZoomFactor(factor)
    this.tabZoomFactors.set(tab.id, factor)
  }

  private emitZoomChange(
    tab: TabContents,
    oldZoomFactor: number,
    newZoomFactor: number,
    zoomSettings: chrome.tabs.ZoomSettings,
  ) {
    this.ctx.router.broadcastEvent('tabs.onZoomChange', {
      tabId: tab.id,
      oldZoomFactor,
      newZoomFactor,
      zoomSettings,
    } satisfies chrome.tabs.ZoomChangeInfo)
  }

  private applyStoredZoomForTab(tab: TabContents) {
    if (!tab || tab.isDestroyed()) return
    const settings = this.getTabZoomSettings(tab.id)
    if (settings.mode === 'disabled') return

    let nextZoom: number | undefined
    if (settings.scope === 'per-tab') {
      nextZoom = this.tabZoomFactors.get(tab.id)
    } else {
      const origin = this.getOriginKey(tab)
      if (origin) nextZoom = this.originZoomFactors.get(origin)
    }

    if (typeof nextZoom === 'number' && Number.isFinite(nextZoom) && nextZoom > 0) {
      const current = tab.getZoomFactor()
      if (Math.abs(current - nextZoom) >= 0.0001) {
        this.setTabZoomFactor(tab, nextZoom)
      }
    }
  }

  private zoomTarget(event: ExtensionEvent, tabId: unknown, signature: string) {
    if (tabId !== undefined && tabId !== null && !Number.isSafeInteger(tabId)) throw signatureError(signature)
    return this.targetTab(event, tabId)
  }

  private getZoom(event: ExtensionEvent, tabId?: unknown) {
    const tab = this.zoomTarget(event, tabId, SIG.getZoom)
    const factor = tab.getZoomFactor()
    return typeof factor === 'number' && Number.isFinite(factor) ? factor : 1
  }

  private setZoom(event: ExtensionEvent, tabIdOrFactor?: unknown, maybeFactor?: unknown) {
    const hasTabId = maybeFactor !== undefined
    const tab = this.zoomTarget(event, hasTabId ? tabIdOrFactor : undefined, SIG.setZoom)
    let factor = (hasTabId ? maybeFactor : tabIdOrFactor) as number
    if (typeof factor !== 'number' || !Number.isFinite(factor)) throw signatureError(SIG.setZoom)
    const settings = this.getTabZoomSettings(tab.id)
    if (settings.mode === 'disabled') {
      throw new Error('Cannot zoom a tab in disabled mode.')
    }
    if (factor <= 0) factor = settings.defaultZoomFactor ?? 1
    // Chrome keeps zoom between 25% and 500%.
    factor = Math.max(0.25, Math.min(5, factor))

    const oldZoomFactor = tab.getZoomFactor()
    if (settings.scope === 'per-tab') {
      this.setTabZoomFactor(tab, factor)
    } else {
      const origin = this.getOriginKey(tab)
      if (origin) {
        this.originZoomFactors.set(origin, factor)
        const sameOriginTabs = Array.from(this.ctx.store.tabs).filter((candidate) => {
          if (candidate.isDestroyed()) return false
          return this.getOriginKey(candidate as TabContents) === origin
        })
        sameOriginTabs.forEach((candidate) => this.setTabZoomFactor(candidate as TabContents, factor))
      } else {
        this.setTabZoomFactor(tab, factor)
      }
    }
    this.emitZoomChange(tab, oldZoomFactor, factor, settings)
  }

  private getZoomSettings(event: ExtensionEvent, tabId?: unknown): chrome.tabs.ZoomSettings {
    const tab = this.zoomTarget(event, tabId, SIG.getZoomSettings)
    const current = this.getTabZoomSettings(tab.id)
    const defaultZoomFactor =
      typeof current.defaultZoomFactor === 'number' && current.defaultZoomFactor > 0
        ? current.defaultZoomFactor
        : 1
    return { ...current, defaultZoomFactor }
  }

  private setZoomSettings(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const hasTabId = !fits(arg1, 'object')
    const tab = this.zoomTarget(event, hasTabId ? arg1 : undefined, SIG.setZoomSettings)
    const settings = checkProps(SIG.setZoomSettings, 'zoomSettings', hasTabId ? arg2 : arg1, {
      mode: ZOOM_MODES,
      scope: ZOOM_SCOPES,
      defaultZoomFactor: 'number',
    })
    // Only automatic zoom can follow the site; defaultZoomFactor is read-only.
    const mode = settings.mode ?? 'automatic'
    if (settings.scope === 'per-origin' && mode !== 'automatic') {
      throw new Error('Can only set scope to "per-origin" in "automatic" mode.')
    }
    const prev = this.getTabZoomSettings(tab.id)
    const next: chrome.tabs.ZoomSettings = {
      mode,
      scope: settings.scope ?? (mode === 'automatic' ? 'per-origin' : 'per-tab'),
      defaultZoomFactor: prev.defaultZoomFactor ?? 1,
    }
    this.tabZoomSettings.set(tab.id, next)
    this.applyStoredZoomForTab(tab)
  }
}
