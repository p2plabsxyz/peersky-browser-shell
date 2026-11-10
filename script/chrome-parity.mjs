#!/usr/bin/env node
// Runs the chrome-api-probe extensions in real Chrome and records what every
// chrome.* call did, into spec/fixtures/chrome-api-probe/chrome-results.json.
// The parity spec runs the same extensions in the shell and compares.
//
//   CHROME=/path/to/chrome node script/chrome-parity.mjs
//
// Use Chrome for Testing or Chromium: branded Chrome no longer loads unpacked
// extensions from the command line. Chrome runs headless with a new profile in
// a temporary folder and the mock keychain, and downloads go to that folder.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startProbeServer } = require(path.join(root, 'spec', 'probe-server.js'))
const { normalizeResults } = require(path.join(root, 'spec', 'probe-compare.js'))

const PROBE_ID = 'agiecahclpmfdifoehacoelbdlhkclph'
const PEER_ID = 'hkcielgkpfgoamfdbknpndcmhjjgljab'
const fixtures = path.join(root, 'spec', 'fixtures')
const outFile = process.argv[2] || path.join(fixtures, 'chrome-api-probe', 'chrome-results.json')

const chromePath = process.env.CHROME
if (!chromePath || !existsSync(chromePath)) {
  console.error('Set CHROME to a Chrome for Testing or Chromium binary.')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const evaluate = async (sessionId, expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }
  return { send, evaluate, version: ver.Browser, close: () => ws.close() }
}

async function attachWorker(cdp, extensionId) {
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets')
    const worker = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/sw.js`,
    )
    if (worker) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
      for (let j = 0; j < 50; j++) {
        if ((await cdp.evaluate(sessionId, 'typeof runSuite')) === 'function') return sessionId
        await sleep(100)
      }
    }
    await sleep(100)
  }
  throw new Error(`no service worker for ${extensionId}`)
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  for (let i = 0; i < 50; i++) {
    if ((await cdp.evaluate(sessionId, 'typeof pageSurface')) === 'function') break
    await sleep(100)
  }
  return { targetId, sessionId }
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), 'chrome-parity-'))
  const profile = path.join(work, 'profile')
  const downloads = path.join(work, 'downloads')
  mkdirSync(path.join(profile, 'Default'), { recursive: true })
  mkdirSync(downloads)
  writeFileSync(
    path.join(profile, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  )

  const server = await startProbeServer(Number(process.env.PROBE_PORT) || 0)
  const env = { base: server.base, other: server.other }
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--use-mock-keychain',
      '--password-store=basic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--remote-debugging-port=0',
      `--load-extension=${path.join(fixtures, 'chrome-api-probe')},${path.join(fixtures, 'chrome-api-probe-peer')}`,
      `${env.base}page?start`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  chrome.stderr.on('data', (d) => (stderr += d))

  let port
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100)
    try {
      port = Number(readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
    } catch {}
  }
  if (!port) throw new Error('Chrome did not open a DevTools port\n' + stderr.slice(-2000))

  const cdp = await connect(port)
  const out = { browser: cdp.version, probe: {}, peer: {}, pages: {} }
  try {
    const probeSw = await attachWorker(cdp, PROBE_ID)
    const peerSw = await attachWorker(cdp, PEER_ID)
    await sleep(500)
    const run = async (sessionId, suite) => {
      process.stdout.write(`  ${suite}\n`)
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ '!suite-error': 'suite timed out' }), 120000)
      })
      try {
        return await Promise.race([
          cdp.evaluate(sessionId, `runSuite(${JSON.stringify(suite)}, ${JSON.stringify(env)})`),
          timeout,
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    const probeSuites = await cdp.evaluate(probeSw, 'suiteNames()')
    const peerSuites = await cdp.evaluate(peerSw, 'suiteNames()')
    console.log('probe')
    for (const suite of probeSuites) {
      if (suite === 'management.toggle') continue
      out.probe[suite] = await run(probeSw, suite)
    }
    console.log('peer')
    for (const suite of peerSuites) out.peer[suite] = await run(peerSw, suite)
    console.log('pages')
    for (const [name, id] of [['probe', PROBE_ID], ['peer', PEER_ID]]) {
      const page = await openPage(cdp, `chrome-extension://${id}/page.html`)
      out.pages[name] = await cdp.evaluate(page.sessionId, 'pageSurface()')
      await cdp.send('Target.closeTarget', { targetId: page.targetId })
    }
    if (probeSuites.includes('management.toggle')) {
      out.probe['management.toggle'] = await run(probeSw, 'management.toggle')
    }
  } finally {
    cdp.close()
    chrome.kill()
    await server.close()
    await sleep(500)
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(outFile, JSON.stringify(normalizeResults(out, env), null, 2) + '\n')
  console.log(`wrote ${path.relative(process.cwd(), outFile)} (${out.browser})`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
