import { expect } from 'chai'
import { app, BrowserWindow } from 'electron'
import { emittedOnce } from './events-helpers'

import { useExtensionBrowser, useServer } from './hooks'
import type { ChromeExtensionImpl } from '../src/browser/impl'

describe('chrome.tabs', () => {
  let assignTabDetails: ChromeExtensionImpl['assignTabDetails']

  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'rpc',
    assignTabDetails(details, tab) {
      assignTabDetails?.(details, tab)
    },
  })
  const captureBrowser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-tabs-capture',
  })

  afterEach(() => {
    assignTabDetails = undefined
  })

  describe('get()', () => {
    it('returns tab details', async () => {
      const tabId = browser.window.webContents.id
      const result = await browser.crx.exec('tabs.get', tabId)
      expect(result).to.be.an('object')
      expect(result.id).to.equal(tabId)
      expect(result.windowId).to.equal(browser.window.id)
    })
  })

  describe('getCurrent()', () => {
    // Chrome gives the tab the calling page is shown in, and nothing to a
    // background page, which is not in a tab.
    it('gives nothing to a background page', async () => {
      const result = await browser.crx.exec('tabs.getCurrent')
      expect(result == null).to.equal(true)
    })
  })

  describe('create()', () => {
    it('creates a tab', async () => {
      const wcPromise = emittedOnce(app, 'web-contents-created')
      const tabInfo = await browser.crx.exec('tabs.create', { url: server.getUrl() })
      const [, wc] = await wcPromise
      expect(tabInfo).to.be.an('object')
      expect(tabInfo.id).to.equal(wc.id)
      expect(tabInfo.active).to.equal(true)
      expect(tabInfo.url).to.equal(server.getUrl())
      expect(tabInfo.windowId).to.equal(browser.window.id)
      expect(tabInfo.title).to.be.a('string')
    })

    // TODO: Navigating to chrome-extension:// receives ERR_BLOCKED_BY_CLIENT (-20)
    it.skip('resolves relative URL', async () => {
      const relativeUrl = './options.html'
      const tabInfo = await browser.crx.exec('tabs.create', { url: relativeUrl })
      const url = new URL(relativeUrl, browser.extension.url).href
      expect(tabInfo).to.be.an('object')
      expect(tabInfo.url).to.equal(url)
    })

    it('fails on chrome:// URLs', async () => {
      const tabInfo = await browser.crx.exec('tabs.create', { url: 'chrome://kill' })
      expect(tabInfo).to.be.a('null')
    })

    it('fails on javascript: URLs', async () => {
      const tabInfo = browser.crx.exec('tabs.create', { url: "javascript:alert('hacked')" })
      expect(await tabInfo).to.be.a('null')
    })
  })

  describe('query()', () => {
    it('gets the active tab', async () => {
      const result = await browser.crx.exec('tabs.query', { active: true })
      expect(result).to.be.an('array')
      expect(result).to.be.length(1)
      expect(result[0].id).to.be.equal(browser.window.webContents.id)
      expect(result[0].windowId).to.be.equal(browser.window.id)
    })

    it('gets the active tab of multiple windows', async () => {
      const secondWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      browser.extensions.addTab(secondWindow.webContents, secondWindow)

      const result = await browser.crx.exec('tabs.query', { active: true })
      expect(result).to.be.an('array')
      expect(result).to.be.length(2)
      expect(result[0].windowId).to.be.equal(browser.window.id)
      expect(result[1].windowId).to.be.equal(secondWindow.id)
    })

    it('matches exact title', async () => {
      const results = await browser.crx.exec('tabs.query', { title: 'title' })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].title).to.be.equal('title')
    })

    it('matches title pattern', async () => {
      const results = await browser.crx.exec('tabs.query', { title: '*' })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].title).to.be.equal('title')
    })

    it('matches exact url', async () => {
      const url = server.getUrl()
      const results = await browser.crx.exec('tabs.query', { url })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].url).to.be.equal(url)
    })

    it('matches wildcard url pattern', async () => {
      const url = 'http://*/*'
      const results = await browser.crx.exec('tabs.query', { url })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].url).to.be.equal(server.getUrl())
    })

    it('matches either url pattern', async () => {
      const patterns = ['http://foo.bar/*', `${server.getUrl()}*`]
      const results = await browser.crx.exec('tabs.query', { url: patterns })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].url).to.be.equal(server.getUrl())
    })

    it('returns deterministic window-local indexes', async () => {
      const first = await browser.crx.exec('tabs.create', { url: `${server.getUrl()}index-a` })
      const second = await browser.crx.exec('tabs.create', { url: `${server.getUrl()}index-b` })
      await new Promise<void>((resolve) => setTimeout(resolve, 20))

      const sameWindowTabs = await browser.crx.exec('tabs.query', { windowId: browser.window.id })
      const firstTab = sameWindowTabs.find((tab: any) => tab.id === first.id)
      const secondTab = sameWindowTabs.find((tab: any) => tab.id === second.id)

      expect(firstTab).to.be.an('object')
      expect(secondTab).to.be.an('object')
      expect(firstTab.index).to.be.a('number')
      expect(secondTab.index).to.be.a('number')
      expect(secondTab.index).to.equal(firstTab.index + 1)
    })

    it('supports index filtering against stable indexes', async () => {
      const tabs = await browser.crx.exec('tabs.query', { windowId: browser.window.id })
      expect(tabs.length).to.be.greaterThan(0)
      const target = tabs[0]

      const byIndex = await browser.crx.exec('tabs.query', {
        windowId: browser.window.id,
        index: target.index,
      })
      expect(byIndex).to.be.an('array')
      expect(byIndex.some((tab: any) => tab.id === target.id)).to.equal(true)
    })
  })

  describe('reload()', () => {
    it('reloads the active tab', async () => {
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.reload')
      await navigatePromise
    })

    it('reloads a specified tab', async () => {
      const tabId = browser.window.webContents.id
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.reload', tabId)
      await navigatePromise
    })
  })

  describe('update()', () => {
    it('navigates the tab', async () => {
      const tabId = browser.window.webContents.id
      const updateUrl = `${server.getUrl()}foo`
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.update', tabId, { url: updateUrl })
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(updateUrl)
    })

    it('navigates the active tab', async () => {
      const updateUrl = `${server.getUrl()}foo`
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.update', { url: updateUrl })
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(updateUrl)
    })

    it('fails on chrome:// URLs', async () => {
      const tabId = browser.webContents.id
      const tabInfo = await browser.crx.exec('tabs.update', tabId, { url: 'chrome://kill' })
      expect(tabInfo).to.be.a('null')
    })
  })

  describe('goForward()', () => {
    it('navigates the active tab forward', async () => {
      const initialUrl = browser.window.webContents.getURL()
      const targetUrl = `${server.getUrl()}foo`
      await browser.window.webContents.loadURL(targetUrl)
      expect(browser.window.webContents.navigationHistory.canGoBack()).to.be.true
      browser.window.webContents.navigationHistory.goBack()
      await emittedOnce(browser.window.webContents, 'did-navigate')
      expect(browser.window.webContents.navigationHistory.canGoForward()).to.be.true
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goForward')
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(targetUrl)
    })

    it('navigates a specified tab forward', async () => {
      const tabId = browser.window.webContents.id
      const initialUrl = browser.window.webContents.getURL()
      const targetUrl = `${server.getUrl()}foo`
      await browser.window.webContents.loadURL(targetUrl)
      expect(browser.window.webContents.navigationHistory.canGoBack()).to.be.true
      browser.window.webContents.navigationHistory.goBack()
      await emittedOnce(browser.window.webContents, 'did-navigate')
      expect(browser.window.webContents.navigationHistory.canGoForward()).to.be.true
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goForward', tabId)
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(targetUrl)
    })
  })

  describe('goBack()', () => {
    it('navigates the active tab back', async () => {
      const initialUrl = browser.window.webContents.getURL()
      await browser.window.webContents.loadURL(`${server.getUrl()}foo`)
      expect(browser.window.webContents.navigationHistory.canGoBack()).to.be.true
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goBack')
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
    })

    it('navigates a specified tab back', async () => {
      const tabId = browser.window.webContents.id
      const initialUrl = browser.window.webContents.getURL()
      await browser.window.webContents.loadURL(`${server.getUrl()}foo`)
      expect(browser.window.webContents.canGoBack()).to.be.true
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goBack', tabId)
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
    })
  })

  describe('duplicate()', () => {
    it('duplicates a tab in the same window with the same URL', async () => {
      const source = await browser.crx.exec('tabs.get', browser.window.webContents.id)

      const duplicated = await browser.crx.exec('tabs.duplicate', source.id)
      expect(duplicated).to.be.an('object')
      expect(duplicated.id).to.not.equal(source.id)
      expect(duplicated.windowId).to.equal(source.windowId)
      expect(duplicated.url).to.equal(source.url)
    })
  })

  describe('move() and highlight()', () => {
    it('moves a tab to the requested index', async () => {
      const created = await browser.crx.exec('tabs.create', { url: `${server.getUrl()}moved` })
      const moved = await browser.crx.exec('tabs.move', created.id, { index: 0 })
      expect(moved).to.be.an('object')
      expect((moved as any).id).to.equal(created.id)
      expect((moved as any).index).to.equal(0)
    })

    it('accepts index -1 to move a tab to the end of the window', async () => {
      await browser.crx.exec('tabs.create', { url: `${server.getUrl()}move-end-a` })
      const toMove = await browser.crx.exec('tabs.create', { url: `${server.getUrl()}move-end-b` })
      const moved = await browser.crx.exec('tabs.move', toMove.id, { index: -1 })
      expect(moved).to.be.an('object')
      expect((moved as any).id).to.equal(toMove.id)
      const all = await browser.crx.exec('tabs.query', { windowId: browser.window.id })
      expect(all).to.be.an('array')
      const idx = (all as any[]).findIndex((t: any) => t.id === toMove.id)
      expect(idx).to.equal((all as any[]).length - 1)
    })

    it('highlights the requested index', async () => {
      await browser.crx.exec('tabs.create', { url: `${server.getUrl()}highlight-a` })
      await browser.crx.exec('tabs.create', { url: `${server.getUrl()}highlight-b` })
      const highlightedWindow = await browser.crx.exec('tabs.highlight', {
        windowId: browser.window.id,
        tabs: 1,
      })
      expect(highlightedWindow).to.be.an('object')
      expect((highlightedWindow as any).id).to.equal(browser.window.id)

      const highlightedTabs = await browser.crx.exec('tabs.query', {
        windowId: browser.window.id,
        highlighted: true,
      })
      expect(highlightedTabs).to.be.an('array')
      expect(highlightedTabs.length).to.be.greaterThan(0)
    })
  })

  describe('zoom methods', () => {
    it('supports zoom roundtrip', async () => {
      const tabId = browser.window.webContents.id
      const initial = await browser.crx.exec('tabs.getZoom', tabId)
      expect(initial).to.be.a('number')

      await browser.crx.exec('tabs.setZoom', tabId, 1.25)
      const updated = await browser.crx.exec('tabs.getZoom', tabId)
      expect(updated).to.be.closeTo(1.25, 0.01)
    })

    it('supports reset via setZoom(..., 0)', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('tabs.setZoom', tabId, 1.35)
      const changed = await browser.crx.exec('tabs.getZoom', tabId)
      expect(changed).to.be.closeTo(1.35, 0.01)

      await browser.crx.exec('tabs.setZoom', tabId, 0)
      const reset = await browser.crx.exec('tabs.getZoom', tabId)
      expect(reset).to.be.closeTo(1, 0.01)
    })

    it('returns zoom settings and accepts supported settings', async () => {
      const tabId = browser.window.webContents.id
      const settings = await browser.crx.exec('tabs.getZoomSettings', tabId)
      expect(settings).to.be.an('object')
      expect(settings.mode).to.equal('automatic')
      expect(settings.scope).to.equal('per-origin')

      await browser.crx.exec('tabs.setZoomSettings', tabId, {
        mode: 'automatic',
        scope: 'per-origin',
      })
      const after = await browser.crx.exec('tabs.getZoomSettings', tabId)
      expect(after.mode).to.equal('automatic')
      expect(after.scope).to.equal('per-origin')
    })

    it('accepts per-tab manual settings', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('tabs.setZoomSettings', tabId, {
        mode: 'manual',
        scope: 'per-tab',
        defaultZoomFactor: 1.1,
      })
      await browser.crx.exec('tabs.setZoom', tabId, 1.2)

      const settings = await browser.crx.exec('tabs.getZoomSettings', tabId)
      expect(settings).to.be.an('object')
      expect(settings.mode).to.equal('manual')
      expect(settings.scope).to.equal('per-tab')
    })
  })

  describe('executeScript()', () => {
    it('injects code into a tab', async () => {
      const tabId = browser.window.webContents.id
      const [result] = await browser.crx.exec('tabs.executeScript', tabId, {
        code: 'location.href',
      })
      expect(result).to.equal(browser.window.webContents.getURL())
    })

    it('injects code into the active tab', async () => {
      const [result] = await browser.crx.exec('tabs.executeScript', { code: 'location.href' })
      expect(result).to.equal(browser.window.webContents.getURL())
    })
  })

  describe('captureVisibleTab()', () => {
    // Chrome's default format is JPEG.
    it('returns a JPEG data URL by default', async () => {
      const result = await captureBrowser.crx.exec('tabs.captureVisibleTab')
      expect(result).to.be.a('string')
      expect(result.startsWith('data:image/jpeg;base64,')).to.equal(true)
    })

    it('returns a PNG data URL when asked', async () => {
      const result = await captureBrowser.crx.exec('tabs.captureVisibleTab', { format: 'png' })
      expect(result).to.be.a('string')
      expect(result.startsWith('data:image/png;base64,')).to.equal(true)
    })

    // Chrome refuses a quality outside 0 to 100 rather than clamping it.
    it('refuses a JPEG quality out of range', async () => {
      const highQuality = await captureBrowser.crx.exec('tabs.captureVisibleTab', {
        format: 'jpeg',
        quality: 999,
      })
      const inRange = await captureBrowser.crx.exec('tabs.captureVisibleTab', {
        format: 'jpeg',
        quality: 50,
      })
      expect(highQuality == null).to.equal(true)
      expect(inRange).to.be.a('string')
      expect(inRange.startsWith('data:image/jpeg;base64,')).to.equal(true)
    })

    it('returns undefined when there is no active tracked tab', async () => {
      captureBrowser.extensions.removeTab(captureBrowser.window.webContents)
      const result = await captureBrowser.crx.exec('tabs.captureVisibleTab')
      expect(result == null).to.equal(true)
    })
  })

  describe('onCreated', () => {
    it('emits when tab is added', async () => {
      const p = browser.crx.eventOnce('tabs.onCreated')

      const secondWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      const secondTab = secondWindow.webContents

      const url = `${server.getUrl()}foo`
      await secondWindow.loadURL(url)

      browser.extensions.addTab(secondTab, secondWindow)

      const [tabDetails] = await p
      expect(tabDetails).to.be.an('object')
      expect(tabDetails.id).to.equal(secondTab.id)
      expect(tabDetails.windowId).to.equal(secondWindow.id)
      expect(tabDetails.url).to.equal(secondTab.getURL())
    })
  })

  describe('onUpdated', () => {
    it('emits on "tab-updated" event', async () => {
      const p = browser.crx.eventOnce('tabs.onUpdated')

      // Wait for tabs.onUpdated listener to be set
      await new Promise((resolve) => setTimeout(resolve, 10))

      assignTabDetails = (details) => {
        details.discarded = true
      }

      browser.webContents.emit('tab-updated')

      const [_tabId, changeInfo, _tabDetails] = await p
      expect(changeInfo).to.be.an('object')
      expect(Object.keys(changeInfo)).to.have.lengthOf(1)
      expect(changeInfo).to.haveOwnProperty('discarded')
      expect(changeInfo.discarded).to.equal(true)
    })
  })
})
