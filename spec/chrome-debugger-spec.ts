import { expect } from 'chai'
import { ipcMain } from 'electron'
import * as http from 'node:http'
import { AddressInfo } from 'node:net'
import * as path from 'node:path'
import { emittedOnce } from './events-helpers'
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

  // A call's result and runtime.lastError; crx.exec turns a failure into null.
  const call = async (method: string, ...args: any[]) => {
    const p = emittedOnce(ipcMain, 'success')
    const rpc = JSON.stringify({ type: 'api-detail', method, args }).replace(/'/g, "\\'")
    await browser.window.webContents.executeJavaScript(`exec('${rpc}')`)
    const [, outcome] = await p
    return outcome as { result: any; error: string | null }
  }

  // Electron's own debugger client could reach every target, the file system
  // and any origin's data, so a command is held to what Chrome allows an
  // extension: the page, its own frames and workers, and its own origin.
  describe('what an extension may reach', () => {
    it('refuses DevTools commands that reach past the page, as Chrome does', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')
      const refused: Array<[string, object]> = [
        ['Target.getTargets', {}],
        ['Target.attachToTarget', { targetId: 'ABC', flatten: true }],
        ['Target.createTarget', { url: 'about:blank' }],
        ['Target.setDiscoverTargets', { discover: true }],
        ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false }],
        ['Browser.getVersion', {}],
        ['SystemInfo.getInfo', {}],
        ['ServiceWorker.enable', {}],
        ['Tracing.start', {}],
        ['Network.getAllCookies', {}],
        ['Network.loadNetworkResource', { url: 'file:///etc/hosts', options: { disableCache: true, includeCredentials: false } }],
        ['Storage.getCookies', {}],
        ['Storage.clearDataForOrigin', { origin: 'chrome-extension://agiecahclpmfdifoehacoelbdlhkclph', storageTypes: 'all' }],
        ['Storage.clearDataForOrigin', { origin: 'https://other.example', storageTypes: 'all' }],
        ['CacheStorage.requestCacheNames', { securityOrigin: 'https://other.example' }],
        ['DOM.setFileInputFiles', { files: ['/etc/hosts'], nodeId: 1 }],
        ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
      ]
      for (const [method, params] of refused) {
        const { error } = await call('debugger.sendCommand', { tabId }, method, params)
        expect(error, method).to.be.a('string')
      }

      // What is the page's own still works.
      const origin = new URL(server.getUrl()).origin
      expect((await call('debugger.sendCommand', { tabId }, 'Storage.getUsageAndQuota', { origin })).error).to.equal(null)
      const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
      expect((await call('debugger.sendCommand', { tabId }, 'Target.setAutoAttach', autoAttach)).error).to.equal(null)
      const sum = await call('debugger.sendCommand', { tabId }, 'Runtime.evaluate', { expression: '1 + 1' })
      expect(sum.result.result.value).to.equal(2)
      await browser.crx.exec('debugger.detach', { tabId })
    })

    it('refuses a session it did not hand out', async () => {
      const tabId = browser.window.webContents.id
      await browser.crx.exec('debugger.attach', { tabId }, '1.3')
      const { error } = await call('debugger.sendCommand', { tabId, sessionId: 'not-a-session' }, 'Runtime.evaluate', {
        expression: '1',
      })
      expect(error).to.include('Session with given id not found.')
      await browser.crx.exec('debugger.detach', { tabId })
    })

    it("detaches when a redirect takes the tab to another extension's page", async () => {
      const other = await browser.session.extensions.loadExtension(path.join(__dirname, 'fixtures', 'web-accessible-page'))
      const redirect = http.createServer((_req, res) => {
        res.writeHead(302, { Location: `chrome-extension://${other.id}/page.html` })
        res.end()
      })
      await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', () => resolve()))
      try {
        const tabId = browser.window.webContents.id
        await browser.crx.exec('debugger.attach', { tabId }, '1.3')
        expect(browser.window.webContents.debugger.isAttached()).to.equal(true)
        const port = (redirect.address() as AddressInfo).port
        await browser.window.webContents.loadURL(`http://127.0.0.1:${port}/`).catch(() => {})
        // The redirect went through: the page is the other extension's now.
        expect(browser.window.webContents.getURL()).to.equal(`chrome-extension://${other.id}/page.html`)
        expect(browser.window.webContents.debugger.isAttached()).to.equal(false)
      } finally {
        redirect.close()
        browser.session.extensions.removeExtension(other.id)
      }
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
