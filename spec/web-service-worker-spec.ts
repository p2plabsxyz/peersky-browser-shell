import { expect } from 'chai'
import * as http from 'node:http'
import { AddressInfo } from 'node:net'
import { useExtensionBrowser } from './hooks'

// The session gives the extensions preload to every service worker, websites'
// too. A website's worker must start as it does without the library: it used
// to wait forever on the context call extension workers start with, so no
// site in the session had offline pages, push or a PWA.
describe('a website service worker', () => {
  let server: http.Server
  let url = ''
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.end("self.addEventListener('install', () => self.skipWaiting())")
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>service worker</title>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  after(() => server.close())

  const browser = useExtensionBrowser({ url: () => url, extensionName: 'web-accessible-page' })

  it('starts, with no chrome.* or electron bridge in it', async () => {
    const outcome = await browser.window.webContents.executeJavaScript(`(async () => {
      const registration = await navigator.serviceWorker.register('/sw.js')
      const ready = navigator.serviceWorker.ready.then((r) => r.active ? r.active.state : 'none')
      const late = new Promise((resolve) => setTimeout(() => resolve('timed out'), 8000))
      const state = await Promise.race([ready, late])
      await registration.unregister()
      return state
    })()`)
    expect(outcome).to.be.oneOf(['activating', 'activated'])
  })
})
