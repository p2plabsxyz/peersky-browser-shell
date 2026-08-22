import { BrowserWindow, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { ContextMenuType } from './api/common'
import { ChromeExtensionImpl } from './impl'
import { ExtensionEvent } from './router'

export class ExtensionStore extends EventEmitter {
  /** Tabs observed by the extensions system. */
  tabs = new Set<Electron.WebContents>()

  /** Windows observed by the extensions system. */
  windows = new Set<Electron.BaseWindow>()

  lastFocusedWindowId?: number

  /**
   * Map of tabs to their parent window.
   *
   * It's not possible to access the parent of a BrowserView so we must manage
   * this ourselves.
   */
  tabToWindow = new WeakMap<Electron.WebContents, Electron.BaseWindow>()

  /** Map of windows to their active tab. */
  private windowToActiveTab = new WeakMap<Electron.BaseWindow, Electron.WebContents>()

  tabDetailsCache = new Map<number, Partial<chrome.tabs.Tab>>()
  windowDetailsCache = new Map<number, Partial<chrome.windows.Window>>()

  /** tabId:frameId → documentId */
  private documentIdMap = new Map<string, string>()
  /** documentId → { tabId, frameId } for chrome.scripting target.documentIds */
  private documentIdReverseMap = new Map<string, { tabId: number; frameId: number }>()

  newDocumentId(tabId: number, frameId: number): string {
    const key = `${tabId}:${frameId}`
    const prev = this.documentIdMap.get(key)
    if (prev) this.documentIdReverseMap.delete(prev)

    const id = randomUUID().replace(/-/g, '').toUpperCase()
    this.documentIdMap.set(key, id)
    this.documentIdReverseMap.set(id, { tabId, frameId })
    return id
  }

  getDocumentId(tabId: number, frameId: number): string | undefined {
    return this.documentIdMap.get(`${tabId}:${frameId}`)
  }

  /** Resolve chrome.scripting target.documentIds to tab/frame. */
  resolveByDocumentId(
    documentId: string,
  ): { tabId: number; frameId: number } | undefined {
    if (!documentId || typeof documentId !== 'string') return undefined
    return this.documentIdReverseMap.get(documentId)
  }

  urlOverrides: Record<string, string> = {}

  /**
   * Tracks which window/tab triggered the most recent browser-action click for
   * each extension. Without this, calls like `tabs.query({ currentWindow: true })`
   * would use whichever window the OS happens to be focusing at that moment —
   * which can be the wrong one if focus shifted while a popup was opening.
   *
   * Overwritten on every click; deleted when the extension unloads.
   */
  private activationContextMap = new Map<string, { windowId: number; tabId: number }>()

  /** Remember which window/tab clicked the browser action for this extension. */
  setActivationContext(extensionId: string, windowId: number, tabId: number) {
    this.activationContextMap.set(extensionId, { windowId, tabId })
    this.noteUserGesture(extensionId)
  }

  /** Forget the activation context when an extension unloads. */
  clearActivationContext(extensionId: string) {
    this.activationContextMap.delete(extensionId)
    this.userGestureAt.delete(extensionId)
  }

  /**
   * Chrome grants a short-lived "user gesture" for extension actions such as
   * toolbar clicks and context-menu clicks. Electron does not forward that
   * token across `crx-msg`, so we record it here when those host events fire.
   */
  private userGestureAt = new Map<string, number>()
  private static readonly USER_GESTURE_TTL_MS = 5000

  noteUserGesture(extensionId: string) {
    this.userGestureAt.set(extensionId, Date.now())
  }

  hasUserGesture(extensionId: string) {
    const at = this.userGestureAt.get(extensionId)
    return typeof at === 'number' && Date.now() - at <= ExtensionStore.USER_GESTURE_TTL_MS
  }

  /**
   * Returns the "current window" for an extension.
   *
   * If the extension recently clicked a browser action, returns that window.
   * Otherwise falls back to the OS-focused window (normal behaviour).
   */
  getCurrentWindowForExtension(extensionId: string): Electron.BaseWindow | null {
    const ctx = this.activationContextMap.get(extensionId)
    if (ctx) {
      const win = this.getWindowById(ctx.windowId)
      if (win) return win
    }
    return this.getCurrentWindow()
  }

  constructor(public impl: ChromeExtensionImpl) {
    super()
  }

  getWindowById(windowId: number) {
    return Array.from(this.windows).find(
      (window) => !window.isDestroyed() && window.id === windowId,
    )
  }

  getLastFocusedWindow() {
    return this.lastFocusedWindowId ? this.getWindowById(this.lastFocusedWindowId) : null
  }

  getCurrentWindow() {
    return this.getLastFocusedWindow()
  }

  addWindow(window: Electron.BaseWindow) {
    if (this.windows.has(window)) return

    this.windows.add(window)

    if (typeof this.lastFocusedWindowId !== 'number') {
      this.lastFocusedWindowId = window.id
    }

    this.emit('window-added', window)
  }

  async createWindow(event: ExtensionEvent, details: chrome.windows.CreateData) {
    if (typeof this.impl.createWindow !== 'function') {
      throw new Error('createWindow is not implemented')
    }

    const win = await this.impl.createWindow(details)

    this.addWindow(win)

    return win
  }

  async removeWindow(window: Electron.BaseWindow) {
    if (!this.windows.has(window)) return

    this.windows.delete(window)

    if (typeof this.impl.removeWindow === 'function') {
      await this.impl.removeWindow(window)
    } else {
      window.destroy()
    }
  }

  getTabById(tabId: number) {
    return Array.from(this.tabs).find((tab) => !tab.isDestroyed() && tab.id === tabId)
  }

  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    if (this.tabs.has(tab)) return

    this.tabs.add(tab)
    this.tabToWindow.set(tab, window)
    this.addWindow(window)

    const activeTab = this.getActiveTabFromWebContents(tab)
    if (!activeTab) {
      this.setActiveTab(tab)
    }

    this.emit('tab-added', tab)
  }

  removeTab(tab: Electron.WebContents) {
    if (!this.tabs.has(tab)) return

    const tabId = tab.id
    const win = this.tabToWindow.get(tab)!

    this.tabs.delete(tab)
    this.tabToWindow.delete(tab)

    for (const key of [...this.documentIdMap.keys()]) {
      if (!key.startsWith(`${tabId}:`)) continue
      const docId = this.documentIdMap.get(key)
      if (docId) this.documentIdReverseMap.delete(docId)
      this.documentIdMap.delete(key)
    }

    // Clear window if it has no remaining tabs
    const windowHasTabs = Array.from(this.tabs).find((tab) => this.tabToWindow.get(tab) === win)
    if (!windowHasTabs) {
      this.windows.delete(win)
    }

    if (typeof this.impl.removeTab === 'function') {
      this.impl.removeTab(tab, win)
    }

    this.emit('tab-removed', tabId)
  }

  async createTab(details: chrome.tabs.CreateProperties) {
    if (typeof this.impl.createTab !== 'function') {
      throw new Error('createTab is not implemented')
    }

    // Fallback to current window
    if (!details.windowId) {
      details.windowId = this.lastFocusedWindowId
    }

    const result = await this.impl.createTab(details)

    if (!Array.isArray(result)) {
      throw new Error('createTab must return an array of [tab, window]')
    }

    const [tab, window] = result

    if (typeof tab !== 'object' || !webContents.fromId(tab.id)) {
      throw new Error('createTab must return a WebContents')
    } else if (typeof window !== 'object') {
      throw new Error('createTab must return a BrowserWindow')
    }

    this.addTab(tab, window)

    return tab
  }

  getActiveTabFromWindow(win: Electron.BaseWindow) {
    const activeTab = win && !win.isDestroyed() && this.windowToActiveTab.get(win)
    return (activeTab && !activeTab.isDestroyed() && activeTab) || undefined
  }

  getActiveTabFromWebContents(wc: Electron.WebContents): Electron.WebContents | undefined {
    const win = this.tabToWindow.get(wc) || BrowserWindow.fromWebContents(wc)
    const activeTab = win ? this.getActiveTabFromWindow(win) : undefined
    return activeTab
  }

  getActiveTabOfCurrentWindow() {
    const win = this.getCurrentWindow()
    return win ? this.getActiveTabFromWindow(win) : undefined
  }

  setActiveTab(tab: Electron.WebContents) {
    const win = this.tabToWindow.get(tab)
    if (!win) {
      throw new Error('Active tab has no parent window')
    }

    const prevActiveTab = this.getActiveTabFromWebContents(tab)

    this.windowToActiveTab.set(win, tab)

    if (tab.id !== prevActiveTab?.id) {
      this.emit('active-tab-changed', tab, win)

      if (typeof this.impl.selectTab === 'function') {
        this.impl.selectTab(tab, win)
      }
    }
  }

  buildMenuItems(extensionId: string, menuType: ContextMenuType): Electron.MenuItem[] {
    // This function is overwritten by ContextMenusAPI
    return []
  }

  async requestPermissions(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ) {
    if (typeof this.impl.requestPermissions !== 'function') {
      // Default to allowed.
      return true
    }
    const result: unknown = await this.impl.requestPermissions(extension, permissions)
    return typeof result === 'boolean' ? result : false
  }

  // Resolve WebContents id to the cached chrome.tabs tab id.
  getTabIdForWebContentsId(webContentsId: number): number {
    const tab = webContents.fromId(webContentsId)
    if (!tab || tab.isDestroyed() || !this.tabs.has(tab)) return -1

    const cached = this.tabDetailsCache.get(tab.id)
    const cachedId = cached && typeof cached.id === 'number' ? cached.id : undefined
    // tab.id is the WebContents id, so fallback to that if cache isn't ready yet.
    return typeof cachedId === 'number' ? cachedId : tab.id
  }

  /** Window id for a tracked tab, for webRequest RequestFilter.windowId. */
  getWindowIdForWebContentsId(webContentsId: number): number | undefined {
    const tab = webContents.fromId(webContentsId)
    if (!tab || tab.isDestroyed() || !this.tabs.has(tab)) return undefined
    const win = this.tabToWindow.get(tab)
    if (!win || win.isDestroyed()) return undefined
    return win.id
  }
}
