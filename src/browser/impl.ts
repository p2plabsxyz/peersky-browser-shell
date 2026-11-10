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

  /**
   * How an extension was installed, as chrome.management reports it:
   * 'normal' (from a store), 'development' (an unpacked folder), 'admin'
   * (policy), 'sideload' or 'other'. Without this hook every extension is
   * 'development', which is what Chrome says of an unpacked one. An
   * extension that is not 'development' also gets Chrome's 30 second minimum
   * for alarms.
   */
  getExtensionInstallType?(extension: Electron.Extension): string | undefined

  /**
   * Turns another extension off or on for chrome.management.setEnabled.
   * The host unloads or loads it and remembers the choice across restarts.
   * Without this hook the shell unloads it from the session and loads it
   * again from its folder, and it comes back enabled after a restart.
   */
  setExtensionEnabled?(details: {
    id: string
    path: string
    enabled: boolean
  }): Promise<void> | void

  /**
   * Asks the person whether to remove an extension, for
   * chrome.management.uninstall and uninstallSelf({ showConfirmDialog }).
   * `by` is the extension asking, when it is not the one being removed.
   * Without this hook the shell asks with a system dialog.
   */
  confirmUninstall?(details: {
    extension: Electron.Extension
    by?: Electron.Extension
  }): Promise<boolean> | boolean

  /**
   * Removes an extension for good once the person agreed. The host deletes
   * its files and its own records. Without this hook the shell only unloads
   * it from the session and drops what the shell kept for it (storage,
   * alarms).
   */
  uninstallExtension?(extension: Electron.Extension): Promise<void> | void

  /**
   * Whether the extension may read file:// URLs (Electron's allowFileAccess
   * load option, which the shell cannot read back), for
   * chrome.extension.isAllowedFileSchemeAccess. Without this hook the answer
   * is false, the safe one.
   */
  isFileSchemeAccessAllowed?(extension: Electron.Extension): boolean

  /**
   * Whether the extension is on the toolbar, for action.getUserSettings.
   * Without this hook every action is on the toolbar. Call
   * `extensions.api.browserAction.userSettingsChanged(id)` when it changes.
   */
  isActionOnToolbar?(extension: Electron.Extension): boolean

  /**
   * The policy an administrator set for an extension, which it reads with
   * chrome.storage.managed (keys and JSON values). Without this hook there is
   * none, and the extension reads an empty store. Call
   * `extensions.api.storageSync.managedChanged(id, changes)` when it changes.
   */
  getManagedStorage?(
    extension: Electron.Extension,
  ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
}
