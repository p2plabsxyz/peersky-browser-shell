# @p2plabs/peersky-chrome-extensions

> Chrome extension API support for Electron, built for Peersky.

Npm: [`@p2plabs/peersky-chrome-extensions`](https://www.npmjs.com/package/@p2plabs/peersky-chrome-extensions).

Electron provides [basic support for Chrome extensions](https://www.electronjs.org/docs/api/extensions) out of the box. However, it only supports a subset of APIs with a focus on DevTools. Concepts like tabs, popups, and extension actions aren't known to Electron.

This library aims to bring extension support in Electron up to the level you'd come to expect from a browser like Google Chrome. API behavior is customizable so you can define how to handle things like tab or window creation specific to your application's needs.

## Install

```
npm install @p2plabs/peersky-chrome-extensions
```

## Screenshots

| VeePN                                                                                                                                                         | Ghostery Reader                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|<img src="./Screenshot-VPN.png" width="470"> | <img src="./Screenshot-ghostery.png" width="391"> |



## Usage

### Basic

Simple browser using Electron's [default session](https://www.electronjs.org/docs/api/session#sessiondefaultsession) and one tab.

```js
const { app, BrowserWindow } = require('electron')
const { ElectronChromeExtensions } = require('@p2plabs/peersky-chrome-extensions')

app.whenReady().then(() => {
  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
  })
  const browserWindow = new BrowserWindow()

  // Adds the active tab of the browser
  extensions.addTab(browserWindow.webContents, browserWindow)

  browserWindow.loadURL('https://samuelmaddock.com')
  browserWindow.show()
})
```

### Advanced

Multi-tab browser with full support for Chrome extension APIs.

> For a complete example, see the [`electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell) project.

```js
const { app, session, BrowserWindow } = require('electron')
const { ElectronChromeExtensions } = require('@p2plabs/peersky-chrome-extensions')

app.whenReady().then(() => {
  const browserSession = session.fromPartition('persist:custom')

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: browserSession,
    createTab(details) {
      // Optionally implemented for chrome.tabs.create support
    },
    selectTab(tab, browserWindow) {
      // Optionally implemented for chrome.tabs.update support
    },
    removeTab(tab, browserWindow) {
      // Optionally implemented for chrome.tabs.remove support
    },
    createWindow(details) {
      // Optionally implemented for chrome.windows.create support
    },
    removeWindow(browserWindow) {
      // Optionally implemented for chrome.windows.remove support
    },
    requestPermissions(extension, permissions) {
      // Optionally implemented for chrome.permissions.request support
    },
  })

  const browserWindow = new BrowserWindow({
    webPreferences: {
      // Use same session given to Extensions class
      session: browserSession,
      // Required for extension preload scripts
      sandbox: true,
      // Recommended for loading remote content
      contextIsolation: true,
    },
  })

  // Adds the active tab of the browser
  extensions.addTab(browserWindow.webContents, browserWindow)

  browserWindow.loadURL('https://samuelmaddock.com')
  browserWindow.show()
})
```

### Packaging the preload script

This module uses a [preload script](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload#what-is-a-preload-script).
When packaging your application, it's required that the preload script is included. This can be
handled in two ways:

1. Include `node_modules` in your packaged app. This allows `@p2plabs/peersky-chrome-extensions/preload` to
   be resolved.
2. In the case of using JavaScript bundlers, you may need to copy the preload script next to your
   app's entry point script. You can try using
   [copy-webpack-plugin](https://github.com/webpack-contrib/copy-webpack-plugin),
   [vite-plugin-static-copy](https://github.com/sapphi-red/vite-plugin-static-copy),
   or [rollup-plugin-copy](https://github.com/vladshcherbin/rollup-plugin-copy) depending on your app's
   configuration.

Here's an example for webpack configurations:

```js
module.exports = {
  entry: './index.js',
  plugins: [
    new CopyWebpackPlugin({
      patterns: [require.resolve('@p2plabs/peersky-chrome-extensions/preload')],
    }),
  ],
}
```

## API

### Class: ElectronChromeExtensions

> Create main process handler for Chrome extension APIs.

#### `new ElectronChromeExtensions([options])`

- `options` Object
  - `license` String - Distribution license compatible with your application. See LICENSE.md for more details. \
     Valid options include `GPL-3.0`, `Patron-License-2020-11-19`
  - `session` Electron.Session (optional) - Session which should support
    Chrome extension APIs. `session.defaultSession` is used by default.
  - `createTab(details) => Promise<[Electron.WebContents, Electron.BrowserWindow]>` (optional) -
    Called when `chrome.tabs.create` is invoked by an extension. Allows the
    application to handle how tabs are created.
    - `details` [chrome.tabs.CreateProperties](https://developer.chrome.com/docs/extensions/reference/tabs/#method-create)
  - `selectTab(webContents, browserWindow)` (optional) - Called when
    `chrome.tabs.update` is invoked by an extension with the option to set the
    active tab.
    - `webContents` Electron.WebContents - The tab to be activated.
    - `browserWindow` Electron.BrowserWindow - The window which owns the tab.
  - `removeTab(webContents, browserWindow)` (optional) - Called when
    `chrome.tabs.remove` is invoked by an extension.
    - `webContents` Electron.WebContents - The tab to be removed.
    - `browserWindow` Electron.BrowserWindow - The window which owns the tab.
  - `createWindow(details) => Promise<Electron.BrowserWindow>`
    (optional) - Called when `chrome.windows.create` is invoked by an extension.
    - `details` [chrome.windows.CreateData](https://developer.chrome.com/docs/extensions/reference/windows/#method-create)
  - `removeWindow(browserWindow) => Promise<Electron.BrowserWindow>`
    (optional) - Called when `chrome.windows.remove` is invoked by an extension.
    - `browserWindow` Electron.BrowserWindow
  - `assignTabDetails(details, webContents) => void` (optional) - Called when `chrome.tabs` creates
    an object for tab details to be sent to an extension background script. Provide this function to
    assign custom details such as `discarded`, `frozen`, or `groupId`.
    - `details` [chrome.tabs.Tab](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab)
    - `webContents` Electron.WebContents - The tab for which details are being created.

```ts
new ElectronChromeExtensions({
  license: 'GPL-3.0',
  createTab(details) {
    const tab = myTabApi.createTab()
    if (details.url) {
      tab.webContents.loadURL(details.url)
    }
    return [tab.webContents, tab.browserWindow]
  },
  createWindow(details) {
    const window = new BrowserWindow()
    return window
  },
})
```

For a complete usage example, see the browser implementation in the
[`electron-browser-shell`](https://github.com/samuelmaddock/electron-browser-shell/blob/master/packages/shell/browser/main.js)
project.

#### Instance Methods

##### `extensions.addTab(tab, window)`

- `tab` Electron.WebContents - A tab that the extension system should keep
  track of.
- `window` Electron.BrowserWindow - The window which owns the tab.

Makes the tab accessible from the `chrome.tabs` API.

##### `extensions.selectTab(tab)`

- `tab` Electron.WebContents

Notify the extension system that a tab has been selected as the active tab.

##### `extensions.getContextMenuItems(tab, params)`

- `tab` Electron.WebContents - The tab from which the context-menu event originated.
- `params` Electron.ContextMenuParams - Parameters from the [`context-menu` event](https://www.electronjs.org/docs/api/web-contents#event-context-menu).

Returns [`Electron.MenuItem[]`](https://www.electronjs.org/docs/api/menu-item#class-menuitem) -
An array of all extension context menu items given the context.

##### `extensions.getURLOverrides()`

Returns `Object` which maps special URL types to an extension URL. See [chrome_urls_overrides](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides) for a list of
supported URL types.

Example:

```js
{
  newtab: 'chrome-extension://<id>/newtab.html'
}
```

#### Instance Events

##### Event: 'browser-action-popup-created'

Returns:

- `popup` PopupView - An instance of the popup.

Emitted when a popup is created by the `chrome.browserAction` API.

##### Event: 'url-overrides-updated'

Returns:

- `urlOverrides` Object - A map of url types to extension URLs.

Emitted after an extension is loaded with [chrome_urls_overrides](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides) set.

### Element: `<browser-action-list>`

<img src="./screenshot-browser-action.png" width="438">

The `<browser-action-list>` element provides a row of [browser actions](https://developer.chrome.com/extensions/browserAction) which may be pressed to activate the `chrome.browserAction.onClicked` event or display the extension popup.

To enable the element on a webpage, you must define a preload script which injects the API on specific pages.

#### Attributes

- `partition` string (optional) - The `Electron.Session` partition which extensions are loaded in. Defaults to the session in which `<browser-action-list>` lives.
- `tab` string (optional) - The tab's `Electron.WebContents` ID to use for displaying
  the relevant browser action state. Defaults to the active tab of the current browser window.
- `alignment` string (optional) - How the popup window should be aligned relative to the extension action. Defaults to `bottom left`. Use any assortment of `top`, `bottom`, `left`, and `right`.

#### Browser action example

##### Preload

Inject the browserAction API to make the `<browser-action-list>` element accessible in your application.

```js
import { injectBrowserAction } from '@p2plabs/peersky-chrome-extensions/browser-action'

// Inject <browser-action-list> element into our page
if (location.href === 'webui://browser-chrome.html') {
  injectBrowserAction()
}
```

> The use of `import` implies that your preload script must be compiled using a JavaScript bundler like Webpack.

##### Webpage

Add the `<browser-action-list>` element with attributes appropriate for your application.

```html
<!-- Show actions for the same session and active tab of current window. -->
<browser-action-list></browser-action-list>

<!-- Show actions for custom session and active tab of current window. -->
<browser-action-list partition="persist:custom"></browser-action-list>

<!-- Show actions for custom session and a specific tab of current window. -->
<browser-action-list partition="persist:custom" tab="1"></browser-action-list>

<!-- If extensions are displayed in the bottom left of your browser UI, then
     you can align the popup to the top right of the extension action. -->
<browser-action-list alignment="top right"></browser-action-list>
```

##### Main process

For extension icons to appear in the list, the `crx://` protocol needs to be handled in the Session
where it's intended to be displayed.

```js
import { app, session } from 'electron'
import { ElectronChromeExtensions } from '@p2plabs/peersky-chrome-extensions'

app.whenReady().then(() => {
  // Provide the session where your app will display <browser-action-list>
  const appSession = session.defaultSession
  ElectronChromeExtensions.handleCRXProtocol(appSession)
})
```

##### Custom CSS

The `<browser-action-list>` element is a [Web Component](https://developer.mozilla.org/en-US/docs/Web/Web_Components). Its styles are encapsulated within a [Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/Web_Components/Using_shadow_DOM). However, it's still possible to customize its appearance using the [CSS shadow parts](https://developer.mozilla.org/en-US/docs/Web/CSS/::part) selector `::part(name)`.

Accessible parts include `action` and `badge`.

```css
/* Layout action buttons vertically. */
browser-action-list {
  flex-direction: column;
}

/* Modify size of action buttons. */
browser-action-list::part(action) {
  width: 16px;
  height: 16px;
}

/* Modify hover styles of action buttons. */
browser-action-list::part(action):hover {
  background-color: red;
  border-radius: 0;
}
```

## Supported `chrome.*` APIs

Every API below answers as Chrome 157 does: the same values, events, argument checks and error messages. Two test extensions in `spec/fixtures/chrome-api-probe` and `spec/fixtures/chrome-api-probe-peer` were run in Chrome for Testing 157, and what Chrome answered is kept in `spec/fixtures/chrome-api-probe/chrome-results.json`. `spec/chrome-api-parity-spec.ts` runs the same extensions in the shell on every test run and fails on any answer that differs. The few places where the shell differs on purpose are listed, each with its reason, in `spec/fixtures/chrome-api-probe/known-differences.json`.

An API shows up only for an extension that asks for its permission, as in Chrome, and every call is checked again in the main process. An extension sees a tab's url, title and favicon only with the `tabs` permission, host access to that page, or activeTab. Host access follows Chrome's match patterns, and activeTab is granted when the person clicks the extension's toolbar button, a context menu item of its, its keyboard shortcut or its omnibox keyword.

| API | Notes for the host |
| --- | --- |
| `chrome.action`, `chrome.browserAction` | Toolbar state for `<browser-action-list>`. `isActionOnToolbar` hook. |
| `chrome.alarms` | Kept per session. Chrome's 30 second minimum for extensions that are not unpacked (`getExtensionInstallType` hook). |
| `chrome.bookmarks` | A tree like Chrome's, kept per session. Follow changes with the `bookmarks-changed` event; push the host's own bookmarks with `replaceBookmarks()` or `importBookmarks()`. |
| `chrome.browsingData` | Removes the session's data. Return the host's own pages from the `getProtectedOrigins` hook so they are never cleared. |
| `chrome.commands` | Call `api.commands.execute(extensionId, name)` when the person presses a shortcut. |
| `chrome.contentSettings` | Rules kept per session. JavaScript, images and cookies apply on the `webRequest` bridge; ask `getContentSetting(type, url)` from the host's permission and window-open handlers. |
| `chrome.contextMenus` | `getContextMenuItems(webContents, params)` builds the items. |
| `chrome.cookies` | Only cookies of hosts the extension has access to. |
| `chrome.debugger` | Only tabs; never browser pages or other extensions' pages. |
| `chrome.declarativeContent` | Rules kept per session; ShowAction, SetIcon and RequestContentScript. |
| `chrome.declarativeNetRequest` | Static, dynamic and session rules on the `webRequest` bridge. |
| `chrome.desktopCapture` | `chooseDesktopMedia` hook for the host's picker; without it every request is cancelled. |
| `chrome.downloads` | Kept per session. `setDownloadUiEnabled` hook. |
| `chrome.extension`, `chrome.runtime` | `onInstalled`, `onStartup`, `onExtensionLoaded` and `onEnabled` fire as in Chrome. |
| `chrome.fontSettings` | Kept per session. Pass `getFontWebPreferences()` to new tabs. |
| `chrome.history`, `chrome.topSites` | Visits are recorded only while an extension with `history` or `topSites` is loaded. Call `clearHistory()` from the host's own "clear history". |
| `chrome.i18n`, `chrome.idle`, `chrome.power`, `chrome.storage` | `local` and `session` are Electron's own stores, shared with content scripts as in Chrome; `sync` is the shell's, encrypted with `safeStorage`; `managed` reads the `getManagedStorage` hook. |
| `chrome.identity` | `launchWebAuthFlow`; no Google account sign-in. |
| `chrome.management` | `setExtensionEnabled`, `confirmUninstall` and `uninstallExtension` hooks. |
| `chrome.notifications` | Shown with Electron's `Notification`. |
| `chrome.offscreen` | One document per extension, in a view outside any window. |
| `chrome.omnibox` | Drive it from the address bar with `getOmniboxKeywords()`, `omniboxInputStarted()`, `omniboxInputChanged()`, `omniboxInputEntered()` and `omniboxInputCancelled()`. |
| `chrome.pageCapture`, `chrome.tabCapture` | |
| `chrome.permissions` | Optional permissions need a user gesture and the person's yes (the `requestPermissions` hook, or a system dialog), and are kept across restarts. |
| `chrome.privacy` | Kept per session. Read the rest with `getPrivacySettings()`. |
| `chrome.proxy` | Applied with `session.setProxy`. |
| `chrome.readingList`, `chrome.search` | `getSearchUrl` hook for the host's search engine. |
| `chrome.scripting`, `chrome.userScripts` | userScripts is off until the host's `isUserScriptsAllowed` hook allows it for the extension, as Chrome's "Allow User Scripts" switch does; while off, `chrome.userScripts` is not there. |
| `chrome.sessions` | Tabs and windows closed in this run. |
| `chrome.sidePanel` | `openSidePanel` and `closeSidePanel` hooks. |
| `chrome.system.cpu`, `.memory`, `.display`, `.storage` | |
| `chrome.tabGroups` | `updateTabGroup` hook and `tab-group-*` events to show groups. |
| `chrome.tabs`, `chrome.windows` | `createTab`, `selectTab`, `removeTab`, `createWindow`, `removeWindow`, `getTabIndex`, `moveTab`, `highlightTabs`, `pinTab` and `discardTab` hooks. |
| `chrome.tts` | Speaks from a hidden page. |
| `chrome.webNavigation`, `chrome.webRequest` | The host passes every request to the `notifyWebRequest*` methods, since Electron gives each `session.webRequest` event to one handler only. |

Not supported: Chrome's sign-in (`identity.getAuthToken`), `chrome.gcm`, ChromeOS-only APIs, split view, and `chrome.dom` (Electron gives script no way to reach a closed shadow root).

### For the host

All hooks on the `ElectronChromeExtensions` options are optional; each has a safe default, documented in `src/browser/impl.ts`. Extension state (alarms, permissions, rules, settings, bookmarks, storage) is kept in the session's own folder, so two sessions never share it and an in-memory session never writes it to disk. Version 1.x kept it in one folder under userData; 2.0 reads that once.

### Development & testing

From the `peersky-chrome-extensions` directory:

```bash
yarn install
yarn build
yarn test
```

The test suite runs **Electron + Mocha** (see `spec/index.js`). It expects a dev install that includes `yargs` (listed in `devDependencies`).

- **CI-equivalent run** (build + tests): `yarn test:ci`
- **Against Chrome**: `PROBE_SUITES=tabs,windows PROBE_RESULTS_OUT=/tmp/shell.json yarn test --files spec/chrome-api-parity-spec.ts` runs some of the probe suites, and `node script/probe-diff.js /tmp/shell.json tabs,windows` shows where the shell differs from Chrome. To record Chrome's answers again after changing a suite, run `CHROME=<Chrome for Testing binary> node script/chrome-parity.mjs --only=tabs` (branded Chrome no longer loads unpacked extensions from the command line). Chrome runs headless with a temporary profile.
- **Native messaging tests** (`spec/chrome-nativeMessaging-spec.ts`) build a small SEA host under `script/native-messaging-host/`. That step can be slow or flaky on some Windows/CI machines. In GitHub Actions we set `SKIP_NATIVE_MESSAGING=1` so the rest of the suite stays green; to run those tests locally, omit that variable and use a machine where `node script/native-messaging-host/build.js <extensionId>` completes successfully.

### Continuous integration

The workflow `.github/workflows/peersky-chrome-extensions.yml` runs `yarn install --frozen-lockfile` and `yarn test:ci` on Ubuntu (with `xvfb-run`) and Windows when files under `peersky-chrome-extensions/` change.

## Limitations

### `@p2plabs/peersky-chrome-extensions`

- Electron 43 or later (`peerDependencies.electron` is `>=43.0.0`), which is what the tests run on.
- Content scripts run on Electron's own bindings, which the shell cannot add to: `chrome.storage.sync` is not available in them.

### electron

- Electron gives each `session.webRequest` event to one handler only, so the host owns them and passes each request to the `notifyWebRequest*` methods; requests it does not pass on are never seen by `chrome.webRequest`, `declarativeNetRequest`, `chrome.privacy` or `chrome.contentSettings`.
- Chrome extensions are not supported in non-persistent/incognito sessions.
- `chrome.webNavigation.onDOMContentLoaded` is only emitted for the top frame until [support for iframes](https://github.com/electron/electron/issues/27344) is added.
- Service worker preload scripts require Electron's sandbox to be enabled. This is the default behavior, but might be overridden by the `--no-sandbox` flag or `sandbox: false` in the `webPreferences` of a `BrowserWindow`. Check for the `--no-sandbox` flag using `ps -eaf | grep <appname>`.

## License

GPL-3

This package is published from the Peersky fork ([github.com/p2plabsxyz/peersky-browser-shell](https://github.com/p2plabsxyz/peersky-browser-shell)); see `LICENSE.md` in the tarball.

For proprietary use, please [contact me](mailto:sam@samuelmaddock.com?subject=electron-chrome-extensions%20license) or [sponsor me on GitHub](https://github.com/sponsors/samuelmaddock/) under the appropriate tier to [acquire a proprietary-use license](https://github.com/samuelmaddock/electron-browser-shell/blob/master/LICENSE-PATRON.md). These contributions help make development and maintenance of this project more sustainable and show appreciation for the work thus far.
