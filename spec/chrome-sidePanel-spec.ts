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
    expect(defaults.enabled).to.equal(true)
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
  })

  it('rejects open when the panel is disabled for the tab', async () => {
    const tabId = browser.webContents.id
    await browser.crx.exec('sidePanel.setOptions', { tabId, enabled: false })

    const resolved = browser.extensions.api.sidePanel.getResolvedOptions(
      browser.extension.id,
      tabId,
    )
    expect(resolved.enabled).to.equal(false)

    const result = await browser.crx.exec('sidePanel.open', { tabId })
    expect(result).to.be.an('object')
    expect(result.__error).to.match(/disabled/i)
    expect(opens).to.have.lengthOf(0)
  })

  it('rejects invalid panel paths', async () => {
    const result = await browser.crx.exec('sidePanel.setOptions', {
      path: 'missing-panel.html',
    })
    expect(result).to.be.an('object')
    expect(result.__error).to.match(/Invalid side panel path/i)
  })
})
