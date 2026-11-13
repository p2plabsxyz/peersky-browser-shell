import { app } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { checkArgs, MAX_URL_LENGTH, ParamSpec, sendToPermitted, tryParseUrl } from './lib/arg-spec'

/** [visitId, visitTime, transition index] */
type StoredVisit = [number, number, number]

interface UrlRow {
  id: number
  url: string
  title: string
  typedCount: number
  /** Oldest first. */
  visits: StoredVisit[]
}

interface HistoryState {
  version: 1
  nextUrlId: number
  nextVisitId: number
  urls: UrlRow[]
}

const STATE_NS = 'history'
const TRANSITIONS = [
  'link',
  'typed',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'auto_toplevel',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated',
] as const
type Transition = (typeof TRANSITIONS)[number]
const LINK = 0
const TYPED = 1

const DAY_MS = 24 * 60 * 60 * 1000
/** Chrome keeps 90 days of history. */
const KEEP_MS = 90 * DAY_MS
// The visits live in one JSON file with the rest of the session's state, so
// they are capped well below what Chrome's own database holds.
const MAX_URLS = 10_000
const MAX_VISITS = 20_000
/** URLs and titles together, in characters: a few huge data: URLs must not fill the file. */
const MAX_TOTAL_CHARS = 16 * 1024 * 1024
const MAX_RESULTS = MAX_URLS
const DEFAULT_RESULTS = 100
/** Visits are written at most this often; deletions are written at once. */
const SAVE_DELAY_MS = 5_000
/**
 * How long after start to wait before deciding that no extension needs the
 * visits. Extensions load after the library starts, and the visits must not
 * be thrown away before the one that needs them has loaded.
 */
const STARTUP_GRACE_MS = 60_000
const PRUNE_EVERY_MS = 60 * 60 * 1000

/** Schemes Chrome never adds to history, and the shell's own pages. */
const UNRECORDED_SCHEMES = new Set([
  'about:',
  'blob:',
  'chrome:',
  'chrome-error:',
  'chrome-extension:',
  'chrome-native:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'javascript:',
  'peersky:',
  'view-source:',
])

/** Names that are not on the public internet: Chrome treats a first visit there as typed. */
const PRIVATE_TLDS = new Set(['localhost', 'local', 'test', 'example', 'invalid', 'internal', 'lan', 'home', 'corp', 'intranet', 'private'])

const ERR_INVALID_URL = 'Url is invalid.'

const urlDetails: ParamSpec = { name: 'details', spec: { type: 'object', properties: { url: { type: 'string' } } } }
const SIGNATURES: Record<string, [string, ParamSpec[]]> = {
  search: [
    'history.search(object query, optional function callback)',
    [
      {
        name: 'query',
        spec: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            startTime: { type: 'number', optional: true },
            endTime: { type: 'number', optional: true },
            maxResults: { type: 'integer', minimum: 0, optional: true },
          },
        },
      },
    ],
  ],
  getVisits: ['history.getVisits(history.UrlDetails details, optional function callback)', [urlDetails]],
  addUrl: ['history.addUrl(history.UrlDetails details, optional function callback)', [urlDetails]],
  deleteUrl: ['history.deleteUrl(history.UrlDetails details, optional function callback)', [urlDetails]],
  deleteRange: [
    'history.deleteRange(object range, optional function callback)',
    [
      {
        name: 'range',
        spec: { type: 'object', properties: { startTime: { type: 'number' }, endTime: { type: 'number' } } },
      },
    ],
  ],
  deleteAll: ['history.deleteAll(optional function callback)', []],
}

/** Words of a URL or title, for matching search text. */
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []

const isIpAddress = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')

const contexts = new WeakMap<ExtensionContext, HistoryAPI>()

/**
 * chrome.history over the visits of the tabs the host tracks. Visits are kept
 * only while a loaded extension holds 'history' or 'topSites', so no second
 * copy of the person's browsing exists when nothing needs one.
 */
export class HistoryAPI {
  /** The history kept for a session, for chrome.topSites. */
  static forContext(ctx: ExtensionContext) {
    return contexts.get(ctx)
  }

  private state?: HistoryState
  private byUrl = new Map<string, UrlRow>()
  private totalVisits = 0
  private totalChars = 0
  private loading?: Promise<HistoryState>
  private saveTimer?: NodeJS.Timeout
  private lastPrune = 0
  private startedAt = Date.now()
  private lastUrlByTab = new Map<number, string>()
  /** Extensions are not unloaded for good while the app quits. */
  private quitting = false

  /** Exposed for tests: how long to wait at start before dropping unneeded visits. */
  startupGraceMs = STARTUP_GRACE_MS

  constructor(private ctx: ExtensionContext) {
    contexts.set(ctx, this)
    const handle = this.ctx.router.apiHandler()
    const wrap =
      (name: keyof typeof SIGNATURES, fn: (event: ExtensionEvent, ...args: any[]) => any) =>
      async (event: ExtensionEvent, ...args: any[]) => {
        const [signature, params] = SIGNATURES[name]
        const resolved = checkArgs(signature, params, args)
        return fn.call(this, event, ...resolved)
      }
    handle('history.search', wrap('search', this.search))
    handle('history.getVisits', wrap('getVisits', this.getVisits))
    handle('history.addUrl', wrap('addUrl', this.addUrl))
    handle('history.deleteUrl', wrap('deleteUrl', this.deleteUrl))
    handle('history.deleteRange', wrap('deleteRange', this.deleteRange))
    handle('history.deleteAll', wrap('deleteAll', this.deleteAll))

    this.ctx.store.on('tab-added', (tab: Electron.WebContents) => this.observeTab(tab))
    // The host's "clear browsing data" (chrome.browsingData among them) asks
    // for visits since a time to go.
    this.ctx.store.on('clear-history', (details: { since?: number } | undefined) => {
      void this.clear(details?.since).catch((error) => console.error('Failed to clear history:', error))
    })

    const sessionExtensions: any = ctx.session.extensions || ctx.session
    sessionExtensions.on?.('extension-unloaded', (_event: unknown, extension: Electron.Extension) => {
      if (this.quitting) return
      void this.dropIfUnneeded(extension.id, true)
    })
    app?.once?.('before-quit', () => {
      this.quitting = true
    })
    const sweep = setTimeout(() => void this.dropIfUnneeded(), this.startupGraceMs + 1000)
    sweep.unref?.()
  }

  // ------------------------------------------------------------ the store

  /** Whether a loaded extension (other than `except`) needs the visits. */
  isNeeded(except?: string) {
    const sessionExtensions: any = this.ctx.session.extensions || this.ctx.session
    const list: Electron.Extension[] = sessionExtensions.getAllExtensions?.() || []
    return list.some(
      (ext) =>
        ext.id !== except &&
        (this.ctx.permissions.has(ext, 'history') || this.ctx.permissions.has(ext, 'topSites')),
    )
  }

  /**
   * Throws the visits away when no extension needs them. At start this waits
   * for the grace period, so extensions have time to load first.
   */
  async dropIfUnneeded(except?: string, now = false) {
    if (!now && Date.now() - this.startedAt < this.startupGraceMs) return false
    if (this.isNeeded(except)) return false
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<HistoryState | null>(STATE_NS, null)
    if (!this.state && !saved) return true
    this.state = undefined
    this.loading = undefined
    this.byUrl.clear()
    this.totalVisits = 0
    this.totalChars = 0
    this.ctx.stateStore.setNamespace(STATE_NS, undefined)
    await this.saveNow()
    return true
  }

  private load(): Promise<HistoryState> {
    if (this.state) return Promise.resolve(this.state)
    if (!this.loading) {
      this.loading = this.ctx.stateStore.whenHydrated().then(() => {
        if (this.state) return this.state
        const saved = this.ctx.stateStore.getNamespace<HistoryState | null>(STATE_NS, null)
        const state: HistoryState = this.isValidState(saved)
          ? saved
          : { version: 1, nextUrlId: 1, nextVisitId: 1, urls: [] }
        this.state = state
        this.byUrl = new Map(state.urls.map((row) => [row.url, row]))
        this.recount()
        this.prune(true)
        return state
      })
    }
    return this.loading
  }

  private isValidState(state: any): state is HistoryState {
    return (
      !!state &&
      state.version === 1 &&
      typeof state.nextUrlId === 'number' &&
      typeof state.nextVisitId === 'number' &&
      Array.isArray(state.urls) &&
      state.urls.every(
        (row: any) =>
          row &&
          typeof row.id === 'number' &&
          typeof row.url === 'string' &&
          typeof row.title === 'string' &&
          typeof row.typedCount === 'number' &&
          Array.isArray(row.visits) &&
          row.visits.every((v: any) => Array.isArray(v) && v.length === 3 && v.every((n: any) => typeof n === 'number')),
      )
    )
  }

  private recount() {
    this.totalVisits = 0
    this.totalChars = 0
    for (const row of this.state?.urls ?? []) {
      this.totalVisits += row.visits.length
      this.totalChars += row.url.length + row.title.length
    }
  }

  /** Drops visits older than 90 days, and the oldest beyond the caps. */
  private prune(force = false) {
    const state = this.state!
    const now = Date.now()
    const over =
      this.totalVisits > MAX_VISITS || state.urls.length > MAX_URLS || this.totalChars > MAX_TOTAL_CHARS
    if (!force && !over && now - this.lastPrune < PRUNE_EVERY_MS) return false
    this.lastPrune = now
    let cutoff = now - KEEP_MS
    const before = this.totalVisits
    if (this.totalVisits > MAX_VISITS) {
      // Keep the newest 90% of the cap, so pruning is not needed on every visit.
      const times = state.urls.flatMap((r) => r.visits.map((v) => v[1])).sort((a, b) => b - a)
      cutoff = Math.max(cutoff, times[Math.floor(MAX_VISITS * 0.9)] ?? cutoff)
    }
    this.totalVisits = 0
    for (const row of state.urls) {
      if (row.visits.length && row.visits[0][1] < cutoff) row.visits = row.visits.filter((v) => v[1] >= cutoff)
      this.totalVisits += row.visits.length
    }
    let rows = state.urls.filter((row) => row.visits.length > 0)
    const chars = rows.reduce((sum, r) => sum + r.url.length + r.title.length, 0)
    if (rows.length > MAX_URLS || chars > MAX_TOTAL_CHARS) {
      // The most recently visited stay.
      rows.sort((a, b) => b.visits[b.visits.length - 1][1] - a.visits[a.visits.length - 1][1])
      let kept = 0
      let keptChars = 0
      while (
        kept < rows.length &&
        kept < Math.floor(MAX_URLS * 0.9) &&
        keptChars + rows[kept].url.length + rows[kept].title.length <= MAX_TOTAL_CHARS * 0.9
      ) {
        keptChars += rows[kept].url.length + rows[kept].title.length
        kept++
      }
      rows = rows.slice(0, kept)
    }
    if (rows.length !== state.urls.length) {
      state.urls = rows
      this.byUrl = new Map(rows.map((r) => [r.url, r]))
    }
    this.recount()
    return this.totalVisits !== before
  }

  private markChanged(urgent: boolean) {
    this.ctx.stateStore.setNamespace(STATE_NS, this.state)
    if (urgent) {
      void this.saveNow()
      return
    }
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.ctx.stateStore.flush().catch((error) => console.error('Failed to save history:', error))
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  private async saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    try {
      await this.ctx.stateStore.flush()
    } catch (error) {
      console.error('Failed to save history:', error)
    }
  }

  /** Whether a URL can go into history at all, and its canonical form. */
  private recordable(url: string): string | undefined {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return undefined
    const parsed = tryParseUrl(url)
    if (!parsed || UNRECORDED_SCHEMES.has(parsed.protocol)) return undefined
    return parsed.href
  }

  /** Chrome counts a visit to an intranet name nobody has typed yet as typed. */
  private isUntypedIntranetHost(url: string) {
    const parsed = tryParseUrl(url)
    if (!parsed || !['http:', 'https:', 'ftp:'].includes(parsed.protocol)) return false
    const host = parsed.hostname
    const labels = host.split('.')
    const intranet = isIpAddress(host) || labels.length === 1 || PRIVATE_TLDS.has(labels[labels.length - 1])
    if (!intranet) return false
    for (const row of this.byUrl.values()) {
      if (row.typedCount <= 0) continue
      const other = tryParseUrl(row.url)
      if (other && other.hostname === host && ['http:', 'https:', 'ftp:'].includes(other.protocol)) return false
    }
    return true
  }

  private toItem(row: UrlRow): chrome.history.HistoryItem {
    const last = row.visits[row.visits.length - 1]
    return {
      id: String(row.id),
      url: row.url,
      title: row.title,
      lastVisitTime: last ? last[1] : 0,
      visitCount: row.visits.length,
      typedCount: row.typedCount,
    }
  }

  /** Records a visit. Returns the history item, or undefined when nothing was kept. */
  async recordVisit(url: string, transition: Transition = 'link'): Promise<chrome.history.HistoryItem | undefined> {
    const canonical = this.recordable(url)
    if (!canonical || !this.isNeeded()) return undefined
    const state = await this.load()
    let code: number = TRANSITIONS.indexOf(transition)
    if (code < 0) code = LINK
    if (code === LINK && this.isUntypedIntranetHost(canonical)) code = TYPED
    let row = this.byUrl.get(canonical)
    if (!row) {
      row = { id: state.nextUrlId++, url: canonical, title: '', typedCount: 0, visits: [] }
      state.urls.push(row)
      this.byUrl.set(canonical, row)
      this.totalChars += canonical.length
    }
    const last = row.visits[row.visits.length - 1]
    const time = Math.max(Date.now(), last ? last[1] + 1 : 0)
    row.visits.push([state.nextVisitId++, time, code])
    this.totalVisits++
    if (code === TYPED) row.typedCount++
    this.prune()
    if (!this.byUrl.has(canonical)) return undefined
    this.markChanged(false)
    const item = this.toItem(row)
    sendToPermitted(this.ctx, 'history', 'history.onVisited', item)
    return item
  }

  private async setTitle(url: string, title: string) {
    if (!this.state && !this.isNeeded()) return
    const canonical = this.recordable(url)
    if (!canonical) return
    await this.load()
    const row = this.byUrl.get(canonical)
    if (!row || row.title === title) return
    this.totalChars -= row.title.length
    row.title = title.slice(0, 4096)
    this.totalChars += row.title.length
    this.markChanged(false)
  }

  private observeTab(tab: Electron.WebContents) {
    const tabId = tab.id
    const onNavigate = (_event: unknown, url: string) => {
      const previous = this.lastUrlByTab.get(tabId)
      this.lastUrlByTab.set(tabId, url)
      void this.recordVisit(url, previous === url ? 'reload' : 'link').catch(() => {})
      void this.dropIfUnneeded().catch(() => {})
    }
    const onNavigateInPage = (_event: unknown, url: string, isMainFrame: boolean) => {
      if (!isMainFrame || this.lastUrlByTab.get(tabId) === url) return
      this.lastUrlByTab.set(tabId, url)
      void this.recordVisit(url, 'link').catch(() => {})
    }
    const onTitle = (_event: unknown, title: string) => {
      if (typeof title !== 'string' || tab.isDestroyed()) return
      void this.setTitle(tab.getURL(), title).catch(() => {})
    }
    tab.on('did-navigate', onNavigate)
    tab.on('did-navigate-in-page', onNavigateInPage)
    tab.on('page-title-updated', onTitle)
    tab.once('destroyed', () => {
      this.lastUrlByTab.delete(tabId)
    })
  }

  /** Deletes visits since a time (all of them for 0 or none given), for the host's own "clear history". */
  async clear(since?: number) {
    if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) {
      await this.removeAll()
      return
    }
    await this.removeRange(since, Infinity)
  }

  private async removeAll() {
    // What is on disk counts too: a clear before the file was read must still clear it.
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<HistoryState | null>(STATE_NS, null)
    if (!this.state && !saved && !this.isNeeded()) return
    const state = await this.load()
    state.urls = []
    this.byUrl.clear()
    this.recount()
    this.markChanged(true)
    sendToPermitted(this.ctx, 'history', 'history.onVisitRemoved', { allHistory: true, urls: [] })
  }

  private async removeRange(start: number, end: number) {
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<HistoryState | null>(STATE_NS, null)
    if (!this.state && !saved) return
    const state = await this.load()
    const removed: string[] = []
    let changed = false
    for (const row of state.urls) {
      const kept = row.visits.filter((v) => v[1] < start || v[1] > end)
      if (kept.length === row.visits.length) continue
      changed = true
      // Typed counts follow the typed visits that remain.
      row.typedCount = Math.min(row.typedCount, kept.filter((v) => v[2] === TYPED).length)
      row.visits = kept
      if (!kept.length) removed.push(row.url)
    }
    if (!changed) return
    if (removed.length) {
      state.urls = state.urls.filter((row) => row.visits.length > 0)
      for (const url of removed) this.byUrl.delete(url)
    }
    this.recount()
    this.markChanged(true)
    if (removed.length) {
      sendToPermitted(this.ctx, 'history', 'history.onVisitRemoved', { allHistory: false, urls: removed })
    }
  }

  /** The most visited sites, for chrome.topSites. */
  async mostVisited(limit = 10): Promise<chrome.topSites.MostVisitedURL[]> {
    if (!this.state && !this.isNeeded()) return []
    const state = await this.load()
    return state.urls
      .filter((row) => {
        const scheme = tryParseUrl(row.url)?.protocol
        return !!scheme && scheme !== 'data:' && scheme !== 'file:'
      })
      .sort(
        (a, b) =>
          b.visits.length - a.visits.length ||
          (b.visits[b.visits.length - 1]?.[1] ?? 0) - (a.visits[a.visits.length - 1]?.[1] ?? 0),
      )
      .slice(0, limit)
      .map((row) => ({ url: row.url, title: row.title }))
  }

  // ------------------------------------------------------------ handlers

  private async search(
    _event: ExtensionEvent,
    query: { text: string; startTime?: number; endTime?: number; maxResults?: number },
  ) {
    if (!this.state && !this.isNeeded()) return []
    const state = await this.load()
    const start = query.startTime ?? Date.now() - DAY_MS
    const end = query.endTime ?? Infinity
    const max = query.maxResults === 0 ? MAX_RESULTS : Math.min(query.maxResults ?? DEFAULT_RESULTS, MAX_RESULTS)
    // Each word must match a word of the URL or title; a word of three or
    // more letters matches as a prefix, as in Chrome.
    const words = query.text.toLowerCase().split(/\s+/).filter(Boolean)
    const matchesText = (row: UrlRow) => {
      if (!words.length) return true
      const pool = [...wordsOf(row.url), ...wordsOf(row.title)]
      return words.every((word) => {
        const parts = wordsOf(word)
        if (!parts.length) return pool.some((w) => w.includes(word))
        return parts.every((part) => pool.some((w) => (part.length >= 3 ? w.startsWith(part) : w === part)))
      })
    }
    const found: [UrlRow, number][] = []
    for (const row of state.urls) {
      let latest = -Infinity
      for (const v of row.visits) if (v[1] >= start && v[1] < end && v[1] > latest) latest = v[1]
      if (latest === -Infinity || !matchesText(row)) continue
      found.push([row, latest])
    }
    found.sort((a, b) => b[1] - a[1])
    return found.slice(0, max).map(([row]) => this.toItem(row))
  }

  private async getVisits(_event: ExtensionEvent, details: { url: string }) {
    const parsed = tryParseUrl(details.url)
    if (!parsed) throw new Error(ERR_INVALID_URL)
    if (!this.state && !this.isNeeded()) return []
    await this.load()
    const row = this.byUrl.get(parsed.href)
    if (!row) return []
    return row.visits.map(([visitId, visitTime, code]) => ({
      id: String(row.id),
      visitId: String(visitId),
      visitTime,
      referringVisitId: '0',
      transition: TRANSITIONS[code] ?? 'link',
      isLocal: true,
    }))
  }

  private async addUrl(_event: ExtensionEvent, details: { url: string }) {
    if (!tryParseUrl(details.url) || details.url.length > MAX_URL_LENGTH) throw new Error(ERR_INVALID_URL)
    // Chrome takes the call but keeps nothing for URLs history never holds.
    await this.recordVisit(details.url, 'link')
  }

  private async deleteUrl(_event: ExtensionEvent, details: { url: string }) {
    const parsed = tryParseUrl(details.url)
    if (!parsed) throw new Error(ERR_INVALID_URL)
    await this.ctx.stateStore.whenHydrated()
    if (!this.state && !this.ctx.stateStore.getNamespace(STATE_NS, null)) return
    const state = await this.load()
    const row = this.byUrl.get(parsed.href)
    if (!row) return
    this.byUrl.delete(row.url)
    state.urls = state.urls.filter((r) => r !== row)
    this.recount()
    this.markChanged(true)
    sendToPermitted(this.ctx, 'history', 'history.onVisitRemoved', { allHistory: false, urls: [row.url] })
  }

  private async deleteRange(_event: ExtensionEvent, range: { startTime: number; endTime: number }) {
    // The end is included, so a range ending now removes a visit made this millisecond.
    await this.removeRange(range.startTime, range.endTime)
  }

  private async deleteAll() {
    await this.removeAll()
  }
}
