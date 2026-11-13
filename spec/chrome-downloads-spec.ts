import { expect } from 'chai'
import { app } from 'electron'
import * as fs from 'node:fs'
import * as http from 'http'
import * as os from 'node:os'
import * as path from 'node:path'
import { AddressInfo } from 'net'

import { useExtensionBrowser } from './hooks'

describe('chrome.downloads', () => {
  let server: http.Server
  let downloadUrl = ''
  let downloads = ''
  let previousDownloads = ''

  before(async () => {
    // Downloads land in a folder of the test's own, never the person's.
    previousDownloads = app.getPath('downloads')
    downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-downloads-'))
    app.setPath('downloads', downloads)
    server = http.createServer((req, res) => {
      if (req.url === '/file.txt') {
        const payload = 'downloads-test-file'
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(payload),
          'Content-Disposition': 'attachment; filename="file.txt"',
        })
        res.end(payload)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        downloadUrl = `http://127.0.0.1:${port}/file.txt`
        resolve()
      }),
    )
  })

  after(() => {
    server.close()
    app.setPath('downloads', previousDownloads)
    fs.rmSync(downloads, { recursive: true, force: true })
  })

  const browser = useExtensionBrowser({
    extensionName: 'chrome-downloads',
    url: () => 'https://example.com',
  })

  it('creates a download request', async () => {
    const id = await browser.crx.exec('downloads.download', { url: downloadUrl })
    expect(id).to.be.a('number')
  })

  it('search returns created download metadata', async () => {
    await browser.crx.exec('downloads.download', { url: downloadUrl })
    await new Promise<void>((resolve) => setTimeout(resolve, 75))
    const results = await browser.crx.exec('downloads.search', {})
    expect(results).to.be.an('array')
    expect(results.length).to.be.greaterThan(0)
    const hit = results.find((item: any) => item.url === downloadUrl)
    expect(hit).to.be.an('object')
  })

  it('erase removes stored download entries and emits onErased', async () => {
    const id = await browser.crx.exec('downloads.download', { url: downloadUrl })
    await new Promise<void>((resolve) => setTimeout(resolve, 75))

    const erasedEvent = browser.crx.eventOnce('downloads.onErased')
    const erased = await browser.crx.exec('downloads.erase', { id })
    const [erasedId] = await erasedEvent

    expect(erased).to.be.an('array')
    expect(erased).to.include(id)
    expect(erasedId).to.equal(id)
  })

  it('returns explicit errors for unsupported methods', async () => {
    const getFileIconResult = await browser.crx.exec('downloads.getFileIcon', 1)
    expect(getFileIconResult).to.equal(null)
  })
})
