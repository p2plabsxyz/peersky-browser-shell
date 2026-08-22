import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.sidePanel', () => {
  const server = useServer()
  const opens: any[] = []
  const closes: any[] = []

  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-sidePanel',
    openSidePanel: async (details) => {
      opens.push(details)
    },
    closeSidePanel: async (details) => {
      closes.push(details)
    },
  })

  const sidePanelApi = () => browser.extensions.api.sidePanel as any
  const asEvent = () => ({ extension: browser.extension })
  const noteUserGesture = () =>
    (browser.extensions as any).ctx.store.noteUserGesture(browser.extension.id)

  beforeEach(() => {
    opens.length = 0
    closes.length = 0
  })

  it('seeds default_path from the manifest', async () => {
    const options = await browser.crx.exec('sidePanel.getOptions', {})
    expect(options).to.be.an('object')
    expect(options.path).to.equal('sidepanel.html')
    expect(options.enabled).to.equal(true)
  })

  it('setOptions and getOptions round-trip path and enabled', async () => {
    await browser.crx.exec('sidePanel.setOptions', {
      path: 'sidepanel.html',
      enabled: true,
    })
    const options = await browser.crx.exec('sidePanel.getOptions', {})
    expect(options.path).to.equal('sidepanel.html')
    expect(options.enabled).to.equal(true)
  })

  it('stores per-tab options separately from defaults', async () => {
    const tabId = browser.webContents.id
    await browser.crx.exec('sidePanel.setOptions', {
      path: 'sidepanel.html',
      enabled: true,
    })
    await browser.crx.exec('sidePanel.setOptions', {
      tabId,
      enabled: false,
    })

    const forTab = await browser.crx.exec('sidePanel.getOptions', { tabId })
    const defaults = await browser.crx.exec('sidePanel.getOptions', {})

    expect(forTab.enabled).to.equal(false)
    expect(forTab.tabId).to.equal(tabId)
    expect(defaults.enabled).to.equal(true)
    expect(defaults.tabId).to.equal(undefined)
  })

  it('getOptions echoes the queried tabId when only global options exist', async () => {
    const tabId = browser.webContents.id
    await browser.crx.exec('sidePanel.setOptions', {
      path: 'sidepanel.html',
      enabled: true,
    })

    const forTab = await browser.crx.exec('sidePanel.getOptions', { tabId })
    expect(forTab.path).to.equal('sidepanel.html')
    expect(forTab.enabled).to.equal(true)
    expect(forTab.tabId).to.equal(tabId)
  })

  it('setPanelBehavior and getPanelBehavior round-trip', async () => {
    await browser.crx.exec('sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
    const behavior = await browser.crx.exec('sidePanel.getPanelBehavior')
    expect(behavior).to.deep.equal({ openPanelOnActionClick: true })
  })

  it('getLayout returns the host side', async () => {
    const layout = await browser.crx.exec('sidePanel.getLayout')
    expect(layout).to.deep.equal({ side: 'right' })
  })

  it('open delegates to the host with a resolved path', async () => {
    const tabId = browser.webContents.id
    noteUserGesture()
    await browser.crx.exec('sidePanel.open', { tabId })

    expect(opens).to.have.lengthOf(1)
    expect(opens[0].extension.id).to.equal(browser.extension.id)
    expect(opens[0].path).to.equal('sidepanel.html')
    expect(opens[0].tabId).to.equal(tabId)
    expect(opens[0].windowId).to.equal(browser.window.id)
  })

  it('close delegates to the host', async () => {
    const tabId = browser.webContents.id
    await browser.crx.exec('sidePanel.close', { tabId })

    expect(closes).to.have.lengthOf(1)
    expect(closes[0].extension.id).to.equal(browser.extension.id)
    expect(closes[0].tabId).to.equal(tabId)
    expect(closes[0].windowId).to.equal(browser.window.id)
  })

  it('rejects close for a missing tab', async () => {
    // Exercise the handler directly: router still swallows throws until a
    // dedicated error-propagation PR lands.
    let message = ''
    try {
      await sidePanelApi().close(asEvent(), { tabId: 999999 })
    } catch (err: any) {
      message = String(err?.message || err)
    }
    expect(message).to.match(/No tab with id/i)
    expect(closes).to.have.lengthOf(0)
  })

  it('rejects open when tabId and windowId disagree or the window mapping is gone', async () => {
    const tabId = browser.webContents.id
    noteUserGesture()
    let message = ''
    try {
      await sidePanelApi().open(asEvent(), { tabId, windowId: 999999 })
    } catch (err: any) {
      message = String(err?.message || err)
    }
    expect(message).to.match(/tabId does not belong to windowId/i)
    expect(opens).to.have.lengthOf(0)
  })

  it('rejects open without a user gesture', async () => {
    const tabId = browser.webContents.id
    let message = ''
    try {
      await sidePanelApi().open(asEvent(), { tabId })
    } catch (err: any) {
      message = String(err?.message || err)
    }
    expect(message).to.match(/user gesture/i)
    expect(opens).to.have.lengthOf(0)
  })

  it('rejects open when the panel is disabled for the tab', async () => {
    const tabId = browser.webContents.id
    await browser.crx.exec('sidePanel.setOptions', { tabId, enabled: false })

    const resolved = browser.extensions.api.sidePanel.getResolvedOptions(
      browser.extension.id,
      tabId,
    )
    expect(resolved.enabled).to.equal(false)

    noteUserGesture()
    let message = ''
    try {
      await sidePanelApi().open(asEvent(), { tabId })
    } catch (err: any) {
      message = String(err?.message || err)
    }
    expect(message).to.match(/disabled/i)
    expect(opens).to.have.lengthOf(0)
  })

  it('rejects invalid panel paths', async () => {
    let message = ''
    try {
      await sidePanelApi().setOptions(asEvent(), { path: 'missing-panel.html' })
    } catch (err: any) {
      message = String(err?.message || err)
    }
    expect(message).to.match(/Invalid side panel path/i)
  })
})
