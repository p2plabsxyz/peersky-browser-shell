import { expect } from 'chai'
import { app, BaseWindow, BrowserWindow, session } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ElectronChromeExtensions } from '../'
import { ProbeBrowser } from './probe-browser'
import { uuid } from './spec-helpers'

// The same two extensions, run in Chrome by script/chrome-parity.mjs, recorded
// what every chrome.* call did there. Here they run in the shell, and every
// answer has to match Chrome's, apart from the differences listed with a
// reason in known-differences.json.
const { startProbeServer } = require('./probe-server')
const { normalizeResults, diffResults } = require('./probe-compare')

const PROBE_ID = 'agiecahclpmfdifoehacoelbdlhkclph'
const PEER_ID = 'hkcielgkpfgoamfdbknpndcmhjjgljab'
const fixtures = path.join(__dirname, 'fixtures')
const probeDir = path.join(fixtures, 'chrome-api-probe')
const chrome = JSON.parse(fs.readFileSync(path.join(probeDir, 'chrome-results.json'), 'utf8'))
const known: { path: string; reason: string }[] = JSON.parse(
  fs.readFileSync(path.join(probeDir, 'known-differences.json'), 'utf8'),
).differences

describe('chrome.* APIs match Chrome', function () {
  this.timeout(180_000)

  let server: { base: string; other: string; close(): Promise<void> }
  let browser: ProbeBrowser
  let ses: Electron.Session
  let probePage: BrowserWindow
  let peerPage: BrowserWindow
  let downloads: string
  const shell: any = { probe: {}, peer: {}, pages: {} }

  const openExtensionPage = async (id: string) => {
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses } })
    await win.loadURL(`chrome-extension://${id}/page.html`)
    return win
  }

  const run = async (page: BrowserWindow, suite: string) => {
    const env = { base: server.base, other: server.other }
    const result = await page.webContents.executeJavaScript(
      `runInWorker(${JSON.stringify(suite)}, ${JSON.stringify(env)})`,
    )
    return normalizeResults(result, env)
  }

  const compare = (side: 'probe' | 'peer' | 'pages', suite: string, actual: any) => {
    shell[side][suite] = actual
    // Written after every suite, so a crash still leaves what ran before it.
    if (process.env.PROBE_RESULTS_OUT) {
      fs.writeFileSync(process.env.PROBE_RESULTS_OUT, JSON.stringify(shell, null, 2) + '\n')
    }
    const diff = diffResults({ [side]: { [suite]: chrome[side][suite] } }, { [side]: { [suite]: actual } }, known)
    expect(diff, `differences from Chrome in ${side}.${suite}`).to.deep.equal([])
  }

  before(async () => {
    downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-downloads-'))
    app.setPath('downloads', downloads)
    server = await startProbeServer()
    ses = session.fromPartition(`persist:probe-${uuid()}`)
    browser = new ProbeBrowser(ses)
    browser.extensions = new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: ses,
      ...browser.impl,
    })
    browser.forwardWebRequests()
    const sessionExtensions = ses.extensions || ses
    await sessionExtensions.loadExtension(probeDir)
    await sessionExtensions.loadExtension(path.join(fixtures, 'chrome-api-probe-peer'))
    browser.openWindow(`${server.base}page?start`)
    probePage = await openExtensionPage(PROBE_ID)
    peerPage = await openExtensionPage(PEER_ID)
  })

  after(async () => {
    probePage?.destroy()
    peerPage?.destroy()
    browser?.closeAll()
    await server?.close()
    fs.rmSync(downloads, { recursive: true, force: true })
  })

  // PROBE_SUITES=tabs,windows runs only those, while working on them.
  const only = process.env.PROBE_SUITES ? process.env.PROBE_SUITES.split(',') : null
  const wanted = (suite: string) => !only || only.includes(suite)
  const probeSuites = Object.keys(chrome.probe).filter((s) => s !== 'management.toggle' && wanted(s))
  for (const suite of probeSuites) {
    it(`probe: ${suite}`, async () => {
      compare('probe', suite, await run(probePage, suite))
    })
  }

  for (const suite of Object.keys(chrome.peer).filter((s) => !only || only.includes('peer.' + s))) {
    it(`peer: ${suite}`, async () => {
      compare('peer', suite, await run(peerPage, suite))
    })
  }

  it('pages: the probe page sees the same APIs', async () => {
    compare('pages', 'probe', await probePage.webContents.executeJavaScript('pageSurface()'))
  })

  it('pages: the peer page sees the same APIs', async () => {
    compare('pages', 'peer', await peerPage.webContents.executeJavaScript('pageSurface()'))
  })

  it('an offscreen document is no window, so it never keeps the app from quitting', async () => {
    const windowsBefore = BaseWindow.getAllWindows().length
    await probePage.webContents.executeJavaScript(
      `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'test' })`,
    )
    expect(await probePage.webContents.executeJavaScript('chrome.offscreen.hasDocument()')).to.equal(true)
    expect(BaseWindow.getAllWindows().length).to.equal(windowsBefore)
    await probePage.webContents.executeJavaScript('chrome.offscreen.closeDocument()')
  })

  it('probe: management.toggle', async () => {
    compare('probe', 'management.toggle', await run(probePage, 'management.toggle'))
  })
})
