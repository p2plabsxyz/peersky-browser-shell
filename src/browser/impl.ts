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

  closeSidePanel?(details: {
    extension: Electron.Extension
    tabId?: number
    windowId?: number
  }): Promise<void> | void
}
