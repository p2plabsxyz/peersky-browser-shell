/* global chrome, probe */
// What an extension without permissions sees. Chrome hides each API behind its
// permission and hides tab urls without "tabs" or host access.
const SUITES = []
const suite = (name, fn) => SUITES.push([name, fn])

self.suiteNames = () => SUITES.map(([name]) => name)
self.runSuite = async (name, env) => {
  const entry = SUITES.find(([n]) => n === name)
  const t = probe.createRecorder()
  if (!entry) return { '!missing-suite': name }
  try {
    await entry[1](t, env || {})
  } catch (e) {
    t.set('!suite-error', probe.errorMessage(e))
  }
  return t.results
}

const PROBE_ID = 'agiecahclpmfdifoehacoelbdlhkclph'

suite('surface', async (t) => {
  t.set('chrome', probe.apiSurface(chrome))
})

suite('messaging', async (t) => {
  await t.call('sendMessage.probe', () => chrome.runtime.sendMessage(PROBE_ID, { ping: true }))
  const port = chrome.runtime.connect(PROBE_ID, { name: 'peer-port' })
  await t.event('connect.echo', port.onMessage, () => port.postMessage({ from: 'peer' }), { map: (m) => m })
  port.disconnect()
})

suite('tabs.fields', async (t, env) => {
  await t.call('query', () => chrome.tabs.query({}), (tabs) => {
    const view = tabs.map((x) => ({ url: typeof x.url, title: typeof x.title, favIconUrl: typeof x.favIconUrl, pendingUrl: typeof x.pendingUrl }))
    return { any: tabs.length > 0, urls: [...new Set(view.map((v) => v.url))], titles: [...new Set(view.map((v) => v.title))], favIcons: [...new Set(view.map((v) => v.favIconUrl))] }
  })
  await t.call('query.byUrl', () => chrome.tabs.query({ url: env.base + '*' }))
  await t.call('query.byTitle', () => chrome.tabs.query({ title: 'Probe page' }))
  await t.call('create', async () => {
    const tab = await chrome.tabs.create({ url: env.base + 'page?peer', active: false })
    const view = { url: typeof tab.url, pendingUrl: typeof tab.pendingUrl, title: typeof tab.title }
    await chrome.tabs.remove(tab.id)
    return view
  })
  await t.call('captureVisibleTab', () => chrome.tabs.captureVisibleTab())
  await t.call('executeScript', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    return chrome.scripting && chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.title })
  })
})

suite('windows', async (t) => {
  await t.call('getAll.populate', () => chrome.windows.getAll({ populate: true }), (all) => [...new Set(all.flatMap((w) => (w.tabs || []).map((x) => typeof x.url)))])
})

suite('storage', async (t) => {
  await chrome.storage.local.set({ peerOnly: 1 })
  await t.call('local.own', () => chrome.storage.local.get(null))
  await chrome.storage.local.clear()
})

suite('management', async (t) => {
  await t.call('getSelf', () => chrome.management.getSelf(), (e) => ({ name: e.name, permissions: e.permissions, installType: e.installType }))
  await t.call('getAll', () => chrome.management.getAll && chrome.management.getAll())
})

suite('permissions', async (t) => {
  await t.call('getAll', () => chrome.permissions.getAll())
  await t.call('contains.tabs', () => chrome.permissions.contains({ permissions: ['tabs'] }))
})
