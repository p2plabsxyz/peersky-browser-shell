# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-11-12 (@p2plabs/peersky-chrome-extensions)

Versions of this fork follow their own numbers; the entries from 4.0.0 down are upstream electron-chrome-extensions.

Extensions now behave as in Chrome 157. Two test extensions were run in Chrome for Testing and the shell gives the same answers, checked on every test run, apart from the differences listed with their reasons in `spec/fixtures/chrome-api-probe/known-differences.json`.

### Breaking

- Calls that fail reject, or set `chrome.runtime.lastError`, with Chrome's message. They used to resolve with nothing.
- An API is there only for an extension that asks for its permission, and the main process checks every call and every event listener against the permissions the extension holds.
- A tab's url, title and favicon reach an extension only with `tabs`, host access to the page or activeTab. `tabs.captureVisibleTab` needs `<all_urls>` or activeTab and gives JPEG by default.
- `permissions.request` needs a user gesture and asks the person (the `requestPermissions` hook, or a system dialog); it used to grant everything without asking.
- Extension state and `chrome.storage.sync` live in the session's own folder; 1.x data under userData is read once.
- `chrome.storage.local` is Electron's own store, shared by an extension's pages, worker and content scripts as in Chrome, and no longer encrypted at rest (Chrome does not encrypt it either). What 1.x kept is moved there once, before the extension's first call, and the old encrypted file is deleted only after the move is written.
- `chrome.userScripts` is off until the host's `isUserScriptsAllowed` hook allows it for the extension, as Chrome's "Allow User Scripts" switch does.
- `ChromeExtensionImpl.createWindow` may return the window or `[webContents, window]`.
- `<all_urls>` and `file://` patterns reach local files only when the host's `isFileSchemeAccessAllowed` hook allows it for the extension, as Chrome's "Allow access to file URLs" does.
- Electron 43 or later.

### Added

- `chrome.bookmarks`, `history`, `topSites`, `readingList`, `search`, `omnibox`, `sessions`, `tabGroups`, `browsingData`, `contentSettings`, `fontSettings`, `tts`, `pageCapture`, `tabCapture`, `desktopCapture`, `declarativeContent` and a real `chrome.privacy`.
- `runtime.onInstalled`, `onStartup`, `onExtensionLoaded` and `onEnabled` fire as in Chrome. On the first run after updating from 1.x, an extension that already stored data gets `chrome_update`, not `install`.
- activeTab, granted by a toolbar click, a context menu item, a shortcut or the omnibox.
- Optional host hooks for everything only the host can do, each with a safe default (see `src/browser/impl.ts` and the README).
- `getProxySettings()` and the `proxy-changed` event: the proxy an extension set that counts now and which extension set it. `restoreExtensionProxy()` hands an extension back a proxy the host kept itself while 1.x kept `chrome.proxy` in memory only.

### Fixed

- Calling `chrome.system.cpu`, `memory`, `display` or `storage` crashed the browser.
- Every chrome.* call and event was logged to the extension's console with its arguments and result, cookie values included: the preload was built in development mode.
- `chrome.debugger` could reach past the tab it was attached to: other targets, the host's windows, other extensions' pages and workers, local files and any site's data. It now has only the DevTools commands Chrome allows an extension, the tab's own frames and workers, and a redirect into another extension's page detaches it.
- An extension with `webRequest` could answer for another extension's blocking listener and so cancel or redirect any request.
- A `declarativeNetRequest` rule's or `downloads.search` regular expression could hold up the main process.
- Each event for an extension's service worker first asked Chromium to start it, so a busy page's requests queued behind those calls, about 90 ms each with a blocking webRequest listener such as an ad blocker's. Events now go straight to a worker that runs.
- `removeListener` never removed a listener.
- Events sent right after an extension loaded could be dropped for 30 seconds.
- Host permission patterns could be passed by a URL carrying the host in its path or query, and a pattern full of stars could stall the main process.
- Extensions shared one isolated world for injected scripts and could read each other's globals.
- An extension could listen to events of APIs it had no permission for.
- An offscreen document kept a host that quits with its last window from quitting.
- A worker lost the shell's APIs when another extension loaded or unloaded.

## [4.0.0] - 2024-10-22

### Added

- BREAKING: Added required `license` property to ElectronChromeExtensions constructor.

There are several applications distributing this package without sponsoring. I'm attempting to make this requirement more obvious ahead of Manifest V3 support.

## [3.10.1] - 2023-06-02

### Fixed

- `chrome.webNavigation` internals erroring due to electron@25.x.y deprecations.
- Unloaded extensions are now removed from `<browser-action-list>`.

## [3.10.0] - 2023-01-16

### Added

- Added URL pattern matching to `chrome.tabs.query`.
- Added title pattern matching to `chrome.tabs.query`.
- `chrome.tabs.create` and `chrome.tabs.update` now resolve relative URLs.

### Changed

- `ElectronChromeExtensions.getContextMenuItems()` now groups multiple top-level items under an extension submenu.
- Removed the ability for `tabs.create` and `tabs.update` to set `chrome://` or `javascript:` URLs.
- Updated vulnerable dependencies.

## [3.9.0] - 2021-09-04

### Added

- `chrome.webNavigation.onDOMContentLoaded` for iframes—`electron@15.0.0-beta.2` required.

### Changed

- Reduced IPC traffic for updated extension icons.

### Fixed

- `chrome.contextMenus.onClicked` callback was never invoked.
- `partition` of `<browser-action-list>` would error when a remote session partition was set.

## [3.8.0] - 2021-06-14

### Added

- `chrome.cookies.onChanged`
- `chrome.extension.isAllowedIncognitoAccess`

### Changed

- Extension background scripts now subscribe to API events to cut down on IPC traffic.
- `selectTab()` from the `ElectronChromeExtensions` constructor options is now called when the Chrome extensions API sets the active tab.

## [3.7.0] - 2021-06-05

### Added

- Exposed `action` and `badge` CSS shadow parts for customizing `<browser-action-list>` element.

### Fixed

- Calling `ElectronChromeExtensions.getContextMenuItems()` threw an error when no `browser_action` was defined in an extension's manifest file.

## [3.6.1] - 2021-06-05

### Added

- Included license files in NPM package.

## [3.6.0] - 2021-05-20

### Added

- Initial `chrome.contextMenu` support when right-clicking browser actions.
- Support `chrome.contextMenu` entries with `parentId` set.
- Added `ElectronChromeExtensions.fromSession()` to get an existing instance.

### Changed

- Renamed `Extensions` class to `ElectronChromeExtensions`.

### Fixed

- Disabled `chrome.contextMenu` items now appear disabled instead of being hidden.

## [3.5.0] - 2021-05-09

### Added

- Stubbed `chrome.commands` methods.

### Fixed

- Browser action popup not using `browserAction.setPopup()` value.

## [3.4.0] - 2021-04-07

### Added

- Added `Extensions.removeExtension(extension)`.

### Changed

- Improvements to the browser action styles.

### Fixed

- Errors being thrown in Electron 12 when `'extension-unloaded'` is emitted.

## [3.3.0] - 2021-02-10

### Added

- `<browser-action-list>` now supports custom sessions which can be set using the `partition` attribute.

### Changed

- `<browser-action-list>`'s `tab` attribute is now optional and will use the active tab by default.

### Fixed

- Fixed `browser-action-list` badge text not updating after being removed.

## [3.2.0] - 2021-02-07

### Added

- Added `modulePath` option to `Extensions` constructor.

## [3.1.1] - 2021-01-27

### Fixed

- Fix `browser-action-list` API not working when `contextIsolation` is disabled.

## [3.1.0] - 2021-01-24

### Added

- Basic `chrome.notifications` support
- `chrome.browserAction.onClicked`
- `chrome.tabs.executeScript` for the active tab
- `chrome.webNavigation.onBeforeNavigate`, `chrome.webNavigation.onDOMContentLoaded`, `chrome.webNavigation.onCompleted`
- `chrome.webNavigation.getFrame` and `chrome.webNavigation.getAllFrames` (Electron 12+)

## [3.0.0] - 2021-01-15

### Added 

- Most of `chrome.cookies`
- Most of `chrome.windows`
- `chrome.tabs.getAllInWindow`
- `chrome.webNavigation.getAllFrames`
- `chrome.storage` now uses `local` as a fallback for `sync` and `managed`
  which aren't currently supported by Electron.
- Basic hover style for `<browser-action-list>` items.

### Changed

- BREAKING: Replace `event` object passed into `Extensions` constructor option.
  functions with an instance of the tab's `BrowserWindow` owner.

### Fixed

- Extension action popups now resize appropriately in electron@12.x.y.

[4.0.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.10.1...electron-chrome-extensions@4.0.0
[3.10.1]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.10.0...electron-chrome-extensions@3.10.1
[3.10.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.9.0...electron-chrome-extensions@3.10.0
[3.9.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.8.0...electron-chrome-extensions@3.9.0
[3.8.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.7.0...electron-chrome-extensions@3.8.0
[3.7.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.6.1...electron-chrome-extensions@3.7.0
[3.6.1]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.6.0...electron-chrome-extensions@3.6.1
[3.6.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.5.0...electron-chrome-extensions@3.6.0
[3.5.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.4.0...electron-chrome-extensions@3.5.0
[3.4.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.3.0...electron-chrome-extensions@3.4.0
[3.3.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.2.0...electron-chrome-extensions@3.3.0
[3.2.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.1.1...electron-chrome-extensions@3.2.0
[3.1.1]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.0.1...electron-chrome-extensions@3.1.1
[3.1.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@3.0.0...electron-chrome-extensions@3.1.0
[3.0.0]: https://github.com/samuelmaddock/electron-browser-shell/compare/electron-chrome-extensions@2.1.0...electron-chrome-extensions@3.0.0
