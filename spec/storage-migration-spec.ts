import { expect } from 'chai'
import { app, BrowserWindow, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { ElectronChromeExtensions } from '../'
import { writeStorageFile } from '../src/browser/api/storage-file'
import { addCrxPreload, createCrxSession, getExtensionId } from './crx-helpers'
import { useServer } from './hooks'

// Someone on 1.x updates: what an extension kept in chrome.storage.local must
// be there in 2.0, for its pages and, as in Chrome, for its content scripts.
describe('chrome.storage.local after updating from 1.x', () => {
  const server = useServer()
  const fixture = path.join(__dirname, 'fixtures', 'storage-migration')
  let legacyFile: string
  const windows: BrowserWindow[] = []

  after(() => {
    for (const w of windows) if (!w.isDestroyed()) w.destroy()
  })

  it('moves the old data into the store every context shares, once', async function () {
    this.timeout(30_000)
    const id = await getExtensionId('storage-migration')
    // 1.x kept it here, encrypted with safeStorage.
    legacyFile = path.join(app.getPath('userData'), 'extension-local', `${id}.json`)
    await fs.mkdir(path.dirname(legacyFile), { recursive: true })
    await writeStorageFile(legacyFile, { theme: 'dark', count: 3 }, safeStorage)

    const { session } = createCrxSession()
    addCrxPreload(session)
    new ElectronChromeExtensions({ license: 'internal-license-do-not-use' as any, session })
    await (session.extensions || session).loadExtension(fixture)

    const page = new BrowserWindow({ show: false, webPreferences: { session } })
    windows.push(page)
    await page.loadURL(`chrome-extension://${id}/page.html`)
    const read = () => page.webContents.executeJavaScript('chrome.storage.local.get(null)')
    expect(await read()).to.deep.equal({ theme: 'dark', count: 3 })

    // The old file goes once the data is in the new store.
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      gone = await fs.access(legacyFile).then(() => false, () => true)
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(gone).to.equal(true)

    // A content script sees the same data, and its writes reach the page.
    const tab = new BrowserWindow({ show: false, webPreferences: { session } })
    windows.push(tab)
    await tab.loadURL(server.getUrl())
    let seen: any
    for (let i = 0; i < 50 && !seen; i++) {
      seen = await tab.webContents.executeJavaScript('document.documentElement.dataset.storage || null')
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(JSON.parse(seen)).to.deep.equal({ theme: 'dark', count: 3 })
    let fromContent: any
    for (let i = 0; i < 50 && !fromContent; i++) {
      fromContent = (await read()).fromContent
      if (!fromContent) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(fromContent).to.equal('written by the content script')

    // A second page, after the move, reads straight from the same store.
    const again = new BrowserWindow({ show: false, webPreferences: { session } })
    windows.push(again)
    await again.loadURL(`chrome-extension://${id}/page.html`)
    expect(await again.webContents.executeJavaScript('chrome.storage.local.get("theme")')).to.deep.equal({ theme: 'dark' })
  })
})
