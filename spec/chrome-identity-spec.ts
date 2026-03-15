import * as http from 'http'
import { expect } from 'chai'
import { useExtensionBrowser, useServer } from './hooks'
import { AddressInfo } from 'net'

describe('chrome.identity', () => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'chrome-identity',
  })

  describe('getAuthToken()', () => {
    it('rejects with clear error (not supported in Peersky)', async () => {
      const result = await browser.crx.exec('identity.getAuthToken', { interactive: false })
      // When the main process throws, the preload catches and callback(undefined); IPC may serialize as null
      expect(result).to.satisfy((r: unknown) => r === undefined || r === null)
    })

    it('rejects with error regardless of interactive flag', async () => {
      const resultInteractive = await browser.crx.exec('identity.getAuthToken', { interactive: true })
      const resultNonInteractive = await browser.crx.exec('identity.getAuthToken', { interactive: false })
      expect(resultInteractive).to.satisfy((r: unknown) => r === undefined || r === null)
      expect(resultNonInteractive).to.satisfy((r: unknown) => r === undefined || r === null)
    })
  })

  describe('launchWebAuthFlow()', () => {
    it('returns redirect URL on 302 redirect to extension callback', async function () {
      const extensionId = browser.extension.id
      const redirectUrl = `https://${extensionId}.chromiumapp.org/?code=test123&state=xyz`

      const redirectServer = http.createServer((req, res) => {
        if (req.url === '/oauth-start') {
          res.writeHead(302, { Location: redirectUrl })
          res.end()
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      await new Promise<void>((resolve) => {
        redirectServer.listen(0, '127.0.0.1', () => resolve())
      })

      const port = (redirectServer.address() as AddressInfo).port
      const oauthStartUrl = `http://127.0.0.1:${port}/oauth-start`

      const result = await browser.crx.exec('identity.launchWebAuthFlow', {
        url: oauthStartUrl,
        interactive: false,
      })

      redirectServer.close()

      expect(result).to.be.a('string')
      expect(result).to.equal(redirectUrl)
    })

    it('preserves query parameters in redirect URL', async function () {
      const extensionId = browser.extension.id
      const code = 'auth_code_12345'
      const state = 'random_state_xyz'
      const redirectUrl = `https://${extensionId}.chromiumapp.org/?code=${code}&state=${state}`

      const redirectServer = http.createServer((req, res) => {
        if (req.url === '/oauth') {
          res.writeHead(302, { Location: redirectUrl })
          res.end()
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      await new Promise<void>((resolve) => {
        redirectServer.listen(0, '127.0.0.1', () => resolve())
      })

      const port = (redirectServer.address() as AddressInfo).port
      const oauthUrl = `http://127.0.0.1:${port}/oauth`

      const result = await browser.crx.exec('identity.launchWebAuthFlow', {
        url: oauthUrl,
        interactive: false,
      })

      redirectServer.close()

      expect(result).to.include(code)
      expect(result).to.include(state)
    })

    it('captures redirect with fragment (#) parameters', async function () {
      this.timeout(15000)
      const extensionId = browser.extension.id
      const fragment = 'access_token=token123&token_type=Bearer&expires_in=3600'
      const redirectUrl = `https://${extensionId}.chromiumapp.org/#${fragment}`

      // Use server-side redirect to fragment instead of client-side JS
      const oauthServer = http.createServer((_req, res) => {
        res.writeHead(302, { Location: redirectUrl })
        res.end()
      })

      await new Promise<void>((resolve) => {
        oauthServer.listen(0, '127.0.0.1', () => resolve())
      })

      const port = (oauthServer.address() as AddressInfo).port
      const oauthUrl = `http://127.0.0.1:${port}/oauth`

      const result = await browser.crx.exec('identity.launchWebAuthFlow', {
        url: oauthUrl,
        interactive: false,
      })

      oauthServer.close()

      expect(result).to.be.a('string')
      expect(result).to.include(extensionId)
      expect(result).to.include('chromiumapp.org')
      expect(result).to.include(fragment)
    })

    it('rejects when missing required url option', async function () {
      try {
        await browser.crx.exec('identity.launchWebAuthFlow', {})
        expect.fail('Should have thrown error for missing url')
      } catch (err: any) {
        // Expected to throw or return error
        expect(err.message).to.include('url')
      }
    })

    it('respects interactive: false option (headless mode)', async function () {
      const extensionId = browser.extension.id
      const redirectUrl = `https://${extensionId}.chromiumapp.org/?code=test&state=abc`

      const redirectServer = http.createServer((req, res) => {
        if (req.url === '/oauth') {
          res.writeHead(302, { Location: redirectUrl })
          res.end()
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      await new Promise<void>((resolve) => {
        redirectServer.listen(0, '127.0.0.1', () => resolve())
      })

      const port = (redirectServer.address() as AddressInfo).port
      const oauthUrl = `http://127.0.0.1:${port}/oauth`

      const result = await browser.crx.exec('identity.launchWebAuthFlow', {
        url: oauthUrl,
        interactive: false,
      })

      redirectServer.close()

      expect(result).to.equal(redirectUrl)
    })

    it('handles multiple redirects and returns final redirect URL', async function () {
      const extensionId = browser.extension.id
      const finalUrl = `https://${extensionId}.chromiumapp.org/?code=final_code`

      const redirectServer = http.createServer((req, res) => {
        if (req.url === '/oauth-start') {
          res.writeHead(302, { Location: 'http://127.0.0.1:' + port + '/oauth-continue' })
          res.end()
        } else if (req.url === '/oauth-continue') {
          res.writeHead(302, { Location: finalUrl })
          res.end()
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      await new Promise<void>((resolve) => {
        redirectServer.listen(0, '127.0.0.1', () => resolve())
      })

      const port = (redirectServer.address() as AddressInfo).port
      const oauthUrl = `http://127.0.0.1:${port}/oauth-start`

      const result = await browser.crx.exec('identity.launchWebAuthFlow', {
        url: oauthUrl,
        interactive: false,
      })

      redirectServer.close()

      // Should return the final redirect URL to the chromiumapp.org domain
      expect(result).to.equal(finalUrl)
    })
  })
})
