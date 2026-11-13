import { BaseWindow, WebContentsView } from 'electron'
import type { ElectronChromeExtensions } from '../'
import type { ChromeExtensionImpl } from '../src/browser/impl'

interface WindowState {
  type: 'normal' | 'popup'
  tabs: Electron.WebContents[]
  active?: Electron.WebContents
  /** What the tab strip shows: pinned tabs and groups. A popup has no strip. */
  pinned: Set<number>
  groups: Map<number, { title: string; color: string; collapsed: boolean; tabIds: number[] }>
}

/**
 * A small tabbed browser for the parity spec, built the way a real host such
 * as PeerSky is: windows hold tabs, one tab per window is shown, and the
 * extensions library is told about every tab and window through its impl.
 * A popup window has no tab strip and holds one tab. Windows are never shown.
 */
export class ProbeBrowser {
  extensions!: ElectronChromeExtensions
  private windows = new Map<BaseWindow, WindowState>()
  private views = new WeakMap<Electron.WebContents, WebContentsView>()
  private closing = new WeakSet<Electron.WebContents>()

  constructor(private session: Electron.Session) {}

  /**
   * Hands the session's requests to chrome.webRequest and declarativeNetRequest,
   * as PeerSky does: Electron gives each webRequest event to one handler only,
   * so the host owns it and forwards to the extensions library.
   */
  forwardWebRequests() {
    const wr = this.session.webRequest
    const all = { urls: ['<all_urls>'] }
    const forward = (url: string) => /^(https?|wss?):/.test(url)
    wr.onBeforeRequest(all, async (details, callback) => {
      if (!forward(details.url)) return callback({})
      const result: any = (await this.extensions.notifyWebRequestOnBeforeRequest(details).catch(() => ({}))) || {}
      if (result.redirectUrl && !result.redirectURL) result.redirectURL = result.redirectUrl
      callback(result)
    })
    wr.onBeforeSendHeaders(all, async (details, callback) => {
      if (!forward(details.url)) return callback({})
      callback((await this.extensions.notifyWebRequestOnBeforeSendHeaders(details).catch(() => ({}))) || {})
    })
    wr.onSendHeaders(all, (details) => {
      if (forward(details.url)) void this.extensions.notifyWebRequestOnSendHeaders(details).catch(() => {})
    })
    wr.onHeadersReceived(all, async (details, callback) => {
      if (!forward(details.url)) return callback({})
      callback((await this.extensions.notifyWebRequestOnHeadersReceived(details).catch(() => ({}))) || {})
    })
    wr.onBeforeRedirect(all, (details) => {
      if (forward(details.url)) void this.extensions.notifyWebRequestOnBeforeRedirect(details).catch(() => {})
    })
    wr.onResponseStarted(all, (details) => {
      if (forward(details.url)) void this.extensions.notifyWebRequestOnResponseStarted(details).catch(() => {})
    })
    wr.onCompleted(all, (details) => {
      if (forward(details.url)) void this.extensions.notifyWebRequestOnCompleted(details).catch(() => {})
    })
    wr.onErrorOccurred(all, (details) => {
      if (forward(details.url)) void this.extensions.notifyWebRequestOnErrorOccurred(details).catch(() => {})
    })
  }

  private newWindow(
    details: { width?: number; height?: number; left?: number; top?: number; type?: string } = {},
  ) {
    const win = new BaseWindow({
      show: false,
      width: details.width ?? 800,
      height: details.height ?? 600,
      x: details.left,
      y: details.top,
    })
    this.windows.set(win, {
      type: details.type === 'popup' ? 'popup' : 'normal',
      tabs: [],
      pinned: new Set(),
      groups: new Map(),
    })
    win.on('resize', () => this.layout(win))
    win.once('closed', () => {
      const state = this.windows.get(win)
      this.windows.delete(win)
      for (const tab of state?.tabs ?? []) this.untrack(tab)
    })
    return win
  }

  private newTab(win: BaseWindow, url: string | undefined, active: boolean, index?: number) {
    const view = new WebContentsView({
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true },
    })
    const tab = view.webContents
    this.views.set(tab, view)
    const state = this.windows.get(win)!
    if (typeof index === 'number' && index >= 0 && index < state.tabs.length) state.tabs.splice(index, 0, tab)
    else state.tabs.push(tab)
    win.contentView.addChildView(view)
    view.setVisible(false)
    tab.once('destroyed', () => this.forget(tab))
    if (active || !state.active) this.show(win, tab)
    this.layout(win)
    if (url) tab.loadURL(url).catch(() => {})
    return tab
  }

  private layout(win: BaseWindow) {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    for (const tab of this.windows.get(win)?.tabs ?? []) {
      this.views.get(tab)?.setBounds({ x: 0, y: 0, width, height })
    }
  }

  private show(win: BaseWindow, tab: Electron.WebContents) {
    const state = this.windows.get(win)
    if (!state) return
    state.active = tab
    for (const t of state.tabs) this.views.get(t)?.setVisible(t === tab)
  }

  private forget(tab: Electron.WebContents) {
    for (const [win, state] of this.windows) {
      const i = state.tabs.indexOf(tab)
      if (i < 0) continue
      state.tabs.splice(i, 1)
      state.pinned.delete(tab.id)
      const view = this.views.get(tab)
      if (view && !win.isDestroyed()) win.contentView.removeChildView(view)
      if (state.active === tab) {
        state.active = undefined
        const next = state.tabs[Math.min(i, state.tabs.length - 1)]
        if (next) this.extensions.selectTab(next)
      }
      if (state.tabs.length === 0 && !win.isDestroyed()) win.destroy()
    }
  }

  private untrack(tab: Electron.WebContents) {
    if (tab.isDestroyed()) return
    this.closing.add(tab)
    this.extensions.removeTab(tab)
    if (!tab.isDestroyed()) tab.close()
  }

  windowOf(tab: Electron.WebContents) {
    for (const [win, state] of this.windows) if (state.tabs.includes(tab)) return win
    return undefined
  }

  /** Opens a window with one tab, as a person opening the browser would. */
  openWindow(url: string) {
    const win = this.newWindow()
    const tab = this.newTab(win, url, true)
    this.extensions.addTab(tab, win)
    this.extensions.selectTab(tab)
    return { win, tab }
  }

  closeAll() {
    for (const win of [...this.windows.keys()]) if (!win.isDestroyed()) win.destroy()
  }

  get impl(): ChromeExtensionImpl {
    return {
      createTab: async (details) => {
        // A popup has no tab strip: a tab asked for there opens in a new window.
        const win =
          [...this.windows.entries()].find(
            ([w, s]) => w.id === details.windowId && !w.isDestroyed() && s.type === 'normal',
          )?.[0] ?? this.newWindow()
        const tab = this.newTab(win, details.url, details.active !== false, details.index)
        return [tab, win]
      },
      selectTab: (tab, win) => {
        this.show(win as BaseWindow, tab)
      },
      removeTab: (tab) => {
        if (this.closing.has(tab) || tab.isDestroyed()) return
        this.closing.add(tab)
        tab.close()
      },
      getTabIndex: (tab, win) => {
        const i = this.windows.get(win as BaseWindow)?.tabs.indexOf(tab) ?? -1
        return i >= 0 ? i : undefined
      },
      moveTab: (tab, win, index) => {
        const state = this.windows.get(win as BaseWindow)
        if (!state) return undefined
        const from = state.tabs.indexOf(tab)
        if (from < 0) return undefined
        state.tabs.splice(from, 1)
        const to = index < 0 || index > state.tabs.length ? state.tabs.length : index
        state.tabs.splice(to, 0, tab)
        return to
      },
      pinTab: (tab, win, pinned) => {
        const state = this.windows.get(win as BaseWindow)
        if (!state) return
        if (pinned) state.pinned.add(tab.id)
        else state.pinned.delete(tab.id)
      },
      updateTabGroup: ({ group, tabIds, window, removed }) => {
        const state = window && this.windows.get(window as BaseWindow)
        if (!state) return
        if (removed) state.groups.delete(group.id)
        else state.groups.set(group.id, { title: group.title ?? '', color: group.color, collapsed: group.collapsed, tabIds })
      },
      createWindow: async (details) => {
        const win = this.newWindow(details as any)
        const urls = Array.isArray(details.url) ? details.url : [details.url ?? 'about:blank']
        // A popup shows the first page only.
        const shown = (details as any).type === 'popup' ? urls.slice(0, 1) : urls
        shown.forEach((url, i) => {
          const tab = this.newTab(win, url, i === 0)
          this.extensions.addTab(tab, win)
        })
        return win
      },
      removeWindow: (win) => {
        if (!win.isDestroyed()) win.destroy()
      },
    }
  }
}
