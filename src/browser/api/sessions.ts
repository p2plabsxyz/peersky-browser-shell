import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { checkProps, signatureError, SessionsLink, tabApis, TabDetails, TabsAPI } from './tabs'
import type { WindowDetails, WindowsAPI } from './windows'

/** Chrome keeps this many recently closed tabs and windows. */
const MAX_ENTRIES = 25

const SIG = {
  getRecentlyClosed: 'sessions.getRecentlyClosed(optional object filter, optional function callback)',
  getDevices: 'sessions.getDevices(optional object filter, optional function callback)',
  restore: 'sessions.restore(optional string sessionId, optional function callback)',
}

const maxResultsRule = (v: unknown) => {
  if (!Number.isSafeInteger(v)) return `Invalid type: expected integer, found ${typeof v}.`
  if ((v as number) < 0) return 'Value must be at least 0.'
  if ((v as number) > MAX_ENTRIES) return `Value must be at most ${MAX_ENTRIES}.`
  return undefined
}

interface ClosedTab {
  kind: 'tab'
  sessionId: string
  closedAt: number
  tab: TabDetails
}

interface ClosedWindow {
  kind: 'window'
  sessionId: string
  closedAt: number
  window?: WindowDetails
  /** Each tab can be reopened on its own, by its own id. */
  tabs: { sessionId: string; tab: TabDetails }[]
}

type Entry = ClosedTab | ClosedWindow

interface ClosingWindow {
  tabs: TabDetails[]
  window?: WindowDetails
  timer?: ReturnType<typeof setTimeout>
}

/**
 * chrome.sessions: the tabs and windows closed in this run, newest first, as
 * Chrome keeps them. They stay in memory only, so a private session never
 * writes them anywhere. There is no sync, so no other devices.
 */
export class SessionsAPI implements SessionsLink {
  private entries: Entry[] = []
  private nextId = 1
  private closingWindows = new Map<number, ClosingWindow>()

  constructor(private ctx: ExtensionContext) {
    tabApis(ctx).sessions = this
    const handle = this.ctx.router.apiHandler()
    handle('sessions.getRecentlyClosed', this.getRecentlyClosed.bind(this))
    handle('sessions.getDevices', this.getDevices.bind(this))
    handle('sessions.restore', this.restore.bind(this))
  }

  private tabs(): TabsAPI | undefined {
    return tabApis(this.ctx).tabs
  }

  private windows(): WindowsAPI | undefined {
    return tabApis(this.ctx).windows
  }

  private add(entry: Entry) {
    this.entries.unshift(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES
    this.ctx.router.broadcastEvent('sessions.onChanged')
  }

  private newId() {
    return String(this.nextId++)
  }

  tabClosed(details: TabDetails, windowClosing: boolean) {
    // A tab that never showed a page has nothing to reopen.
    if (!details.url) return
    if (windowClosing && typeof details.windowId === 'number' && details.windowId >= 0) {
      const closing = this.closingWindows.get(details.windowId) || { tabs: [] }
      closing.tabs.push({ ...details })
      this.closingWindows.set(details.windowId, closing)
      // Hosts that remove tabs before the window says it closed are covered
      // by this; windowClosed() comes sooner when the window does say so.
      if (!closing.timer) closing.timer = setTimeout(() => this.flushWindow(details.windowId), 100)
      return
    }
    this.add({ kind: 'tab', sessionId: this.newId(), closedAt: Date.now(), tab: { ...details } })
  }

  windowClosed(windowId: number, details: WindowDetails | undefined) {
    const closing = this.closingWindows.get(windowId) || { tabs: [] }
    closing.window = details
    this.closingWindows.set(windowId, closing)
    clearTimeout(closing.timer)
    // Tabs may still be on their way out; let them land first.
    closing.timer = setTimeout(() => this.flushWindow(windowId), 0)
  }

  private flushWindow(windowId: number) {
    const closing = this.closingWindows.get(windowId)
    if (!closing) return
    this.closingWindows.delete(windowId)
    clearTimeout(closing.timer)
    const tabs = closing.tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    if (tabs.length === 0) return
    // Chrome keeps a window that had one tab as just that tab.
    if (tabs.length === 1) {
      this.add({ kind: 'tab', sessionId: this.newId(), closedAt: Date.now(), tab: tabs[0] })
      return
    }
    this.add({
      kind: 'window',
      sessionId: this.newId(),
      closedAt: Date.now(),
      window: closing.window,
      tabs: tabs.map((tab) => ({ sessionId: this.newId(), tab })),
    })
  }

  /** A closed tab as Chrome describes it: no id, and only what was kept of it. */
  private sessionTab(extension: Electron.Extension | undefined, tab: TabDetails, sessionId: string, active: boolean) {
    const out: any = {
      active,
      autoDiscardable: tab.autoDiscardable ?? true,
      discarded: false,
      favIconUrl: tab.favIconUrl ?? '',
      frozen: false,
      groupId: -1,
      highlighted: active,
      incognito: !!tab.incognito,
      index: typeof tab.index === 'number' ? tab.index : 0,
      lastAccessed: tab.lastAccessed ?? Date.now(),
      pinned: !!tab.pinned,
      selected: active,
      sessionId,
      title: tab.title || tab.url || '',
      url: tab.url || '',
      windowId: -1,
    }
    const tabs = this.tabs()
    return tabs ? tabs.forExtension(extension, out) : out
  }

  private toSession(extension: Electron.Extension | undefined, entry: Entry): chrome.sessions.Session {
    const lastModified = Math.floor(entry.closedAt / 1000)
    if (entry.kind === 'tab') {
      return { lastModified, tab: this.sessionTab(extension, entry.tab, entry.sessionId, false) }
    }
    const w = entry.window
    const activeIndex = Math.max(0, entry.tabs.findIndex((t) => t.tab.active))
    const window: any = {
      alwaysOnTop: false,
      focused: false,
      height: w?.height ?? 0,
      incognito: !!w?.incognito,
      left: w?.left ?? 0,
      sessionId: entry.sessionId,
      state: w?.state ?? 'normal',
      tabs: entry.tabs.map((t, i) => this.sessionTab(extension, t.tab, t.sessionId, i === activeIndex)),
      top: w?.top ?? 0,
      type: w?.type ?? 'normal',
      width: w?.width ?? 0,
    }
    return { lastModified, window }
  }

  private getRecentlyClosed(event: ExtensionEvent, filter?: unknown) {
    const opts = checkProps(SIG.getRecentlyClosed, 'filter', filter, { maxResults: maxResultsRule }, { optional: true })
    const max = typeof opts.maxResults === 'number' ? opts.maxResults : MAX_ENTRIES
    const extension = event.extension as Electron.Extension
    return this.entries.slice(0, max).map((entry) => this.toSession(extension, entry))
  }

  private getDevices(event: ExtensionEvent, filter?: unknown) {
    checkProps(SIG.getDevices, 'filter', filter, { maxResults: maxResultsRule }, { optional: true })
    return []
  }

  private async restore(event: ExtensionEvent, sessionId?: unknown) {
    if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
      throw signatureError(SIG.restore)
    }
    const found = this.find(typeof sessionId === 'string' ? sessionId : undefined)
    if (!found) {
      if (typeof sessionId === 'string') throw new Error(`Invalid session id: "${sessionId}".`)
      throw new Error('There are no recently closed sessions.')
    }
    const tabs = this.tabs()
    const windows = this.windows()
    if (!tabs || !windows) throw new Error('There are no recently closed sessions.')
    const extension = event.extension as Electron.Extension

    // What is reopened leaves the list.
    const { entry, tabIndex } = found
    if (tabIndex >= 0 && entry.kind === 'window') {
      entry.tabs.splice(tabIndex, 1)
      if (entry.tabs.length === 0) this.entries.splice(this.entries.indexOf(entry), 1)
    } else {
      this.entries.splice(this.entries.indexOf(entry), 1)
    }
    this.ctx.router.broadcastEvent('sessions.onChanged')
    const lastModified = Math.floor(Date.now() / 1000)

    const closedTab = entry.kind === 'tab' ? entry.tab : tabIndex >= 0 ? found.tab : undefined
    if (closedTab) {
      const original =
        typeof closedTab.windowId === 'number' ? this.ctx.store.getWindowById(closedTab.windowId) : undefined
      const win = original && windows.typeOf(original) === 'normal' ? original : windows.lastNormalWindow()
      const tab = await this.ctx.store.createTab({
        url: closedTab.url,
        active: true,
        index: closedTab.index,
        windowId: win ? win.id : -1,
      })
      if (tab.getURL() !== closedTab.url) tabs.notePendingUrl(tab, closedTab.url)
      const placed = tabs.windowOf(tab)
      if (closedTab.pinned && placed) await tabs.setPinned(tab as any, placed, true)
      tabs.onActivated(tab.id)
      return { lastModified, tab: tabs.tabFor(extension, tab as any) }
    }

    const closedWindow = entry as ClosedWindow
    const urls = closedWindow.tabs.map((t) => t.tab.url).filter((u): u is string => !!u)
    const w = closedWindow.window
    const win = await windows.createWindow(event, {
      url: urls,
      focused: true,
      type: w?.type === 'popup' ? 'popup' : 'normal',
      left: w?.left,
      top: w?.top,
      width: w?.width,
      height: w?.height,
    } as chrome.windows.CreateData)
    return { lastModified, window: windows.windowFor(extension, win, { populate: true }) }
  }

  /** The entry with this id, or the newest; a tab inside a closed window counts too. */
  private find(sessionId: string | undefined) {
    if (sessionId === undefined) {
      const entry = this.entries[0]
      return entry ? { entry, tabIndex: -1, tab: undefined } : undefined
    }
    for (const entry of this.entries) {
      if (entry.sessionId === sessionId) return { entry, tabIndex: -1, tab: undefined }
      if (entry.kind === 'window') {
        const tabIndex = entry.tabs.findIndex((t) => t.sessionId === sessionId)
        if (tabIndex >= 0) return { entry, tabIndex, tab: entry.tabs[tabIndex].tab }
      }
    }
    return undefined
  }
}
