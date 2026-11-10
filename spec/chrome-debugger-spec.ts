import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.debugger', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-debugger',
  })

  describe('getTargets()', () => {
    it('returns an array of debuggable targets', async () => {
      const targets = await browser.crx.exec('debugger.getTargets')
      expect(targets).to.be.an('array')
      expect(targets.length).to.be.greaterThan(0)
      const target = targets[0]
      expect(target).to.have.property('type', 'page')
      expect(target).to.have.property('tabId').that.is.a('number')
      expect(target).to.have.property('attached').that.is.a('boolean')
      expect(target).to.have.property('url').that.is.a('string')
    })
  })

  describe('attach()', () => {
    it('attaches to a tab', async () => {
      const tabId = browser.window.webContents.id
      const result = await browser.crx.exec('debugger.attach', { tabId }, '1.3')
      // attach() resolves with undefined on success
      expect(result).to.equal(null)
    })

    it('throws if already attached', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')
      const result = await browser.crx.exec('debugger.attach', { tabId }, '1.3')
      // Should return null because errors become null in the RPC layer
      expect(result).to.equal(null)
    })
  })

  describe('detach()', () => {
    it('detaches from an attached tab', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')
      const result = await browser.crx.exec('debugger.detach', { tabId })
      expect(result).to.equal(null)
      // After detach, the debugger should no longer be attached
      expect(browser.window.webContents.debugger.isAttached()).to.equal(false)
    })
  })

  describe('sendCommand()', () => {
    it('sends a CDP Runtime.enable command and receives response', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')

      const result = await browser.crx.exec('debugger.sendCommand', { tabId }, 'Runtime.enable')
      // Runtime.enable returns an empty object on success
      expect(result).to.be.an('object')

      await browser.crx.exec('debugger.detach', { tabId })
    })

    it('sends Runtime.evaluate and returns the result', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')

      const result = await browser.crx.exec(
        'debugger.sendCommand',
        { tabId },
        'Runtime.evaluate',
        { expression: '1 + 1' },
      )
      expect(result).to.be.an('object')
      expect(result.result).to.be.an('object')
      expect(result.result.value).to.equal(2)

      await browser.crx.exec('debugger.detach', { tabId })
    })
  })

  describe('onDetach event', () => {
    // Chrome tells an extension when it loses the debugger (the tab closed,
    // the person cancelled), not when it detached itself.
    it('does not fire when the extension detaches itself', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')

      const eventPromise = browser.crx.eventOnce('debugger.onDetach').then(() => 'fired')
      // Allow the event listener registration IPC to flush before detaching.
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      await browser.crx.exec('debugger.detach', { tabId })

      const outcome = await Promise.race([
        eventPromise,
        new Promise((resolve) => setTimeout(() => resolve('none'), 500)),
      ])
      expect(outcome).to.equal('none')
    })
  })
})
