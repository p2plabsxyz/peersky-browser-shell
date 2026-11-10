/** App-specific implementation details for extensions. */
export interface ChromeExtensionImpl {
  createTab?(
    details: chrome.tabs.CreateProperties,
  ): Promise<[Electron.WebContents, Electron.BaseWindow]>
  selectTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
  removeTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void

  /**
   * Populate additional details to a tab descriptor which gets passed back to
   * background pages and content scripts.
   */
  assignTabDetails?(details: chrome.tabs.Tab, tab: Electron.WebContents): void
  getTabIndex?(tab: Electron.WebContents, window: Electron.BaseWindow): number | undefined
  moveTab?(tab: Electron.WebContents, window: Electron.BaseWindow, index: number): Promise<number | undefined> | number | undefined
  highlightTabs?(
    window: Electron.BaseWindow,
    tabIds: number[],
    activeTabId?: number,
  ): Promise<number[] | undefined> | number[] | undefined

  createWindow?(details: chrome.windows.CreateData): Promise<Electron.BaseWindow>
  removeWindow?(window: Electron.BaseWindow): void

  requestPermissions?(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ): Promise<boolean>

  openSidePanel?(details: {
    extension: Electron.Extension
    path: string
    tabId?: number
    windowId?: number
  }): Promise<void> | void

  /**
   * Shows or hides the browser's own download UI (the downloads bubble or
   * bar), for chrome.downloads.setUiOptions. `enabled` is false while any
   * extension has asked for it to be hidden. Without this hook the call
   * succeeds and changes nothing.
   */
  setDownloadUiEnabled?(extension: Electron.Extension, enabled: boolean): void

  /**
   * Whether the person allowed the extension to run user scripts, as
   * Chrome's per-extension "Allow User Scripts" switch does. Without this
   * hook every extension that asks for the userScripts permission may.
   */
  isUserScriptsAllowed?(extension: Electron.Extension): boolean

  closeSidePanel?(details: {
    extension: Electron.Extension
    tabId?: number
    windowId?: number
  }): Promise<void> | void

  /**
   * The results page of the host's search engine for `text`, for
   * chrome.search.query. The library opens it in the tab or window the
   * extension asked for. Without this hook, or when it returns nothing, it
   * searches with DuckDuckGo.
   */
  getSearchUrl?(text: string): Promise<string | undefined> | string | undefined

  /**
   * The host's own content setting for a page (its site permissions), used by
   * chrome.contentSettings.<type>.get and getContentSetting() when no
   * extension rule decides. Return 'allow', 'block', 'ask' or, for cookies,
   * 'session_only'; anything else, or nothing, means Chrome's default.
   * `type` is the chrome.contentSettings name: 'javascript', 'notifications',
   * 'location', 'camera', ...
   */
  getContentSetting?(details: {
    type: string
    primaryUrl: string
    secondaryUrl: string
  }): string | undefined

  /**
   * Origins whose storage chrome.browsingData never removes, such as the
   * host's own pages ('peersky://settings'). Extensions' origins are always
   * kept, except an extension's own when it asks for originTypes.extension.
   */
  getProtectedOrigins?(): string[]
}
