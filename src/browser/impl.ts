/** App-specific implementation details for extensions. */
export interface ChromeExtensionImpl {
  /**
   * Open a tab. `details.windowId` is the window to open it in (-1 or none:
   * the host's choice, such as a new window), `details.index` where in it,
   * and `details.active` whether to show it. Extensions only ever ask for
   * normal windows here: a popup window holds a single tab.
   */
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

  /**
   * An extension pinned or unpinned a tab (chrome.tabs.update). The library
   * has already moved it, through `moveTab`, to the end of the pinned tabs or
   * the start of the others; the host shows it pinned or not.
   */
  pinTab?(tab: Electron.WebContents, window: Electron.BaseWindow, pinned: boolean): void

  /**
   * An extension asked to discard a tab (chrome.tabs.discard): free its
   * memory but keep it in the tab strip, and load it again when it is shown.
   * Return false to keep it as it is. Without this hook the tab is only
   * marked discarded, and its page keeps running.
   */
  discardTab?(tab: Electron.WebContents, window: Electron.BaseWindow): Promise<boolean> | boolean

  /**
   * A tab group was created, changed, moved or removed, or tabs joined or
   * left it (chrome.tabs.group, chrome.tabs.ungroup, chrome.tabGroups). The
   * host shows `group` around `tabIds`, which are in order and side by side;
   * when `removed` is true the group is gone. The same changes are emitted on
   * the ElectronChromeExtensions instance as 'tab-group-created',
   * 'tab-group-updated', 'tab-group-moved' and 'tab-group-removed'.
   */
  updateTabGroup?(details: {
    group: chrome.tabGroups.TabGroup
    tabIds: number[]
    window: Electron.BaseWindow | undefined
    removed: boolean
  }): void

  /**
   * Open a window. `details.type` is 'normal' or 'popup' (a window without a
   * tab strip, holding one tab); `details.url` the pages to open in it, one
   * tab each; `details.focused` false to open it without focus. The host
   * adds each tab with `addTab` before it resolves.
   */
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

  /**
   * Shows the host's picker for chrome.desktopCapture.chooseDesktopMedia, so
   * the person can choose a screen or window to share with the extension.
   *
   * Resolve with the chosen source's desktopCapturer id (such as 'screen:1:0'
   * or 'window:42:0'; the extension passes it to getUserMedia as
   * chromeMediaSourceId with chromeMediaSource 'desktop') and whether its
   * audio may be shared, or with null when the person cancels. Offer only the
   * kinds listed in `sources`. `signal` aborts when the extension cancels the
   * request or the tab it was made for closes: close the picker then.
   *
   * Without this hook every request is answered as Chrome answers a person
   * who closes its picker: with an empty stream id.
   */
  chooseDesktopMedia?(details: {
    extension: Electron.Extension
    sources: Array<'screen' | 'window' | 'tab' | 'audio'>
    /** The tab the stream is for, when the extension named one. */
    tab?: Electron.WebContents
    signal: AbortSignal
  }): Promise<{ id: string; audio?: boolean } | null | undefined> | { id: string; audio?: boolean } | null | undefined
}
