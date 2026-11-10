/* global chrome, probe */
// One suite per API. Each records what the calls did, never ids or times, so
// the same suite run in Chrome and in the shell gives the same JSON when the
// shell does what Chrome does. env.base is the test server, like
// 'http://127.0.0.1:8473/', and env.other is the same server under a host this
// extension has no permission for ('http://localhost:8473/').
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

const PEER_ID = 'hkcielgkpfgoamfdbknpndcmhjjgljab'
const MISSING_TAB = 987654
const MISSING_WINDOW = 987655

async function waitFor(check, timeout) {
  const end = Date.now() + (timeout || 5000)
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await probe.sleep(50)
  }
  return null
}

async function waitComplete(tabId, url) {
  return waitFor(async () => {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status !== 'complete') return null
    if (url && tab.url !== url) return null
    return tab
  }, 8000)
}

async function openTab(url, props) {
  const tab = await chrome.tabs.create(Object.assign({ url, active: false }, props || {}))
  return (await waitComplete(tab.id, url)) || tab
}

async function closeTabs(ids) {
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id)
    } catch {}
  }
}

const sortedKeys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort() : o)

// ---------------------------------------------------------------- surface
suite('surface', async (t) => {
  t.set('chrome', probe.apiSurface(chrome))
  t.set('browserAlias', typeof self.browser === 'undefined' ? 'none' : self.browser === chrome ? 'same' : 'separate')
})

// ---------------------------------------------------------------- runtime
suite('runtime', async (t, env) => {
  t.set('id', chrome.runtime.id)
  t.set('getURL', chrome.runtime.getURL('x/y.html') === `chrome-extension://${chrome.runtime.id}/x/y.html`)
  const manifest = chrome.runtime.getManifest()
  t.set('manifest.name', manifest.name)
  t.set('manifest.version', manifest.manifest_version)
  t.set('manifest.key', typeof manifest.key)
  t.set('startupEvents', self.startupEvents)
  await t.call('getPlatformInfo', () => chrome.runtime.getPlatformInfo(), (info) => ({
    shape: probe.shape(info),
    os: ['mac', 'win', 'linux', 'cros', 'android', 'openbsd', 'fuchsia'].includes(info.os),
    arch: ['arm', 'arm64', 'x86-32', 'x86-64', 'mips', 'mips64', 'riscv64'].includes(info.arch),
  }))
  await t.call('sendMessage.noReceiver', () => chrome.runtime.sendMessage({ nobodyListens: true }))
  await t.call('sendMessage.peer', () => chrome.runtime.sendMessage(PEER_ID, { ping: true }))
  await t.call('sendMessage.missingExtension', () =>
    chrome.runtime.sendMessage('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { ping: true }),
  )
  const port = chrome.runtime.connect(PEER_ID, { name: 'probe-port' })
  t.set('connect.name', port.name)
  await t.event('connect.echo', port.onMessage, () => port.postMessage({ hello: 1 }), {
    map: (message) => message,
  })
  port.disconnect()
  await t.call('getContexts.background', () => chrome.runtime.getContexts({ contextTypes: ['BACKGROUND'] }), (contexts) => ({
    length: contexts.length,
    shape: probe.shape(contexts[0]),
    type: contexts[0] && contexts[0].contextType,
  }))
  await t.call('setUninstallURL', () => chrome.runtime.setUninstallURL('https://example.com/bye'))
  await t.call('setUninstallURL.bad', () => chrome.runtime.setUninstallURL('ftp://example.com/'))
  await t.call('requestUpdateCheck', () => chrome.runtime.requestUpdateCheck(), (r) => probe.shape(r))
  await t.callback('lastError.tabsGet', (cb) => chrome.tabs.get(MISSING_TAB, cb))
  t.set('lastError.afterCallback', typeof chrome.runtime.lastError)
  await t.call('promise.tabsGet', () => chrome.tabs.get(MISSING_TAB))
})

// ---------------------------------------------------------------- storage
suite('storage', async (t) => {
  const changes = []
  const listener = (change, area) => changes.push({ area, keys: Object.keys(change).sort(), change })
  chrome.storage.onChanged.addListener(listener)
  for (const area of ['local', 'sync', 'session']) {
    const s = chrome.storage[area]
    await t.call(`${area}.clear`, () => s.clear())
    await t.call(`${area}.set`, () => s.set({ a: 1, b: { c: [1, 2] }, d: 'x' }))
    await t.call(`${area}.get.one`, () => s.get('a'))
    await t.call(`${area}.get.list`, () => s.get(['a', 'd', 'missing']))
    await t.call(`${area}.get.defaults`, () => s.get({ a: 0, missing: 'dflt' }))
    await t.call(`${area}.get.all`, () => s.get(null))
    await t.call(`${area}.get.none`, () => s.get())
    if (s.getKeys) await t.call(`${area}.getKeys`, () => s.getKeys(), (keys) => keys.slice().sort())
    await t.call(`${area}.getBytesInUse`, () => s.getBytesInUse(['a']), (n) => typeof n)
    await t.call(`${area}.remove`, () => s.remove(['a', 'missing']))
    await t.call(`${area}.afterRemove`, () => s.get(null))
    await t.call(`${area}.set.undefinedValue`, () => s.set({ u: undefined }))
    await t.call(`${area}.set.function`, () => s.set({ f: () => 1 }))
    await t.call(`${area}.get.badKey`, () => s.get(42))
  }
  await t.call('session.setAccessLevel', () =>
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }),
  )
  await t.call('local.setAccessLevel', () =>
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }),
  )
  await t.call('managed.get', () => chrome.storage.managed.get(null))
  await t.call('managed.set', () => chrome.storage.managed.set({ a: 1 }))
  await t.call('sync.quotaSetTooBig', () => chrome.storage.sync.set({ big: 'x'.repeat(9000) }))
  await probe.sleep(300)
  chrome.storage.onChanged.removeListener(listener)
  t.set('onChanged', changes.map((c) => ({ area: c.area, keys: c.keys })))
  t.set('onChanged.first', changes[1] && changes[1].change)
  await chrome.storage.local.clear()
  await chrome.storage.sync.clear()
  await chrome.storage.session.clear()
})

// ---------------------------------------------------------------- i18n
suite('i18n', async (t) => {
  t.set('getMessage.name', chrome.i18n.getMessage('extName'))
  t.set('getMessage.placeholder', chrome.i18n.getMessage('greeting', ['Sam']))
  t.set('getMessage.placeholderString', chrome.i18n.getMessage('greeting', 'Ana'))
  t.set('getMessage.missing', chrome.i18n.getMessage('nope'))
  t.set('getMessage.extensionId', chrome.i18n.getMessage('@@extension_id') === chrome.runtime.id)
  t.set('getMessage.uiLocale', typeof chrome.i18n.getMessage('@@ui_locale'))
  t.set('getMessage.bidiDir', chrome.i18n.getMessage('@@bidi_dir'))
  t.set('getUILanguage', typeof chrome.i18n.getUILanguage())
  await t.call('getAcceptLanguages', () => chrome.i18n.getAcceptLanguages(), (l) => Array.isArray(l) && l.length > 0)
  await t.call('detectLanguage.fr', () =>
    chrome.i18n.detectLanguage('Bonjour tout le monde, comment allez-vous aujourd\'hui ? Il fait beau à Paris.'),
  (r) => ({ shape: probe.shape(r), top: r && r.languages && r.languages[0] && r.languages[0].language }))
})

// ---------------------------------------------------------------- alarms
suite('alarms', async (t) => {
  await chrome.alarms.clearAll()
  await t.call('create', () => chrome.alarms.create('later', { delayInMinutes: 5 }))
  await t.call('get', () => chrome.alarms.get('later'), (a) => ({ shape: probe.shape(a), name: a && a.name }))
  await t.call('get.missing', () => chrome.alarms.get('nope'))
  await t.call('create.periodic', () => chrome.alarms.create('every', { periodInMinutes: 2 }))
  await t.call('get.periodic', () => chrome.alarms.get('every'), (a) => ({ shape: probe.shape(a), period: a && a.periodInMinutes }))
  await t.call('getAll', () => chrome.alarms.getAll(), (all) => all.map((a) => a.name).sort())
  await t.call('clear', () => chrome.alarms.clear('later'))
  await t.call('clear.missing', () => chrome.alarms.clear('nope'))
  await t.call('create.noTiming', () => chrome.alarms.create('bad', {}))
  await t.event('onAlarm', chrome.alarms.onAlarm, () => chrome.alarms.create('soon', { when: Date.now() + 300 }), {
    filter: (a) => a.name === 'soon',
    map: (a) => ({ name: a.name, shape: probe.shape(a) }),
  })
  await t.call('clearAll', () => chrome.alarms.clearAll())
  await t.call('getAll.afterClear', () => chrome.alarms.getAll())
})

// ---------------------------------------------------------------- tabs
suite('tabs', async (t, env) => {
  const url = env.base + 'page?tabs'
  const opened = []
  let tab
  await t.event('onCreated', chrome.tabs.onCreated, async () => {
    tab = await chrome.tabs.create({ url, active: false })
    opened.push(tab.id)
  }, { map: (tab) => ({ shape: probe.shape(tab) }) })
  t.set('create.result', { shape: probe.shape(tab), active: tab.active, pinned: tab.pinned })
  const complete = await waitComplete(tab.id, url)
  t.set('complete', complete ? { shape: probe.shape(complete), url: complete.url === url, title: complete.title, status: complete.status, favIconUrl: typeof complete.favIconUrl } : 'never')
  await t.call('get', () => chrome.tabs.get(tab.id), (x) => ({ url: x.url === url, title: x.title, index: typeof x.index, windowId: typeof x.windowId, groupId: x.groupId, incognito: x.incognito, discarded: x.discarded, audible: x.audible, mutedInfo: x.mutedInfo, highlighted: x.highlighted, selected: x.selected }))
  await t.call('get.missing', () => chrome.tabs.get(MISSING_TAB))
  await t.call('query.url', () => chrome.tabs.query({ url: env.base + '*' }), (r) => r.some((x) => x.id === tab.id))
  await t.call('query.urlList', () => chrome.tabs.query({ url: ['http://nomatch.invalid/*', env.base + 'page*'] }), (r) => r.some((x) => x.id === tab.id))
  await t.call('query.title', () => chrome.tabs.query({ title: 'Probe page' }), (r) => r.some((x) => x.id === tab.id))
  await t.call('query.activeCurrent', () => chrome.tabs.query({ active: true, currentWindow: true }), (r) => r.length)
  await t.call('query.activeLastFocused', () => chrome.tabs.query({ active: true, lastFocusedWindow: true }), (r) => r.length)
  await t.call('query.windowCurrent', () => chrome.tabs.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }), (r) => r.length > 0)
  await t.call('query.status', () => chrome.tabs.query({ status: 'complete', url: url }), (r) => r.length)
  await t.call('query.badPattern', () => chrome.tabs.query({ url: 'not a pattern' }))
  await t.event('onUpdated.navigate', chrome.tabs.onUpdated, () => chrome.tabs.update(tab.id, { url: url + '2' }), {
    filter: (id, info) => id === tab.id && info.status === 'complete',
    map: (id, info, after) => ({ info: sortedKeys(info), url: after.url === url + '2' }),
  })
  await t.call('update.pinned', () => chrome.tabs.update(tab.id, { pinned: true }), (x) => x.pinned)
  await t.call('update.muted', () => chrome.tabs.update(tab.id, { muted: true }), (x) => x.mutedInfo)
  await t.call('update.autoDiscardable', () => chrome.tabs.update(tab.id, { autoDiscardable: false }), (x) => x.autoDiscardable)
  await t.call('update.unpin', () => chrome.tabs.update(tab.id, { pinned: false }), (x) => x.pinned)
  await t.call('update.javascriptUrl', () => chrome.tabs.update(tab.id, { url: 'javascript:void 0' }))
  await t.call('update.missing', () => chrome.tabs.update(MISSING_TAB, { pinned: true }))
  await t.call('sendMessage', () => chrome.tabs.sendMessage(tab.id, { ping: 'tab' }))
  await t.call('sendMessage.missingTab', () => chrome.tabs.sendMessage(MISSING_TAB, { ping: 'tab' }))
  const port = chrome.tabs.connect(tab.id, { name: 'tab-port' })
  await t.event('connect.echo', port.onMessage, () => port.postMessage({ hi: 1 }), { map: (m) => m })
  port.disconnect()
  await t.call('getZoom', () => chrome.tabs.getZoom(tab.id))
  await t.event('onZoomChange', chrome.tabs.onZoomChange, () => chrome.tabs.setZoom(tab.id, 1.5), {
    filter: (info) => info.tabId === tab.id,
    map: (info) => ({ shape: probe.shape(info), newZoomFactor: info.newZoomFactor }),
  })
  await t.call('getZoom.after', () => chrome.tabs.getZoom(tab.id))
  await t.call('setZoom.reset', () => chrome.tabs.setZoom(tab.id, 0))
  await t.call('getZoomSettings', () => chrome.tabs.getZoomSettings(tab.id))
  await t.call('setZoom.tooBig', () => chrome.tabs.setZoom(tab.id, 9))
  const dup = await t.call('duplicate', () => chrome.tabs.duplicate(tab.id), (x) => ({ shape: probe.shape(x) }))
  if (dup) opened.push(dup.id)
  if (dup) {
    const done = await waitComplete(dup.id)
    t.set('duplicate.url', !!done && done.url === url + '2')
  }
  const placed = await chrome.tabs.get(tab.id)
  const sibling = await openTab(env.base + 'page?sibling', { windowId: placed.windowId })
  opened.push(sibling.id)
  await t.event('onMoved', chrome.tabs.onMoved, () => chrome.tabs.move(sibling.id, { index: placed.index }), {
    filter: (id) => id === sibling.id,
    map: (id, info) => ({ shape: probe.shape(info), toIndex: info.toIndex === placed.index }),
  })
  await t.call('move.end', () => chrome.tabs.move(tab.id, { index: -1 }), (x) => ({ isArray: Array.isArray(x), shape: probe.shape(x) }))
  await t.call('move.list', () => chrome.tabs.move([tab.id], { index: 0 }), (x) => ({ isArray: Array.isArray(x), length: x.length }))
  await t.call('move.missing', () => chrome.tabs.move(MISSING_TAB, { index: 0 }))
  await t.event('onActivated', chrome.tabs.onActivated, () => chrome.tabs.update(tab.id, { active: true }), {
    filter: (info) => info.tabId === tab.id,
    map: (info) => probe.shape(info),
  })
  await t.call('active.after', () => chrome.tabs.get(tab.id), (x) => x.active)
  await t.call('highlight', async () => {
    const fresh = await chrome.tabs.get(sibling.id)
    return chrome.tabs.highlight({ windowId: fresh.windowId, tabs: [fresh.index] })
  }, (w) => ({ shape: probe.shape(w) }))
  await t.call('highlight.active', () => chrome.tabs.get(sibling.id), (x) => ({ active: x.active, highlighted: x.highlighted }))
  await t.call('highlight.badIndex', async () => {
    const fresh = await chrome.tabs.get(sibling.id)
    return chrome.tabs.highlight({ windowId: fresh.windowId, tabs: [999] })
  })
  // History made by the page itself, as a link click would make it.
  const nav = await openTab(env.base + 'page?nav1')
  opened.push(nav.id)
  await chrome.scripting.executeScript({ target: { tabId: nav.id }, func: (u) => { location.href = u }, args: [env.base + 'page?nav2'] })
  await waitComplete(nav.id, env.base + 'page?nav2')
  await t.call('goBack', () => chrome.tabs.goBack(nav.id))
  t.set('goBack.url', !!(await waitComplete(nav.id, env.base + 'page?nav1')))
  await t.call('goForward', () => chrome.tabs.goForward(nav.id))
  t.set('goForward.url', !!(await waitComplete(nav.id, env.base + 'page?nav2')))
  await t.call('goForward.noHistory', () => chrome.tabs.goForward(nav.id))
  await t.call('reload', () => chrome.tabs.reload(tab.id, { bypassCache: true }))
  await waitComplete(tab.id)
  await t.call('captureVisibleTab.default', () => chrome.tabs.captureVisibleTab(), (s) => typeof s === 'string' && s.slice(0, 15))
  await t.call('captureVisibleTab.png', () => chrome.tabs.captureVisibleTab({ format: 'png' }), (s) => typeof s === 'string' && s.slice(0, 14))
  await t.call('discard', async () => {
    const other = await openTab(env.base + 'page?discard')
    opened.push(other.id)
    return chrome.tabs.discard(other.id)
  }, (x) => x && { discarded: x.discarded, shape: probe.shape(x) })
  await t.call('create.relative', async () => {
    const x = await chrome.tabs.create({ url: 'options.html', active: false })
    opened.push(x.id)
    const done = await waitComplete(x.id)
    return done && done.url === chrome.runtime.getURL('options.html')
  })
  await t.call('create.badWindow', () => chrome.tabs.create({ url, windowId: MISSING_WINDOW }))
  await t.call('create.fileUrl', () => chrome.tabs.create({ url: 'file:///etc/hosts', active: false }), (x) => {
    opened.push(x.id)
    return 'created'
  })
  await t.call('create.javascriptUrl', () => chrome.tabs.create({ url: 'javascript:alert(1)', active: false }))
  await t.event('onRemoved', chrome.tabs.onRemoved, () => chrome.tabs.remove(tab.id), {
    filter: (id) => id === tab.id,
    map: (id, info) => ({ shape: probe.shape(info), isWindowClosing: info.isWindowClosing }),
  })
  await t.call('remove.missing', () => chrome.tabs.remove(MISSING_TAB))
  await closeTabs(opened)
})

// ---------------------------------------------------------------- tab url privacy
// Pages the extension has host permission for show their url; with the "tabs"
// permission every tab does. The peer extension checks the other side.
suite('tabs.fields', async (t, env) => {
  const own = await openTab(env.base + 'page?own')
  const other = await openTab(env.other + 'page?other')
  await t.call('own', () => chrome.tabs.get(own.id), (x) => ({ url: typeof x.url, title: typeof x.title }))
  await t.call('other', () => chrome.tabs.get(other.id), (x) => ({ url: typeof x.url, title: typeof x.title }))
  await closeTabs([own.id, other.id])
})

// ---------------------------------------------------------------- windows
suite('windows', async (t, env) => {
  const windowView = (w) => w && {
    shape: probe.shape(w),
    type: w.type,
    state: w.state,
    incognito: w.incognito,
    tabs: Array.isArray(w.tabs) ? w.tabs.length : typeof w.tabs,
  }
  await t.call('getCurrent', () => chrome.windows.getCurrent(), windowView)
  await t.call('getCurrent.populate', () => chrome.windows.getCurrent({ populate: true }), (w) => Array.isArray(w.tabs))
  await t.call('getLastFocused', () => chrome.windows.getLastFocused(), windowView)
  await t.call('getAll', () => chrome.windows.getAll(), (all) => ({ isArray: Array.isArray(all), nonEmpty: all.length > 0 }))
  await t.call('getAll.types', () => chrome.windows.getAll({ windowTypes: ['normal'] }), (all) => all.every((w) => w.type === 'normal'))
  let created
  await t.event('onCreated', chrome.windows.onCreated, async () => {
    created = await chrome.windows.create({ url: env.base + 'page?window', focused: false, width: 500, height: 400 })
  }, { map: (w) => probe.shape(w) })
  t.set('create', windowView(created))
  if (created) {
    t.set('create.tabUrl', created.tabs && created.tabs[0] && (created.tabs[0].url === env.base + 'page?window' || created.tabs[0].pendingUrl === env.base + 'page?window'))
    await t.call('get', () => chrome.windows.get(created.id, { populate: true }), windowView)
    await t.call('update.size', () => chrome.windows.update(created.id, { width: 600, height: 450 }), (w) => ({ width: w.width, height: w.height }))
    await t.call('update.badState', () => chrome.windows.update(created.id, { state: 'minimized', width: 300 }))
    await t.call('tabs.create.inWindow', () => chrome.tabs.create({ windowId: created.id, url: env.base + 'page?w2', active: false }), (x) => x.windowId === created.id)
    await t.event('onRemoved', chrome.windows.onRemoved, () => chrome.windows.remove(created.id), {
      filter: (id) => id === created.id,
      map: () => 'removed',
    })
  }
  const popup = await t.call('create.popup', () => chrome.windows.create({ url: env.base + 'page?popup', type: 'popup', focused: false, width: 300, height: 300 }), windowView)
  if (popup) await chrome.windows.remove(popup.id).catch(() => {})
  await t.call('create.urlList', async () => {
    const w = await chrome.windows.create({ url: [env.base + 'page?l1', env.base + 'page?l2'], focused: false })
    const tabs = (w.tabs || []).length
    await chrome.windows.remove(w.id)
    return tabs
  })
  await t.call('get.missing', () => chrome.windows.get(MISSING_WINDOW))
  await t.call('remove.missing', () => chrome.windows.remove(MISSING_WINDOW))
  await t.call('create.badType', () => chrome.windows.create({ type: 'panel-of-doom' }))
})

// ---------------------------------------------------------------- action
suite('action', async (t, env) => {
  await t.call('getTitle', () => chrome.action.getTitle({}))
  await t.call('setTitle', () => chrome.action.setTitle({ title: 'Changed' }))
  await t.call('getTitle.after', () => chrome.action.getTitle({}))
  await t.call('getBadgeText', () => chrome.action.getBadgeText({}))
  await t.call('setBadgeText', () => chrome.action.setBadgeText({ text: '7' }))
  await t.call('getBadgeText.after', () => chrome.action.getBadgeText({}))
  await t.call('setBadgeBackgroundColor.array', () => chrome.action.setBadgeBackgroundColor({ color: [255, 0, 0, 255] }))
  await t.call('getBadgeBackgroundColor', () => chrome.action.getBadgeBackgroundColor({}))
  await t.call('setBadgeBackgroundColor.css', () => chrome.action.setBadgeBackgroundColor({ color: '#00ff00' }))
  await t.call('getBadgeBackgroundColor.css', () => chrome.action.getBadgeBackgroundColor({}))
  await t.call('setBadgeBackgroundColor.bad', () => chrome.action.setBadgeBackgroundColor({ color: 'not-a-colour' }))
  await t.call('setBadgeTextColor', () => chrome.action.setBadgeTextColor({ color: [1, 2, 3, 255] }))
  await t.call('getBadgeTextColor', () => chrome.action.getBadgeTextColor({}))
  await t.call('getPopup', () => chrome.action.getPopup({}), (p) => p === chrome.runtime.getURL('popup.html'))
  await t.call('setPopup', () => chrome.action.setPopup({ popup: 'options.html' }))
  await t.call('getPopup.after', () => chrome.action.getPopup({}), (p) => p === chrome.runtime.getURL('options.html'))
  await t.call('setPopup.empty', () => chrome.action.setPopup({ popup: '' }))
  await t.call('getPopup.empty', () => chrome.action.getPopup({}))
  await t.call('setIcon.path', () => chrome.action.setIcon({ path: 'icon.png' }))
  await t.call('setIcon.missing', () => chrome.action.setIcon({ path: 'missing.png' }))
  await t.call('isEnabled', () => chrome.action.isEnabled())
  await t.call('disable', () => chrome.action.disable())
  await t.call('isEnabled.after', () => chrome.action.isEnabled())
  await t.call('enable', () => chrome.action.enable())
  await t.call('getUserSettings', () => chrome.action.getUserSettings(), (s) => probe.shape(s))
  await t.call('openPopup', () => chrome.action.openPopup())
  const tab = await openTab(env.base + 'page?action')
  await t.call('tab.setBadgeText', () => chrome.action.setBadgeText({ tabId: tab.id, text: 'T' }))
  await t.call('tab.getBadgeText', () => chrome.action.getBadgeText({ tabId: tab.id }))
  await t.call('global.getBadgeText', () => chrome.action.getBadgeText({}))
  await t.call('tab.isEnabled', () => chrome.action.isEnabled(tab.id))
  await t.call('tab.missing', () => chrome.action.setBadgeText({ tabId: MISSING_TAB, text: 'x' }))
  await closeTabs([tab.id])
  await chrome.action.setBadgeText({ text: '' })
  await chrome.action.setTitle({ title: '' })
  await chrome.action.setPopup({ popup: 'popup.html' })
})

// ---------------------------------------------------------------- contextMenus
suite('contextMenus', async (t) => {
  await chrome.contextMenus.removeAll()
  await t.callback('create', (cb) => chrome.contextMenus.create({ id: 'a', title: 'A', contexts: ['page'] }, cb))
  t.set('create.returns', chrome.contextMenus.create({ id: 'b', title: 'B' }))
  await t.callback('create.duplicate', (cb) => chrome.contextMenus.create({ id: 'a', title: 'A again' }, cb))
  await t.callback('create.child', (cb) => chrome.contextMenus.create({ id: 'c', parentId: 'a', title: 'C' }, cb))
  await t.callback('create.badParent', (cb) => chrome.contextMenus.create({ id: 'd', parentId: 'nope', title: 'D' }, cb))
  await t.callback('create.badContext', (cb) => chrome.contextMenus.create({ id: 'e', title: 'E', contexts: ['nowhere'] }, cb))
  await t.call('update', () => chrome.contextMenus.update('a', { title: 'A2' }))
  await t.call('update.missing', () => chrome.contextMenus.update('nope', { title: 'x' }))
  await t.call('remove', () => chrome.contextMenus.remove('b'))
  await t.call('remove.missing', () => chrome.contextMenus.remove('nope'))
  await t.call('removeAll', () => chrome.contextMenus.removeAll())
})

// ---------------------------------------------------------------- notifications
suite('notifications', async (t) => {
  const options = { type: 'basic', iconUrl: 'icon.png', title: 'Probe', message: 'Hello' }
  await t.call('create', () => chrome.notifications.create('n1', options))
  await t.call('create.generatedId', () => chrome.notifications.create(options), (id) => typeof id)
  await t.call('getAll', () => chrome.notifications.getAll(), (all) => Object.keys(all).includes('n1'))
  await t.call('update', () => chrome.notifications.update('n1', { title: 'Probe 2' }))
  await t.call('update.missing', () => chrome.notifications.update('nope', { title: 'x' }))
  await t.call('clear', () => chrome.notifications.clear('n1'))
  await t.call('clear.missing', () => chrome.notifications.clear('nope'))
  await t.call('getPermissionLevel', () => chrome.notifications.getPermissionLevel())
  await t.call('create.missingFields', () => chrome.notifications.create('n2', { type: 'basic', title: 'x' }))
  await t.call('create.badType', () => chrome.notifications.create('n3', { type: 'fancy', iconUrl: 'icon.png', title: 'x', message: 'y' }))
  const all = await chrome.notifications.getAll()
  for (const id of Object.keys(all)) await chrome.notifications.clear(id)
})

// ---------------------------------------------------------------- cookies
suite('cookies', async (t, env) => {
  const url = env.base + 'page'
  const cookieView = (c) => c && { shape: probe.shape(c), name: c.name, value: c.value, domain: c.domain, path: c.path, hostOnly: c.hostOnly, session: c.session, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, storeId: c.storeId }
  await t.event('onChanged', chrome.cookies.onChanged, () => chrome.cookies.set({ url, name: 'probe', value: '1' }), {
    filter: (info) => info.cookie.name === 'probe' && !info.removed,
    map: (info) => ({ shape: probe.shape(info), cause: info.cause }),
  })
  await t.call('get', () => chrome.cookies.get({ url, name: 'probe' }), cookieView)
  await t.call('get.missing', () => chrome.cookies.get({ url, name: 'nope' }))
  await t.call('set.full', () => chrome.cookies.set({ url, name: 'full', value: 'v', path: '/', httpOnly: true, sameSite: 'strict', expirationDate: Math.floor(Date.now() / 1000) + 3600 }), cookieView)
  await t.call('getAll.url', () => chrome.cookies.getAll({ url }), (all) => all.map((c) => c.name).sort())
  await t.call('getAll.domain', () => chrome.cookies.getAll({ domain: '127.0.0.1' }), (all) => all.map((c) => c.name).sort())
  await t.call('getAll.name', () => chrome.cookies.getAll({ name: 'probe' }), (all) => all.length)
  await t.call('getAllCookieStores', () => chrome.cookies.getAllCookieStores(), (stores) => ({ shape: probe.shape(stores), ids: stores.map((s) => s.id) }))
  await t.call('remove', () => chrome.cookies.remove({ url, name: 'probe' }), (r) => r && { shape: probe.shape(r), name: r.name })
  await t.call('remove.missing', () => chrome.cookies.remove({ url, name: 'nope' }))
  await t.call('set.noPermission', () => chrome.cookies.set({ url: env.other + 'page', name: 'x', value: '1' }))
  await t.call('get.noPermission', () => chrome.cookies.get({ url: env.other + 'page', name: 'x' }))
  await t.call('getAll.noPermission', () => chrome.cookies.getAll({ url: env.other + 'page' }))
  await t.call('set.badUrl', () => chrome.cookies.set({ url: 'not a url', name: 'x', value: '1' }))
  await chrome.cookies.remove({ url, name: 'full' })
})

// ---------------------------------------------------------------- permissions
suite('permissions', async (t) => {
  await t.call('getAll', () => chrome.permissions.getAll(), (p) => ({ shape: probe.shape(p), hasTabs: p.permissions.includes('tabs'), origins: p.origins.slice().sort() }))
  await t.call('contains.tabs', () => chrome.permissions.contains({ permissions: ['tabs'] }))
  await t.call('contains.optional', () => chrome.permissions.contains({ permissions: ['printerProvider'] }))
  await t.call('contains.origin', () => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }))
  await t.call('contains.optionalOrigin', () => chrome.permissions.contains({ origins: ['https://optional.example/*'] }))
  await t.call('contains.unknown', () => chrome.permissions.contains({ permissions: ['notAPermission'] }))
  await t.call('request.noGesture', () => chrome.permissions.request({ permissions: ['printerProvider'] }))
  await t.call('request.notOptional', () => chrome.permissions.request({ permissions: ['gcm'] }))
  await t.call('remove.required', () => chrome.permissions.remove({ permissions: ['tabs'] }))
  await t.call('remove.notGranted', () => chrome.permissions.remove({ permissions: ['printerProvider'] }))
  await t.call('addHostAccessRequest', () => chrome.permissions.addHostAccessRequest && chrome.permissions.addHostAccessRequest({ tabId: MISSING_TAB }))
})

// ---------------------------------------------------------------- management
suite('management', async (t) => {
  const view = (e) => e && { shape: probe.shape(e), installType: e.installType, type: e.type, enabled: e.enabled, mayDisable: e.mayDisable, isApp: e.isApp, offlineEnabled: e.offlineEnabled }
  await t.call('getSelf', () => chrome.management.getSelf(), view)
  await t.call('getSelf.name', () => chrome.management.getSelf(), (e) => e.name)
  await t.call('getAll', () => chrome.management.getAll(), (all) => all.map((e) => e.id).filter((id) => id === chrome.runtime.id || id === PEER_ID).sort())
  await t.call('get.peer', () => chrome.management.get(PEER_ID), (e) => ({ name: e.name, permissions: e.permissions, hostPermissions: e.hostPermissions }))
  await t.call('get.missing', () => chrome.management.get('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
  await t.call('getPermissionWarningsByManifest', () => chrome.management.getPermissionWarningsByManifest(JSON.stringify({ manifest_version: 3, name: 'x', version: '1', permissions: ['tabs', 'history'] })), (w) => ({ isArray: Array.isArray(w), length: w.length }))
  await t.call('getPermissionWarningsById', () => chrome.management.getPermissionWarningsById(PEER_ID), (w) => Array.isArray(w))
  await t.call('setEnabled.missing', () => chrome.management.setEnabled('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false))
  await t.call('uninstall.missing', () => chrome.management.uninstall('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))
  await t.call('launchApp', () => chrome.management.launchApp(PEER_ID))
})

// ---------------------------------------------------------------- scripting
suite('scripting', async (t, env) => {
  const tab = await openTab(env.base + 'page?scripting')
  const target = { tabId: tab.id }
  const resultView = (r) => r && r.map((x) => ({ shape: probe.shape(x), result: x.result, frameId: x.frameId }))
  await t.call('executeScript.func', () => chrome.scripting.executeScript({ target, func: () => document.title }), resultView)
  await t.call('executeScript.args', () => chrome.scripting.executeScript({ target, func: (a, b) => a + b, args: [2, 3] }), resultView)
  await t.call('executeScript.main', () => chrome.scripting.executeScript({ target, world: 'MAIN', func: () => typeof window.mainWorldMarker }), resultView)
  await t.call('executeScript.isolated', () => chrome.scripting.executeScript({ target, func: () => typeof window.mainWorldMarker }), resultView)
  await t.call('executeScript.promise', () => chrome.scripting.executeScript({ target, func: () => new Promise((r) => setTimeout(() => r('later'), 50)) }), resultView)
  await t.call('executeScript.file', () => chrome.scripting.executeScript({ target, files: ['inject.js'] }), resultView)
  await t.call('executeScript.throws', () => chrome.scripting.executeScript({ target, func: () => { throw new Error('boom') } }), resultView)
  await t.call('executeScript.allFrames', () => chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => location.pathname }), (r) => r.map((x) => x.result).sort())
  await t.call('executeScript.missingTab', () => chrome.scripting.executeScript({ target: { tabId: MISSING_TAB }, func: () => 1 }))
  await t.call('executeScript.missingFile', () => chrome.scripting.executeScript({ target, files: ['missing.js'] }))
  await t.call('executeScript.both', () => chrome.scripting.executeScript({ target, files: ['inject.js'], func: () => 1 }))
  const other = await openTab(env.other + 'page?scripting')
  await t.call('executeScript.noHostPermission', () => chrome.scripting.executeScript({ target: { tabId: other.id }, func: () => document.title }))
  await t.call('insertCSS.noHostPermission', () => chrome.scripting.insertCSS({ target: { tabId: other.id }, css: 'body{color:red}' }))
  const color = () => chrome.scripting.executeScript({ target, func: () => getComputedStyle(document.body).color }).then((r) => r[0].result)
  await t.call('color.before', color)
  await t.call('insertCSS', () => chrome.scripting.insertCSS({ target, css: 'body { color: rgb(1, 2, 3) }' }))
  await t.call('color.inserted', color)
  await t.call('removeCSS', () => chrome.scripting.removeCSS({ target, css: 'body { color: rgb(1, 2, 3) }' }))
  await t.call('color.removed', color)
  await t.call('insertCSS.file', () => chrome.scripting.insertCSS({ target, files: ['inject.css'] }))
  await t.call('color.file', color)
  await t.call('removeCSS.file', () => chrome.scripting.removeCSS({ target, files: ['inject.css'] }))
  await t.call('registerContentScripts', () => chrome.scripting.registerContentScripts([{ id: 'dyn', matches: [env.base + 'page?dyn*'], js: ['inject.js'], persistAcrossSessions: false, runAt: 'document_end' }]))
  await t.call('registerContentScripts.duplicate', () => chrome.scripting.registerContentScripts([{ id: 'dyn', matches: [env.base + '*'], js: ['inject.js'] }]))
  await t.call('registerContentScripts.badMatch', () => chrome.scripting.registerContentScripts([{ id: 'bad', matches: ['not a match'], js: ['inject.js'] }]))
  await t.call('getRegisteredContentScripts', () => chrome.scripting.getRegisteredContentScripts(), (all) => all.map((s) => ({ shape: probe.shape(s), id: s.id, runAt: s.runAt, allFrames: s.allFrames, world: s.world })))
  const dyn = await openTab(env.base + 'page?dyn')
  await t.call('registered.ran', () => chrome.scripting.executeScript({ target: { tabId: dyn.id }, func: () => document.documentElement.dataset.injected || 'no' }), (r) => r[0].result)
  await t.call('updateContentScripts', () => chrome.scripting.updateContentScripts([{ id: 'dyn', allFrames: true }]))
  await t.call('getRegisteredContentScripts.ids', () => chrome.scripting.getRegisteredContentScripts({ ids: ['dyn'] }), (all) => all.map((s) => s.allFrames))
  await t.call('unregisterContentScripts', () => chrome.scripting.unregisterContentScripts({ ids: ['dyn'] }))
  await t.call('unregisterContentScripts.missing', () => chrome.scripting.unregisterContentScripts({ ids: ['dyn'] }))
  await closeTabs([tab.id, other.id, dyn.id])
})

// ---------------------------------------------------------------- webNavigation
suite('webNavigation', async (t, env) => {
  const seen = []
  const names = ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onErrorOccurred', 'onCreatedNavigationTarget']
  const listeners = names.map((name) => {
    const listener = (details) => {
      if (details.url && details.url.includes('?webnav')) seen.push({ name, frameId: details.frameId, shape: probe.shape(details), transitionType: details.transitionType, documentLifecycle: details.documentLifecycle, frameType: details.frameType })
    }
    chrome.webNavigation[name].addListener(listener)
    return [name, listener]
  })
  const tab = await openTab(env.base + 'page?webnav')
  await probe.sleep(300)
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: () => { history.pushState({}, '', location.href + '&pushed'); location.hash = 'frag' } })
  await probe.sleep(500)
  for (const [name, listener] of listeners) chrome.webNavigation[name].removeListener(listener)
  t.set('events', seen.filter((e) => e.frameId === 0).map((e) => e.name))
  t.set('events.detail', seen.filter((e) => e.frameId === 0))
  await t.call('getFrame', () => chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }), (f) => ({ shape: probe.shape(f), parentFrameId: f.parentFrameId, errorOccurred: f.errorOccurred }))
  await t.call('getAllFrames', () => chrome.webNavigation.getAllFrames({ tabId: tab.id }), (all) => ({ length: all.length, shape: probe.shape(all[0]) }))
  await t.call('getFrame.missingTab', () => chrome.webNavigation.getFrame({ tabId: MISSING_TAB, frameId: 0 }))
  await t.call('getAllFrames.missingTab', () => chrome.webNavigation.getAllFrames({ tabId: MISSING_TAB }))
  await closeTabs([tab.id])
})

// ---------------------------------------------------------------- webRequest
suite('webRequest', async (t, env) => {
  const filter = { urls: [env.base + 'wr*'] }
  const seen = []
  const add = (name, extra) => {
    const listener = (details) => {
      seen.push({ name, shape: probe.shape(details), type: details.type, method: details.method, statusCode: details.statusCode, initiator: typeof details.initiator, hasRequestHeaders: Array.isArray(details.requestHeaders), hasResponseHeaders: Array.isArray(details.responseHeaders), headerShape: details.requestHeaders ? probe.shape(details.requestHeaders) : details.responseHeaders ? probe.shape(details.responseHeaders) : undefined })
    }
    try {
      chrome.webRequest[name].addListener(listener, filter, extra)
      return [name, listener]
    } catch (e) {
      t.set('addListener.' + name, probe.errorMessage(e))
      return null
    }
  }
  const listeners = [
    add('onBeforeRequest', ['requestBody']),
    add('onBeforeSendHeaders', ['requestHeaders']),
    add('onSendHeaders', ['requestHeaders']),
    add('onHeadersReceived', ['responseHeaders']),
    add('onResponseStarted', ['responseHeaders']),
    add('onBeforeRedirect'),
    add('onCompleted', ['responseHeaders']),
    add('onErrorOccurred'),
  ].filter(Boolean)
  // addListener reaches the browser asynchronously.
  await probe.sleep(300)
  await t.call('fetch', () => fetch(env.base + 'wr?plain').then((r) => r.status))
  await t.call('fetch.redirect', () => fetch(env.base + 'wr?redirect').then((r) => r.status))
  await probe.sleep(300)
  for (const [name, listener] of listeners) chrome.webRequest[name].removeListener(listener)
  t.set('events', seen.map((e) => e.name))
  t.set('events.detail', seen)
  try {
    const l = () => {}
    chrome.webRequest.onBeforeRequest.addListener(l, filter, ['blocking'])
    chrome.webRequest.onBeforeRequest.removeListener(l)
    t.set('blocking', 'allowed')
  } catch (e) {
    t.set('blocking', probe.errorMessage(e))
  }
  try {
    chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ['not a pattern'] })
    t.set('badFilter', 'allowed')
  } catch (e) {
    t.set('badFilter', probe.errorMessage(e))
  }
  // Credentials for a page that asks for a password (webRequestAuthProvider).
  const auth = (details, callback) => {
    if (details.url.includes('/auth')) callback({ authCredentials: { username: 'probe', password: 'secret' } })
    else callback({})
  }
  try {
    chrome.webRequest.onAuthRequired.addListener(auth, { urls: [env.base + 'auth*'] }, ['asyncBlocking'])
    const tab = await openTab(env.base + 'auth?tab')
    await t.call('onAuthRequired.page', () => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.body.textContent }), (r) => r[0].result)
    await closeTabs([tab.id])
  } catch (e) {
    t.set('onAuthRequired', probe.errorMessage(e))
  }
  chrome.webRequest.onAuthRequired.removeListener(auth)
  t.set('MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES', chrome.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES)
  await t.call('handlerBehaviorChanged', () => chrome.webRequest.handlerBehaviorChanged())
})

// ---------------------------------------------------------------- declarativeNetRequest
suite('declarativeNetRequest', async (t, env) => {
  const dnr = chrome.declarativeNetRequest
  const fetchStatus = (path) => fetch(env.base + path).then((r) => r.status + ' ' + r.url.replace(env.base, '/'), (e) => 'failed')
  await dnr.updateDynamicRules({ removeRuleIds: (await dnr.getDynamicRules()).map((r) => r.id) })
  await dnr.updateSessionRules({ removeRuleIds: (await dnr.getSessionRules()).map((r) => r.id) })
  await t.call('getDynamicRules.empty', () => dnr.getDynamicRules())
  await t.call('updateDynamicRules', () => dnr.updateDynamicRules({ addRules: [
    { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/dnr-blocked', resourceTypes: ['xmlhttprequest', 'main_frame'] } },
    { id: 2, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/redirected.txt' } }, condition: { urlFilter: '/dnr-redirect', resourceTypes: ['xmlhttprequest'] } },
  ] }))
  await t.call('getDynamicRules', () => dnr.getDynamicRules(), (rules) => rules.map((r) => ({ id: r.id, type: r.action.type, shape: probe.shape(r) })))
  await t.call('blocked', () => fetchStatus('dnr-blocked'))
  await t.call('redirected', () => fetch(env.base + 'dnr-redirect').then((r) => r.text()).catch(() => 'failed'))
  await t.call('updateDynamicRules.duplicateId', () => dnr.updateDynamicRules({ addRules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: 'x' } }] }))
  await t.call('updateDynamicRules.invalid', () => dnr.updateDynamicRules({ addRules: [{ id: 3, action: { type: 'block' }, condition: { urlFilter: '' } }] }))
  await t.call('updateDynamicRules.badRegex', () => dnr.updateDynamicRules({ addRules: [{ id: 4, action: { type: 'block' }, condition: { regexFilter: '(' } }] }))
  await t.call('updateSessionRules', () => dnr.updateSessionRules({ addRules: [{ id: 10, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/dnr-session', resourceTypes: ['xmlhttprequest'] } }] }))
  await t.call('getSessionRules', () => dnr.getSessionRules(), (rules) => rules.map((r) => r.id))
  await t.call('sessionBlocked', () => fetchStatus('dnr-session'))
  await t.call('getEnabledRulesets', () => dnr.getEnabledRulesets())
  await t.call('notBlockedYet', () => fetchStatus('blocked-by-ruleset'))
  await t.call('updateEnabledRulesets', () => dnr.updateEnabledRulesets({ enableRulesetIds: ['ruleset_1'] }))
  await t.call('getEnabledRulesets.after', () => dnr.getEnabledRulesets())
  await t.call('rulesetBlocked', () => fetchStatus('blocked-by-ruleset'))
  await t.call('updateEnabledRulesets.missing', () => dnr.updateEnabledRulesets({ enableRulesetIds: ['nope'] }))
  await t.call('updateStaticRules', () => dnr.updateStaticRules({ rulesetId: 'ruleset_1', disableRuleIds: [1] }))
  await t.call('getDisabledRuleIds', () => dnr.getDisabledRuleIds({ rulesetId: 'ruleset_1' }))
  await t.call('rulesetRuleDisabled', () => fetchStatus('blocked-by-ruleset'))
  await t.call('updateStaticRules.enable', () => dnr.updateStaticRules({ rulesetId: 'ruleset_1', enableRuleIds: [1] }))
  await t.call('updateEnabledRulesets.off', () => dnr.updateEnabledRulesets({ disableRulesetIds: ['ruleset_1'] }))
  await t.call('getAvailableStaticRuleCount', () => dnr.getAvailableStaticRuleCount(), (n) => typeof n)
  await t.call('isRegexSupported', () => dnr.isRegexSupported({ regex: 'a+b' }))
  await t.call('isRegexSupported.bad', () => dnr.isRegexSupported({ regex: '(' }))
  await t.call('testMatchOutcome', () => dnr.testMatchOutcome({ url: env.base + 'dnr-blocked', type: 'xmlhttprequest' }), (r) => r && r.matchedRules && r.matchedRules.map((m) => ({ ruleId: m.ruleId, rulesetId: m.rulesetId })))
  await t.call('getMatchedRules', () => dnr.getMatchedRules({}), (r) => r && { shape: probe.shape(r), any: r.rulesMatchedInfo.length > 0 })
  await t.call('setExtensionActionOptions', () => dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true }))
  await t.call('updateDynamicRules.cleanup', () => dnr.updateDynamicRules({ removeRuleIds: [1, 2] }))
  await t.call('updateSessionRules.cleanup', () => dnr.updateSessionRules({ removeRuleIds: [10] }))
  await t.call('afterCleanup', () => fetchStatus('dnr-blocked'))
})

// ---------------------------------------------------------------- downloads
suite('downloads', async (t, env) => {
  const view = (d) => d && { shape: probe.shape(d), state: d.state, mime: d.mime, filename: typeof d.filename, danger: d.danger, exists: d.exists, byExtensionId: d.byExtensionId === chrome.runtime.id, totalBytes: d.totalBytes, paused: d.paused, canResume: d.canResume }
  let id
  await t.event('onCreated', chrome.downloads.onCreated, async () => {
    id = await chrome.downloads.download({ url: env.base + 'file.txt', filename: 'probe/file.txt', conflictAction: 'uniquify' })
  }, { map: (d) => probe.shape(d) })
  t.set('download.id', typeof id)
  const done = await waitFor(async () => {
    const [d] = await chrome.downloads.search({ id })
    return d && d.state === 'complete' ? d : null
  }, 8000)
  t.set('complete', view(done))
  t.set('complete.filename', !!done && /probe[\\/]file( \(\d+\))?\.txt$/.test(done.filename))
  await t.call('search.query', () => chrome.downloads.search({ query: ['file'] }), (all) => all.some((d) => d.id === id))
  await t.call('search.orderBy', () => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }), (all) => all.length)
  await t.call('getFileIcon', () => chrome.downloads.getFileIcon(id, { size: 16 }), (s) => typeof s === 'string' && s.slice(0, 10))
  await t.call('pause.complete', () => chrome.downloads.pause(id))
  await t.call('resume.complete', () => chrome.downloads.resume(id))
  await t.call('cancel.complete', () => chrome.downloads.cancel(id))
  await t.call('open.noGesture', () => chrome.downloads.open(id))
  await t.call('setUiOptions', () => chrome.downloads.setUiOptions({ enabled: true }))
  await t.call('download.badUrl', () => chrome.downloads.download({ url: 'notaurl' }))
  await t.call('download.badFilename', () => chrome.downloads.download({ url: env.base + 'file.txt', filename: '../escape.txt' }))
  await t.call('download.absoluteFilename', () => chrome.downloads.download({ url: env.base + 'file.txt', filename: '/tmp/escape.txt' }))
  await t.call('search.missing', () => chrome.downloads.search({ id: 987654 }))
  await t.call('pause.missing', () => chrome.downloads.pause(987654))
  await t.call('removeFile', () => chrome.downloads.removeFile(id))
  await t.call('afterRemoveFile', () => chrome.downloads.search({ id }), (all) => all[0] && { exists: all[0].exists, state: all[0].state })
  await t.event('onErased', chrome.downloads.onErased, () => chrome.downloads.erase({ id }), { map: (erased) => typeof erased })
  await t.call('afterErase', () => chrome.downloads.search({ id }))
})

// ---------------------------------------------------------------- bookmarks
suite('bookmarks', async (t, env) => {
  const nodeView = (n) => n && { shape: probe.shape(n), title: n.title, url: n.url && n.url.replace(env.base, '/'), parentId: n.parentId, folderType: n.folderType }
  await t.call('getTree', () => chrome.bookmarks.getTree(), (tree) => ({ length: tree.length, root: nodeView(tree[0]), children: tree[0].children.map((c) => ({ id: c.id, title: c.title, folderType: c.folderType, shape: probe.shape(c) })) }))
  await t.call('get.root', () => chrome.bookmarks.get('0'), (r) => r.map(nodeView))
  await t.call('getChildren.bar', () => chrome.bookmarks.getChildren('1'), (r) => Array.isArray(r))
  let created
  await t.event('onCreated', chrome.bookmarks.onCreated, async () => {
    created = await chrome.bookmarks.create({ parentId: '1', title: 'Probe mark', url: env.base + 'page?bm' })
  }, { map: (id, node) => nodeView(node) })
  t.set('create', nodeView(created))
  if (!created) return
  await t.call('get', () => chrome.bookmarks.get(created.id), (r) => r.map(nodeView))
  await t.call('get.list', () => chrome.bookmarks.get([created.id]), (r) => r.length)
  await t.call('get.missing', () => chrome.bookmarks.get('987654'))
  await t.call('search.text', () => chrome.bookmarks.search('Probe mark'), (r) => r.map((n) => n.id === created.id))
  await t.call('search.url', () => chrome.bookmarks.search({ url: env.base + 'page?bm' }), (r) => r.length)
  await t.call('getRecent', () => chrome.bookmarks.getRecent(1), (r) => r.map((n) => n.id === created.id))
  await t.event('onChanged', chrome.bookmarks.onChanged, () => chrome.bookmarks.update(created.id, { title: 'Renamed' }), {
    map: (id, info) => ({ same: id === created.id, info: probe.shape(info), title: info.title }),
  })
  const folder = await t.call('create.folder', () => chrome.bookmarks.create({ parentId: '2', title: 'Probe folder' }), nodeView)
  const folderNode = (await chrome.bookmarks.search({ title: 'Probe folder' }))[0]
  await t.event('onMoved', chrome.bookmarks.onMoved, () => chrome.bookmarks.move(created.id, { parentId: folderNode.id, index: 0 }), {
    map: (id, info) => ({ same: id === created.id, shape: probe.shape(info), index: info.index }),
  })
  await t.call('getSubTree', () => chrome.bookmarks.getSubTree(folderNode.id), (r) => ({ children: r[0].children.length, shape: probe.shape(r[0]) }))
  // The folder's id differs between runs: record that it is the folder.
  await t.call('update.url', () => chrome.bookmarks.update(created.id, { url: env.base + 'page?bm2' }), (n) => Object.assign(nodeView(n), { parentId: n.parentId === folderNode.id ? '<folder>' : n.parentId }))
  await t.call('update.badUrl', () => chrome.bookmarks.update(created.id, { url: 'not a url' }))
  await t.call('create.badParent', () => chrome.bookmarks.create({ parentId: '987654', title: 'x' }))
  await t.call('create.inRoot', () => chrome.bookmarks.create({ parentId: '0', title: 'x' }))
  await t.call('remove.root', () => chrome.bookmarks.remove('1'))
  await t.call('remove.nonEmptyFolder', () => chrome.bookmarks.remove(folderNode.id))
  await t.event('onRemoved', chrome.bookmarks.onRemoved, () => chrome.bookmarks.removeTree(folderNode.id), {
    map: (id, info) => ({ shape: probe.shape(info), node: nodeView(info.node) }),
  })
  await t.call('get.removed', () => chrome.bookmarks.get(created.id))

  // Edge cases and the errors Chrome gives for them.
  await t.call('get.badId', () => chrome.bookmarks.get('abc'))
  await t.call('get.emptyList', () => chrome.bookmarks.get([]), (r) => r.length)
  await t.call('get.badType', () => chrome.bookmarks.get(5))
  await t.call('get.mobileHidden', () => chrome.bookmarks.get('3'), (r) => r.map(nodeView))
  await t.call('getChildren.root', () => chrome.bookmarks.getChildren('0'), (r) => r.map((n) => n.id))
  await t.call('getChildren.missing', () => chrome.bookmarks.getChildren('987654'))
  await t.call('getSubTree.missing', () => chrome.bookmarks.getSubTree('987654'))
  await t.call('getRecent.zero', () => chrome.bookmarks.getRecent(0))
  await t.call('remove.missing', () => chrome.bookmarks.remove('987654'))
  await t.call('removeTree.permanent', () => chrome.bookmarks.removeTree('2'))
  await t.call('removeTree.root', () => chrome.bookmarks.removeTree('0'))
  await t.call('update.root', () => chrome.bookmarks.update('1', { title: 'x' }))
  await t.call('update.missing', () => chrome.bookmarks.update('987654', { title: 'x' }))
  await t.call('move.permanent', () => chrome.bookmarks.move('1', { parentId: '2' }))
  await t.call('create.badUrl', () => chrome.bookmarks.create({ parentId: '2', title: 'x', url: 'not a url' }))
  await t.call('create.badType', () => chrome.bookmarks.create({ parentId: 2 }))
  await t.call('create.badIndexType', () => chrome.bookmarks.create({ parentId: '2', index: 'x' }))
  const outOfRange = await t.call('create.badIndex', () => chrome.bookmarks.create({ parentId: '2', title: 'Probe index', index: 999 }), nodeView)
  if (outOfRange) await chrome.bookmarks.remove(outOfRange.id)
  const negative = await t.call('create.negativeIndex', () => chrome.bookmarks.create({ parentId: '2', title: 'x', index: -1 }), nodeView)
  if (negative) await chrome.bookmarks.removeTree((await chrome.bookmarks.search({ title: 'x' }))[0].id)
  const plain = await t.call('create.noParent', () => chrome.bookmarks.create({ title: 'Probe default', url: env.base + 'page?bm3' }), nodeView)
  const untitled = await t.call('create.noTitle', () => chrome.bookmarks.create({ parentId: '2' }), nodeView)
  if (untitled) await chrome.bookmarks.remove(untitled.id)
  if (plain) {
    await t.call('create.urlParent', () => chrome.bookmarks.create({ parentId: plain.id, title: 'x' }))
    await t.call('getChildren.url', () => chrome.bookmarks.getChildren(plain.id), (r) => r.length)
    await t.call('getSubTree.url', () => chrome.bookmarks.getSubTree(plain.id), (r) => r.map((n) => probe.shape(n)))
    await t.call('move.urlParent', () => chrome.bookmarks.move(plain.id, { parentId: plain.id }))
    await t.event('onChanged.urlOnly', chrome.bookmarks.onChanged, () => chrome.bookmarks.update(plain.id, { url: env.base + 'page?bm4' }), {
      map: (id, info) => ({ info: probe.shape(info), url: info.url && info.url.replace(env.base, '/') }),
    })
    await t.event('onRemoved.url', chrome.bookmarks.onRemoved, () => chrome.bookmarks.remove(plain.id), {
      map: (id, info) => ({ shape: probe.shape(info), node: nodeView(info.node), parentId: info.parentId }),
    })
  }
  const outer = await chrome.bookmarks.create({ parentId: '2', title: 'Probe outer' })
  const inner = await chrome.bookmarks.create({ parentId: outer.id, title: 'Probe inner' })
  const leaf = await chrome.bookmarks.create({ parentId: outer.id, title: 'Probe leaf', url: env.base + 'page?leaf' })
  await t.call('getChildren.order', () => chrome.bookmarks.getChildren(outer.id), (r) => r.map((n) => ({ title: n.title, index: n.index })))
  await t.call('move.intoDescendant', () => chrome.bookmarks.move(outer.id, { parentId: inner.id }))
  await t.call('move.intoSelf', () => chrome.bookmarks.move(outer.id, { parentId: outer.id }))
  await t.call('move.toRoot', () => chrome.bookmarks.move(inner.id, { parentId: '0' }))
  await t.call('move.missingParent', () => chrome.bookmarks.move(inner.id, { parentId: '987654' }))
  await t.call('move.badIndex', () => chrome.bookmarks.move(leaf.id, { parentId: outer.id, index: 999 }), (n) => ({ index: n.index }))
  await t.event('onMoved.sameParent', chrome.bookmarks.onMoved, () => chrome.bookmarks.move(leaf.id, { index: 0 }), {
    map: (id, info) => ({ index: info.index, oldIndex: info.oldIndex, same: info.parentId === info.oldParentId }),
  })
  await t.call('getChildren.afterMove', () => chrome.bookmarks.getChildren(outer.id), (r) => r.map((n) => ({ title: n.title, index: n.index })))
  await t.call('update.folderUrl', () => chrome.bookmarks.update(outer.id, { url: env.base }))
  await t.call('update.empty', () => chrome.bookmarks.update(leaf.id, {}), (n) => Object.assign(nodeView(n), { parentId: n.parentId === outer.id ? '<outer>' : n.parentId }))
  await t.event('onChanged.folder', chrome.bookmarks.onChanged, () => chrome.bookmarks.update(outer.id, { title: 'Probe outer 2' }), {
    map: (id, info) => ({ info: probe.shape(info), title: info.title }),
  })
  await t.call('search.query', () => chrome.bookmarks.search({ query: 'probe outer' }), (r) => r.map((n) => n.title))
  await t.call('search.words', () => chrome.bookmarks.search('outer probe'), (r) => r.map((n) => n.title))
  await t.call('search.prefix', () => chrome.bookmarks.search('prob lea'), (r) => r.map((n) => n.title))
  await t.call('search.inUrl', () => chrome.bookmarks.search('leaf'), (r) => r.map((n) => n.title))
  await t.call('search.caseless', () => chrome.bookmarks.search('PROBE LEAF'), (r) => r.map((n) => n.title))
  await t.call('search.empty', () => chrome.bookmarks.search(''), (r) => r.length)
  await t.call('search.emptyObject', () => chrome.bookmarks.search({}), (r) => r.length)
  await t.call('search.badUrl', () => chrome.bookmarks.search({ url: 'not a url' }), (r) => r.length)
  await t.call('search.title', () => chrome.bookmarks.search({ title: 'Probe outer 2' }), (r) => r.map((n) => n.title))
  await t.call('search.titlePart', () => chrome.bookmarks.search({ title: 'Probe outer' }), (r) => r.length)
  await t.call('search.queryAndTitle', () => chrome.bookmarks.search({ query: 'probe', title: 'Probe leaf' }), (r) => r.map((n) => n.title))
  await t.call('getRecent.folders', () => chrome.bookmarks.getRecent(5), (r) => r.map((n) => n.title))
  await t.call('getSubTree.nested', () => chrome.bookmarks.getSubTree(outer.id), (r) => r[0].children.map((c) => ({ title: c.title, shape: probe.shape(c) })))
  await t.call('remove.folderWithChildren', () => chrome.bookmarks.remove(outer.id))
  await t.event('onRemoved.tree', chrome.bookmarks.onRemoved, () => chrome.bookmarks.removeTree(outer.id), {
    map: (id, info) => info.node.children.map((c) => ({ title: c.title, shape: probe.shape(c) })),
  })
  await t.call('get.innerGone', () => chrome.bookmarks.get(inner.id))
  // Mobile bookmarks is listed once it holds something, as in Chrome.
  const mobile = await t.call('create.mobile', () => chrome.bookmarks.create({ parentId: '3', title: 'Probe mobile', url: env.base + 'page?m' }), nodeView)
  await t.call('getTree.withMobile', () => chrome.bookmarks.getTree(), (tree) => tree[0].children.map((c) => ({ id: c.id, title: c.title, folderType: c.folderType, index: c.index })))
  if (mobile) await chrome.bookmarks.remove(mobile.id)
  await t.call('getTree.afterMobile', () => chrome.bookmarks.getTree(), (tree) => tree[0].children.length)
  const js = await t.call('create.javascriptUrl', () => chrome.bookmarks.create({ parentId: '2', title: 'Probe js', url: 'javascript:void(0)' }), nodeView)
  if (js) await chrome.bookmarks.remove(js.id)
  const internal = await t.call('create.chromeUrl', () => chrome.bookmarks.create({ parentId: '2', title: 'Probe settings', url: 'chrome://settings/' }), nodeView)
  if (internal) await chrome.bookmarks.remove(internal.id)
  const relative = await t.call('create.relativeUrl', () => chrome.bookmarks.create({ parentId: '2', title: 'Probe relative', url: '/page' }), nodeView)
  if (relative) await chrome.bookmarks.remove((await chrome.bookmarks.search({ title: 'Probe relative' }))[0].id)
  await t.call('get.bar', () => chrome.bookmarks.get('1'), (r) => r.map((n) => ({ shape: probe.shape(n), title: n.title, folderType: n.folderType })))
  await t.call('get.other', () => chrome.bookmarks.get('2'), (r) => r.map((n) => probe.shape(n)))
  await t.call('getTree.end', () => chrome.bookmarks.getTree(), (tree) => tree[0].children.map((c) => c.children.length))
})

// ---------------------------------------------------------------- history
suite('history', async (t, env) => {
  const url = env.base + 'page?history'
  await t.call('deleteAll', () => chrome.history.deleteAll())
  await t.call('addUrl', () => chrome.history.addUrl({ url }))
  await t.call('search', () => chrome.history.search({ text: '', startTime: 0 }), (r) => r.filter((x) => x.url === url).map((x) => ({ shape: probe.shape(x), visitCount: x.visitCount, typedCount: x.typedCount })))
  await t.call('getVisits', () => chrome.history.getVisits({ url }), (r) => r.map((v) => ({ shape: probe.shape(v), transition: v.transition, isLocal: v.isLocal })))
  await t.event('onVisited', chrome.history.onVisited, async () => {
    const tab = await openTab(env.base + 'page?visited')
    await closeTabs([tab.id])
  }, { filter: (item) => item.url === env.base + 'page?visited', map: (item) => ({ shape: probe.shape(item), title: item.title }) })
  await t.call('search.text', () => chrome.history.search({ text: 'visited', startTime: 0 }), (r) => r.map((x) => x.url.replace(env.base, '/')))
  await t.call('search.max', () => chrome.history.search({ text: '', startTime: 0, maxResults: 1 }), (r) => r.length)
  await t.event('onVisitRemoved', chrome.history.onVisitRemoved, () => chrome.history.deleteUrl({ url }), {
    map: (info) => ({ shape: probe.shape(info), allHistory: info.allHistory, urls: info.urls && info.urls.map((u) => u.replace(env.base, '/')) }),
  })
  await t.call('deleteRange', () => chrome.history.deleteRange({ startTime: 0, endTime: Date.now() }))
  await t.call('search.afterDelete', () => chrome.history.search({ text: '', startTime: 0 }), (r) => r.filter((x) => x.url.startsWith(env.base)).length)
  await t.call('addUrl.bad', () => chrome.history.addUrl({ url: 'not a url' }))

  // Edge cases and the errors Chrome gives for them.
  const second = env.base + 'page?history2'
  await t.call('addUrl.noUrl', () => chrome.history.addUrl({}))
  await t.call('addUrl.badType', () => chrome.history.addUrl({ url: 5 }))
  await t.call('search.noText', () => chrome.history.search({}))
  await t.call('search.maxNegative', () => chrome.history.search({ text: '', maxResults: -1 }))
  await t.call('search.badTime', () => chrome.history.search({ text: '', startTime: 'x' }))
  await t.call('getVisits.bad', () => chrome.history.getVisits({ url: 'not a url' }))
  await t.call('getVisits.unknown', () => chrome.history.getVisits({ url: env.base + 'never' }), (r) => r.length)
  await t.call('deleteUrl.bad', () => chrome.history.deleteUrl({ url: 'not a url' }))
  await t.call('deleteUrl.unknown', () => chrome.history.deleteUrl({ url: env.base + 'never' }))
  await t.call('deleteRange.noEnd', () => chrome.history.deleteRange({ startTime: 0 }))
  await t.call('addUrl.chrome', () => chrome.history.addUrl({ url: 'chrome://version/' }))
  await t.call('addUrl.data', () => chrome.history.addUrl({ url: 'data:text/plain,probe' }))
  await t.call('addUrl.about', () => chrome.history.addUrl({ url: 'about:blank' }))
  await t.call('search.schemes', () => chrome.history.search({ text: '', startTime: 0 }), (r) => r.map((x) => x.url.split(':')[0]).sort())
  await t.event('onVisited.addUrl', chrome.history.onVisited, () => chrome.history.addUrl({ url: second }), {
    filter: (item) => item.url === second,
    map: (item) => ({ shape: probe.shape(item), visitCount: item.visitCount, typedCount: item.typedCount, title: item.title }),
  })
  await chrome.history.addUrl({ url: second })
  await t.call('search.twice', () => chrome.history.search({ text: 'history2', startTime: 0 }), (r) => r.map((x) => ({ visitCount: x.visitCount, typedCount: x.typedCount })))
  await t.call('getVisits.twice', () => chrome.history.getVisits({ url: second }), (r) => r.map((v) => ({ transition: v.transition, referringVisitId: v.referringVisitId })))
  await t.call('search.future', () => chrome.history.search({ text: '', startTime: Date.now() + 60000 }), (r) => r.length)
  await t.call('search.endTime', () => chrome.history.search({ text: '', startTime: 0, endTime: 1 }), (r) => r.length)
  await t.call('search.default24h', () => chrome.history.search({ text: 'history2' }), (r) => r.length)
  const tab = await openTab(env.base + 'page?titled')
  await probe.sleep(300)
  await t.call('search.title', () => chrome.history.search({ text: 'titled', startTime: 0 }), (r) => r.map((x) => ({ title: x.title, visitCount: x.visitCount, typedCount: x.typedCount })))
  await t.call('search.byTitle', () => chrome.history.search({ text: 'Probe page', startTime: 0 }), (r) => r.length > 0)
  await t.call('getVisits.link', () => chrome.history.getVisits({ url: env.base + 'page?titled' }), (r) => r.map((v) => v.transition))
  await t.call('search.noFrames', () => chrome.history.search({ text: 'frame', startTime: 0 }), (r) => r.length)
  await closeTabs([tab.id])
  await t.event('onVisitRemoved.all', chrome.history.onVisitRemoved, () => chrome.history.deleteAll(), {
    map: (info) => ({ shape: probe.shape(info), allHistory: info.allHistory, urls: info.urls }),
  })
  await t.call('search.afterDeleteAll', () => chrome.history.search({ text: '', startTime: 0 }), (r) => r.length)
})

// ---------------------------------------------------------------- topSites
suite('topSites', async (t, env) => {
  // A visit first, so the list has a site whatever ran before: Chrome lists
  // its own suggestions in a new profile, the shell lists sites from history.
  const tab = await openTab(env.base + 'page?top')
  await closeTabs([tab.id])
  await t.call('get', () => chrome.topSites.get(), (r) => ({ isArray: Array.isArray(r), shape: r.length ? probe.shape(r[0]) : 'empty' }))
})

// ---------------------------------------------------------------- sessions
suite('sessions', async (t, env) => {
  t.set('MAX_SESSION_RESULTS', chrome.sessions.MAX_SESSION_RESULTS)
  const tab = await openTab(env.base + 'page?closed')
  await t.event('onChanged', chrome.sessions.onChanged, () => chrome.tabs.remove(tab.id), { map: () => 'changed' })
  const recent = await t.call('getRecentlyClosed', () => chrome.sessions.getRecentlyClosed({ maxResults: 1 }), (r) => r.map((s) => ({ shape: probe.shape(s), tab: s.tab && { shape: probe.shape(s.tab), url: s.tab.url === env.base + 'page?closed' } })))
  await t.call('getDevices', () => chrome.sessions.getDevices())
  if (recent && recent[0] && recent[0].tab) {
    await t.call('restore', () => chrome.sessions.restore(recent[0].tab.sessionId), (s) => ({ shape: probe.shape(s), url: s.tab && (s.tab.url === env.base + 'page?closed' || s.tab.pendingUrl === env.base + 'page?closed') }))
    const [restored] = await chrome.tabs.query({ url: env.base + 'page?closed' })
    if (restored) await closeTabs([restored.id])
  }
  await t.call('restore.missing', () => chrome.sessions.restore('987654'))
})

// ---------------------------------------------------------------- tabGroups
suite('tabGroups', async (t, env) => {
  t.set('TAB_GROUP_ID_NONE', chrome.tabGroups.TAB_GROUP_ID_NONE)
  const a = await openTab(env.base + 'page?ga')
  const b = await openTab(env.base + 'page?gb')
  let groupId
  await t.event('onCreated', chrome.tabGroups.onCreated, async () => {
    groupId = await chrome.tabs.group({ tabIds: [a.id, b.id] })
  }, { map: (g) => probe.shape(g) })
  t.set('group', typeof groupId)
  await t.call('tab.groupId', () => chrome.tabs.get(a.id), (x) => x.groupId === groupId)
  await t.call('get', () => chrome.tabGroups.get(groupId), (g) => ({ shape: probe.shape(g), collapsed: g.collapsed, title: g.title, color: typeof g.color }))
  await t.event('onUpdated', chrome.tabGroups.onUpdated, () => chrome.tabGroups.update(groupId, { title: 'Probe', color: 'red', collapsed: false }), {
    map: (g) => ({ title: g.title, color: g.color }),
  })
  await t.call('query', () => chrome.tabGroups.query({ title: 'Probe' }), (r) => r.map((g) => g.id === groupId))
  await t.call('update.badColor', () => chrome.tabGroups.update(groupId, { color: 'plaid' }))
  await t.event('onMoved', chrome.tabGroups.onMoved, () => chrome.tabGroups.move(groupId, { index: 0 }), { map: (g) => g.id === groupId })
  await t.call('get.missing', () => chrome.tabGroups.get(987654))
  await t.call('ungroup', () => chrome.tabs.ungroup([b.id]))
  await t.call('tab.ungrouped', () => chrome.tabs.get(b.id), (x) => x.groupId)
  await t.event('onRemoved', chrome.tabGroups.onRemoved, () => chrome.tabs.ungroup([a.id]), { map: (g) => g.id === groupId })
  await t.call('group.missingTab', () => chrome.tabs.group({ tabIds: [MISSING_TAB] }))
  await closeTabs([a.id, b.id])
})

// ---------------------------------------------------------------- idle, power, system
suite('idle', async (t) => {
  await t.call('queryState', () => chrome.idle.queryState(60), (s) => ['active', 'idle', 'locked'].includes(s))
  await t.call('queryState.tooSmall', () => chrome.idle.queryState(5), (s) => ['active', 'idle', 'locked'].includes(s))
  t.set('setDetectionInterval', chrome.idle.setDetectionInterval(30))
  await t.call('getAutoLockDelay', () => chrome.idle.getAutoLockDelay(), (n) => typeof n)
})

suite('power', async (t) => {
  t.set('requestKeepAwake', chrome.power.requestKeepAwake('display'))
  t.set('releaseKeepAwake', chrome.power.releaseKeepAwake())
  await t.call('reportActivity', () => chrome.power.reportActivity())
})

suite('system', async (t) => {
  await t.call('cpu', () => chrome.system.cpu.getInfo(), (i) => ({ shape: probe.shape(i), processor: probe.shape(i.processors[0]), usage: probe.shape(i.processors[0].usage) }))
  await t.call('memory', () => chrome.system.memory.getInfo(), (i) => ({ shape: probe.shape(i), sane: i.capacity >= i.availableCapacity }))
  await t.call('display', () => chrome.system.display.getInfo(), (d) => ({ isArray: Array.isArray(d), shape: d.length ? probe.shape(d[0]) : 'none' }))
  await t.call('display.layout', () => chrome.system.display.getDisplayLayout(), (d) => Array.isArray(d))
  await t.call('storage', () => chrome.system.storage.getInfo(), (d) => ({ isArray: Array.isArray(d), shape: d.length ? probe.shape(d[0]) : 'none' }))
  await t.call('storage.capacity.missing', () => chrome.system.storage.getAvailableCapacity('nope'))
})

// ---------------------------------------------------------------- browsingData
suite('browsingData', async (t, env) => {
  await t.call('settings', () => chrome.browsingData.settings(), (s) => ({ shape: probe.shape(s), dataToRemove: Object.keys(s.dataToRemove).sort(), dataRemovalPermitted: Object.keys(s.dataRemovalPermitted).sort() }))
  await chrome.cookies.set({ url: env.base, name: 'bd', value: '1' })
  await t.call('removeCookies', () => chrome.browsingData.removeCookies({ since: 0 }))
  await t.call('cookieGone', () => chrome.cookies.get({ url: env.base, name: 'bd' }))
  await t.call('remove.origins', () => chrome.browsingData.remove({ origins: [env.base.replace(/\/$/, '')] }, { cache: true, localStorage: true, cookies: true }))
  await t.call('remove.badOrigin', () => chrome.browsingData.remove({ origins: ['not an origin'] }, { cookies: true }))
  await t.call('removeCache', () => chrome.browsingData.removeCache({ since: Date.now() - 1000 }))
  await t.call('removeLocalStorage', () => chrome.browsingData.removeLocalStorage({ since: Date.now() - 1000 }))
  await t.call('removeIndexedDB', () => chrome.browsingData.removeIndexedDB({ since: Date.now() - 1000 }))
  await t.call('removeServiceWorkers', () => chrome.browsingData.removeServiceWorkers({ since: Date.now() - 1000, origins: [env.base.replace(/\/$/, '')] }))
  await t.call('removeHistory', () => chrome.browsingData.removeHistory({ since: Date.now() - 1000 }))
  await t.call('removeDownloads', () => chrome.browsingData.removeDownloads({ since: Date.now() - 1000 }))
  await t.call('removeFormData', () => chrome.browsingData.removeFormData({ since: Date.now() - 1000 }))
  await t.call('removePasswords', () => chrome.browsingData.removePasswords({ since: Date.now() - 1000 }))
  const bd = chrome.browsingData
  const origin = env.base.replace(/\/$/, '')
  await t.call('settings.values', () => bd.settings(), (s) => ({ originTypes: s.options.originTypes, minutesAgo: Math.round((Date.now() - s.options.since) / 60000), dataToRemove: s.dataToRemove, dataRemovalPermitted: s.dataRemovalPermitted }))
  await t.call('remove.passwordsIgnored', () => bd.remove({}, { passwords: true, webSQL: true, appcache: true }))
  await t.call('remove.originsAndExclude', () => bd.remove({ origins: [origin], excludeOrigins: [origin] }, { cookies: true }))
  await t.call('remove.originsHistory', () => bd.remove({ origins: [origin] }, { history: true }))
  await t.call('remove.excludeDownloads', () => bd.remove({ excludeOrigins: [origin] }, { downloads: true }))
  await t.call('remove.sinceString', () => bd.remove({ since: 'x' }, { cookies: true }))
  await t.call('remove.unknownType', () => bd.remove({}, { bogus: true }))
  await t.call('remove.noArgs', () => bd.remove())
  await t.call('remove.oneArg', () => bd.remove({}))
  await t.call('remove.unknownOriginType', () => bd.remove({ originTypes: { bogus: true } }, { localStorage: true }))
  await t.call('remove.extensionOnly', () => bd.remove({ originTypes: { extension: true, unprotectedWeb: false } }, { localStorage: true }))
  await t.call('removeAppcache', () => bd.removeAppcache({}))
  await t.call('removeWebSQL', () => bd.removeWebSQL({}))
  await t.call('removePluginData', () => bd.removePluginData({}))
  await t.call('removeCacheStorage', () => bd.removeCacheStorage({ origins: [origin] }))
  await t.call('removeFileSystems', () => bd.removeFileSystems({ excludeOrigins: [origin] }))
  await t.call('removeCookies.noArgs', () => bd.removeCookies())
  await t.call('origins.empty', () => bd.removeCookies({ origins: [] }))
  await t.call('origins.notArray', () => bd.removeCookies({ origins: 'x' }))
  for (const o of ['https://a.example/path', 'a.example', 'https://a.example:99999', 'file:///tmp', 'data:text/plain,x', 'about:blank', 'https://', 'HTTPS://A.EXAMPLE']) {
    await t.call('origin.' + o, () => bd.removeCookies({ origins: [o] }))
  }
  await chrome.cookies.set({ url: env.base, name: 'bd2', value: '1' })
  const has = async () => ((await chrome.cookies.get({ url: env.base, name: 'bd2' })) ? 'kept' : 'gone')
  await t.call('cookie.sinceLater', async () => { await bd.removeCookies({ since: Date.now() + 100000 }); return has() })
  await t.call('cookie.otherSite', async () => { await bd.removeCookies({ origins: ['https://a.example'] }); return has() })
  await t.call('cookie.excluded', async () => { await bd.removeCookies({ excludeOrigins: [origin] }); return has() })
  await t.call('cookie.otherPortSameHost', async () => { await bd.removeCookies({ origins: ['http://127.0.0.1:1'] }); return has() })
  await chrome.cookies.set({ url: env.base, name: 'bd2', value: '1' })
  await t.call('cookie.lastMinute', async () => { await bd.removeCookies({ since: Date.now() - 60000 }); return has() })
  const tab = await openTab(env.base + 'page?storage')
  const read = () => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => localStorage.getItem('bd') }).then((r) => r[0].result)
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => localStorage.setItem('bd', '1') })
  await t.call('localStorage.otherOrigin', async () => { await bd.removeLocalStorage({ origins: ['https://a.example'] }); return read() })
  await t.call('localStorage.origin', async () => { await bd.removeLocalStorage({ origins: [origin] }); return read() })
  await closeTabs([tab.id])
})

// ---------------------------------------------------------------- contentSettings
suite('contentSettings', async (t, env) => {
  const cs = chrome.contentSettings
  const primaryUrl = env.base + 'page'
  const types = ['automaticDownloads', 'autoVerify', 'camera', 'clipboard', 'cookies', 'images', 'javascript', 'location', 'microphone', 'notifications', 'plugins', 'popups', 'sound']
  for (const type of types) {
    if (!cs[type]) {
      t.set(type, 'absent')
      continue
    }
    await t.call(type + '.get', () => cs[type].get({ primaryUrl }))
  }
  await t.call('javascript.set', () => cs.javascript.set({ primaryPattern: 'http://127.0.0.1/*', setting: 'block' }))
  await t.call('javascript.get.after', () => cs.javascript.get({ primaryUrl }))
  const blocked = await openTab(env.base + 'page?nojs')
  await t.call('javascript.enforced', () => chrome.scripting.executeScript({ target: { tabId: blocked.id }, world: 'MAIN', func: () => typeof window.mainWorldMarker }), (r) => r[0].result)
  await closeTabs([blocked.id])
  await t.call('javascript.clear', () => cs.javascript.clear({}))
  await t.call('javascript.get.cleared', () => cs.javascript.get({ primaryUrl }))
  await t.call('cookies.set.badSetting', () => cs.cookies.set({ primaryPattern: 'http://127.0.0.1/*', setting: 'sometimes' }))
  await t.call('cookies.set.badPattern', () => cs.cookies.set({ primaryPattern: 'not a pattern', setting: 'block' }))
  await t.call('images.getResourceIdentifiers', () => cs.images.getResourceIdentifiers())
  await t.call('notifications.set', () => cs.notifications.set({ primaryPattern: 'http://127.0.0.1/*', setting: 'ask' }))
  await t.call('notifications.get.after', () => cs.notifications.get({ primaryUrl }))
  await t.call('notifications.clear', () => cs.notifications.clear({}))
  await t.call('set.noPattern', () => cs.javascript.set({ setting: 'block' }))
  await t.call('set.settingNumber', () => cs.javascript.set({ primaryPattern: '<all_urls>', setting: 5 }))
  await t.call('set.noSetting', () => cs.javascript.set({ primaryPattern: '<all_urls>' }))
  await t.call('set.extraProp', () => cs.javascript.set({ primaryPattern: '<all_urls>', setting: 'block', foo: 1 }))
  await t.call('set.badScope', () => cs.javascript.set({ primaryPattern: '<all_urls>', setting: 'block', scope: 'bogus' }))
  await t.call('set.incognito', () => cs.javascript.set({ primaryPattern: '<all_urls>', setting: 'block', scope: 'incognito_session_only' }))
  await t.call('set.noArgs', () => cs.javascript.set())
  await t.call('clear.incognito', () => cs.javascript.clear({ scope: 'incognito_session_only' }))
  await t.call('clear.noArgs', () => cs.javascript.clear())
  await t.call('get.badUrl', () => cs.javascript.get({ primaryUrl: 'not a url' }))
  await t.call('get.badSecondary', () => cs.javascript.get({ primaryUrl, secondaryUrl: 'nope' }))
  await t.call('get.incognito', () => cs.javascript.get({ primaryUrl, incognito: true }))
  await t.call('get.noUrl', () => cs.javascript.get({}))
  await t.call('get.noArgs', () => cs.javascript.get())
  await t.call('get.resourceIdentifier', () => cs.javascript.get({ primaryUrl, resourceIdentifier: { id: 'x' } }))
  await t.call('getResourceIdentifiers.extraArg', () => cs.javascript.getResourceIdentifiers(1))
  for (const p of ['*://*/*', 'https://*.a.example/*', 'file:///tmp/x.html', 'http://127.0.0.1:8080/*', 'http://a.example:*/*', 'file:///*', 'http://127.0.0.1/path', 'chrome://settings/*', 'ftp://x/*', 'http://127.0.0.1', '*', 'http://*.127.0.0.1/*', 'http:/x/*', 'http://*foo/*', 'http://a.example:99999/*', 'urn:x', 'chrome-extension://abc/*']) {
    await t.call('pattern.' + p, () => cs.images.set({ primaryPattern: p, setting: 'block' }))
  }
  await t.call('pattern.matchesFile', () => cs.images.get({ primaryUrl: 'file:///tmp/y.html' }))
  await t.call('pattern.clear', () => cs.images.clear({}))
  await t.call('secondary.bad', () => cs.cookies.set({ primaryPattern: '<all_urls>', secondaryPattern: 'not a pattern', setting: 'block' }))
  await t.call('secondary.notSupported', () => cs.javascript.set({ primaryPattern: 'http://127.0.0.1/*', secondaryPattern: 'https://a.example/*', setting: 'block' }))
  await t.call('secondary.samePattern', () => cs.camera.set({ primaryPattern: 'http://127.0.0.1/*', secondaryPattern: 'http://127.0.0.1/*', setting: 'block' }))
  await t.call('secondary.samePattern.get', () => cs.camera.get({ primaryUrl }))
  await cs.camera.clear({})
  await t.call('secondary.cookies', () => cs.cookies.set({ primaryPattern: 'http://127.0.0.1/*', secondaryPattern: 'https://a.example/*', setting: 'block' }))
  await t.call('secondary.cookies.match', () => cs.cookies.get({ primaryUrl, secondaryUrl: 'https://a.example/' }))
  await t.call('secondary.cookies.other', () => cs.cookies.get({ primaryUrl, secondaryUrl: 'https://b.example/' }))
  await t.call('secondary.cookies.none', () => cs.cookies.get({ primaryUrl }))
  await cs.cookies.clear({})
  await t.call('default.cameraAllow', () => cs.camera.set({ primaryPattern: '<all_urls>', setting: 'allow' }))
  await t.call('default.microphoneAllow', () => cs.microphone.set({ primaryPattern: '*://*/*', setting: 'allow' }))
  await t.call('default.notificationsAllow', () => cs.notifications.set({ primaryPattern: '<all_urls>', setting: 'allow' }))
  await t.call('default.notificationsAllow.get', () => cs.notifications.get({ primaryUrl }))
  await cs.notifications.clear({})
  await t.call('autoVerify.siteRule', () => cs.autoVerify.set({ primaryPattern: 'http://127.0.0.1/*', setting: 'block' }))
  await t.call('autoVerify.everySite', () => cs.autoVerify.set({ primaryPattern: '<all_urls>', setting: 'block' }))
  await t.call('autoVerify.everySite.get', () => cs.autoVerify.get({ primaryUrl }))
  await cs.autoVerify.clear({})
  await t.call('cookies.sessionOnly', () => cs.cookies.set({ primaryPattern: 'http://127.0.0.1/*', setting: 'session_only' }))
  await t.call('cookies.sessionOnly.get', () => cs.cookies.get({ primaryUrl }))
  await cs.cookies.clear({})
  const precedence = async (name, rules, url) => {
    for (const [pattern, setting] of rules) await cs.javascript.set({ primaryPattern: pattern, setting })
    await t.call('precedence.' + name, () => cs.javascript.get({ primaryUrl: url }))
    await cs.javascript.clear({})
  }
  await precedence('port', [['http://127.0.0.1/*', 'block'], [env.base + '*', 'allow']], primaryUrl)
  await precedence('hostOverScheme', [['*://127.0.0.1/*', 'block'], ['http://*/*', 'allow']], primaryUrl)
  await precedence('longerDomain', [['https://*.example.com/*', 'block'], ['https://*.a.example.com/*', 'allow']], 'https://x.a.example.com/')
  await precedence('domainItself', [['https://*.example.com/*', 'block'], ['https://*.a.example.com/*', 'allow']], 'https://example.com/')
  await precedence('overwrite', [['https://a.example/*', 'block'], ['https://a.example/*', 'allow']], 'https://a.example/')
  await precedence('defaultPort', [['https://a.example:443/*', 'block']], 'https://a.example/')
  await precedence('hostOverAll', [['<all_urls>', 'block'], ['https://a.example/*', 'allow']], 'https://a.example/')
  await cs.javascript.set({ primaryPattern: '<all_urls>', setting: 'block' })
  await t.call('allUrls.browserPage', () => cs.javascript.get({ primaryUrl: 'chrome://settings/' }))
  await t.call('allUrls.extensionPage', () => cs.javascript.get({ primaryUrl: 'chrome-extension://' + chrome.runtime.id + '/page.html' }))
  await t.call('allUrls.file', () => cs.javascript.get({ primaryUrl: 'file:///tmp/x.html' }))
  await cs.javascript.clear({})
  for (const type of ['images', 'notifications', 'camera', 'sound', 'location']) {
    await cs[type].set({ primaryPattern: '<all_urls>', setting: 'block' })
    await t.call('allUrls.' + type + '.extensionPage', () => cs[type].get({ primaryUrl: 'chrome-extension://' + chrome.runtime.id + '/page.html' }))
    await t.call('allUrls.' + type + '.browserPage', () => cs[type].get({ primaryUrl: 'chrome://settings/' }))
    await cs[type].clear({})
  }
  for (const type of ['fullscreen', 'mouselock', 'plugins', 'unsandboxedPlugins']) {
    t.set(type + '.setReturns', typeof cs[type].set({ primaryPattern: '<all_urls>', setting: 'block' }))
    await t.call(type + '.get', () => cs[type].get({ primaryUrl }))
    await t.callback(type + '.getResourceIdentifiers.callback', (cb) => cs[type].getResourceIdentifiers(cb))
  }
  await t.callback('getResourceIdentifiers.callback', (cb) => cs.images.getResourceIdentifiers(cb))
})

// ---------------------------------------------------------------- fontSettings
suite('fontSettings', async (t) => {
  const fs = chrome.fontSettings
  await t.call('getFont', () => fs.getFont({ genericFamily: 'standard' }), (f) => ({ shape: probe.shape(f), levelOfControl: f.levelOfControl }))
  await t.call('setFont', () => fs.setFont({ genericFamily: 'standard', fontId: 'Arial' }))
  await t.call('getFont.after', () => fs.getFont({ genericFamily: 'standard' }), (f) => f.fontId)
  await t.call('clearFont', () => fs.clearFont({ genericFamily: 'standard' }))
  await t.call('getFontList', () => fs.getFontList(), (l) => ({ isArray: Array.isArray(l), shape: l.length ? probe.shape(l[0]) : 'empty' }))
  await t.call('getDefaultFontSize', () => fs.getDefaultFontSize(), (s) => ({ shape: probe.shape(s), pixelSize: s.pixelSize }))
  await t.call('setDefaultFontSize', () => fs.setDefaultFontSize({ pixelSize: 18 }))
  await t.call('getDefaultFontSize.after', () => fs.getDefaultFontSize(), (s) => s.pixelSize)
  await t.call('clearDefaultFontSize', () => fs.clearDefaultFontSize())
  await t.call('getMinimumFontSize', () => fs.getMinimumFontSize(), (s) => s.pixelSize)
  await t.call('getDefaultFixedFontSize', () => fs.getDefaultFixedFontSize(), (s) => s.pixelSize)
  await t.call('setDefaultFontSize.tooBig', () => fs.setDefaultFontSize({ pixelSize: 500 }))
  await t.call('getDefaultFontSize.big', () => fs.getDefaultFontSize(), (s) => s.pixelSize)
  await fs.clearDefaultFontSize()
  await t.call('getFont.badFamily', () => fs.getFont({ genericFamily: 'bogus' }))
  await t.call('getFont.noArgs', () => fs.getFont())
  await t.call('getFont.extraProp', () => fs.getFont({ genericFamily: 'standard', foo: 1 }))
  await t.call('setFont.noFontId', () => fs.setFont({ genericFamily: 'serif' }))
  await t.call('setFont.numberFontId', () => fs.setFont({ genericFamily: 'serif', fontId: 5 }))
  await t.event('onFontChanged', fs.onFontChanged, () => fs.setFont({ genericFamily: 'serif', fontId: 'NoSuchFontX' }), { map: (d) => d })
  await t.call('getFont.unknownFont', () => fs.getFont({ genericFamily: 'serif' }))
  await t.event('onFontChanged.clear', fs.onFontChanged, () => fs.clearFont({ genericFamily: 'serif' }), { map: (d) => ({ keys: Object.keys(d).sort(), genericFamily: d.genericFamily, script: d.script, levelOfControl: d.levelOfControl }) })
  await t.event('onFontChanged.script', fs.onFontChanged, () => fs.setFont({ genericFamily: 'sansserif', script: 'Arab', fontId: 'Arial' }), { map: (d) => d })
  await t.call('getFont.script', () => fs.getFont({ genericFamily: 'sansserif', script: 'Arab' }))
  await t.call('clearFont.script', () => fs.clearFont({ genericFamily: 'sansserif', script: 'Arab' }))
  await t.call('setFont.empty', () => fs.setFont({ genericFamily: 'cursive', fontId: '' }))
  await t.call('getFont.empty', () => fs.getFont({ genericFamily: 'cursive' }))
  await fs.clearFont({ genericFamily: 'cursive' })
  await t.call('size.string', () => fs.setDefaultFontSize({ pixelSize: 'x' }))
  await t.call('size.fraction', () => fs.setDefaultFontSize({ pixelSize: 1.5 }))
  await t.call('size.missing', () => fs.setDefaultFontSize({}))
  await t.call('size.getExtraProp', () => fs.getDefaultFontSize({ foo: 1 }))
  await t.call('size.negative', () => fs.setDefaultFontSize({ pixelSize: -3 }))
  await t.call('size.negative.get', () => fs.getDefaultFontSize({}))
  await t.event('onDefaultFontSizeChanged', fs.onDefaultFontSizeChanged, () => fs.setDefaultFontSize({ pixelSize: 20 }), { map: (d) => d })
  await t.event('onDefaultFontSizeChanged.clear', fs.onDefaultFontSizeChanged, () => fs.clearDefaultFontSize(), { map: (d) => d })
  await t.event('onMinimumFontSizeChanged', fs.onMinimumFontSizeChanged, () => fs.setMinimumFontSize({ pixelSize: 30 }), { map: (d) => d })
  await t.call('getMinimumFontSize.after', () => fs.getMinimumFontSize())
  await t.event('onMinimumFontSizeChanged.clear', fs.onMinimumFontSizeChanged, () => fs.clearMinimumFontSize(), { map: (d) => d })
  await t.event('onDefaultFixedFontSizeChanged', fs.onDefaultFixedFontSizeChanged, () => fs.setDefaultFixedFontSize({ pixelSize: 15 }), { map: (d) => d })
  await t.call('getDefaultFixedFontSize.after', () => fs.getDefaultFixedFontSize())
  await t.call('clearDefaultFixedFontSize', () => fs.clearDefaultFixedFontSize())
  await t.call('getDefaultFixedFontSize.cleared', () => fs.getDefaultFixedFontSize())
})

// ---------------------------------------------------------------- privacy
suite('privacy', async (t, env) => {
  const settings = {
    network: ['networkPredictionEnabled', 'webRTCIPHandlingPolicy'],
    services: ['alternateErrorPagesEnabled', 'autofillAddressEnabled', 'autofillCreditCardEnabled', 'passwordSavingEnabled', 'safeBrowsingEnabled', 'safeBrowsingExtendedReportingEnabled', 'searchSuggestEnabled', 'spellingServiceEnabled', 'translationServiceEnabled'],
    websites: ['adMeasurementEnabled', 'doNotTrackEnabled', 'fledgeEnabled', 'hyperlinkAuditingEnabled', 'protectedContentEnabled', 'referrersEnabled', 'relatedWebsiteSetsEnabled', 'thirdPartyCookiesAllowed', 'topicsEnabled'],
  }
  for (const [group, names] of Object.entries(settings)) {
    for (const name of names) {
      const s = chrome.privacy[group] && chrome.privacy[group][name]
      if (!s) {
        t.set(`${group}.${name}`, 'absent')
        continue
      }
      await t.call(`${group}.${name}`, () => s.get({}))
    }
  }
  const webrtc = chrome.privacy.network.webRTCIPHandlingPolicy
  await t.event('onChange', webrtc.onChange, () => webrtc.set({ value: 'disable_non_proxied_udp' }), { map: (d) => d })
  await t.call('webrtc.after', () => webrtc.get({}))
  await t.call('webrtc.badValue', () => webrtc.set({ value: 'whatever' }))
  await t.call('webrtc.clear', () => webrtc.clear({}))
  await t.call('webrtc.cleared', () => webrtc.get({}))
  await t.call('dnt.set', () => chrome.privacy.websites.doNotTrackEnabled.set({ value: true }))
  await t.call('dnt.header', () => fetch(env.base + 'echo-headers').then((r) => r.json()).then((h) => h.dnt || 'none'))
  await t.call('dnt.clear', () => chrome.privacy.websites.doNotTrackEnabled.clear({}))
  await t.call('incognitoScope', () => chrome.privacy.network.networkPredictionEnabled.set({ value: false, scope: 'incognito_session_only' }))
  const P = chrome.privacy
  await t.call('services.autofillEnabled', () => P.services.autofillEnabled.get({}))
  await t.call('services.autofillSettings', () => P.services.autofillSettings.get({}))
  const np = P.network.networkPredictionEnabled
  await t.call('set.badType', () => np.set({ value: 'yes' }))
  await t.call('set.noValue', () => np.set({}))
  await t.call('set.noArgs', () => np.set())
  await t.call('set.extraProp', () => np.set({ value: true, foo: 1 }))
  await t.call('set.badScope', () => np.set({ value: true, scope: 'bogus' }))
  await t.call('get.noArgs', () => np.get())
  await t.call('get.extraProp', () => np.get({ foo: 1 }))
  await t.call('get.incognito', () => np.get({ incognito: true }))
  await t.call('set.incognitoPersistent', () => np.set({ value: true, scope: 'incognito_persistent' }))
  await t.call('clear.incognito', () => np.clear({ scope: 'incognito_persistent' }))
  await t.call('regularOnly.set', () => np.set({ value: false, scope: 'regular_only' }))
  await t.call('regularOnly.get', () => np.get({}))
  await t.call('regularOnly.clearRegular', () => np.clear({}))
  await t.call('regularOnly.stillSet', () => np.get({}))
  await t.call('regularOnly.clear', () => np.clear({ scope: 'regular_only' }))
  await t.call('regularOnly.cleared', () => np.get({}))
  await t.event('onChange.sameAsDefault', webrtc.onChange, () => webrtc.set({ value: 'default' }), { map: (d) => d, filter: (d) => d.levelOfControl === 'controlled_by_this_extension' })
  await t.event('onChange.setAgain', webrtc.onChange, () => webrtc.set({ value: 'default' }), { map: (d) => d, timeout: 1500 })
  await t.event('onChange.clear', webrtc.onChange, () => webrtc.clear({}), { map: (d) => d, filter: (d) => d.levelOfControl === 'controllable_by_this_extension' })
  await t.event('onChange.clearAgain', webrtc.onChange, () => webrtc.clear({}), { map: (d) => d, timeout: 1500 })
  await t.call('autofillEnabled.set', () => P.services.autofillEnabled.set({ value: false }))
  await t.call('autofillEnabled.sharesAddress', () => P.services.autofillAddressEnabled.get({}))
  await t.call('autofillEnabled.clear', () => P.services.autofillEnabled.clear({}))
  const blocked = [{ urlPattern: 'https://a.example/*', blockedTypes: ['payments', 'contact_info'] }]
  await t.call('autofillSettings.set', () => P.services.autofillSettings.set({ value: blocked }))
  await t.call('autofillSettings.get', () => P.services.autofillSettings.get({}))
  await t.call('autofillSettings.badValue', () => P.services.autofillSettings.set({ value: ['payments'] }))
  await t.call('autofillSettings.badType', () => P.services.autofillSettings.set({ value: [{ urlPattern: 'https://a.example/*', blockedTypes: ['everything'] }] }))
  await t.call('autofillSettings.clear', () => P.services.autofillSettings.clear({}))
  for (const name of ['topicsEnabled', 'fledgeEnabled', 'adMeasurementEnabled']) {
    await t.call('sandbox.' + name + '.on', () => P.websites[name].set({ value: true }))
    await t.call('sandbox.' + name + '.off', () => P.websites[name].set({ value: false }))
    await t.call('sandbox.' + name + '.get', () => P.websites[name].get({}))
    await P.websites[name].clear({})
  }
  await t.call('referrers.set', () => P.websites.referrersEnabled.set({ value: false }))
  await t.call('referrers.header', () => fetch(env.base + 'echo-headers').then((r) => r.json()).then((h) => h.referer || 'none'))
  await t.call('referrers.clear', () => P.websites.referrersEnabled.clear({}))
  await t.call('dnt.header.cleared', () => fetch(env.base + 'echo-headers').then((r) => r.json()).then((h) => h.dnt || 'none'))
})

// ---------------------------------------------------------------- proxy
suite('proxy', async (t) => {
  await t.call('get', () => chrome.proxy.settings.get({}))
  await t.event('onChange', chrome.proxy.settings.onChange, () => chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 9 }, bypassList: ['<-loopback>', '127.0.0.1'] } }, scope: 'regular' }), { map: (d) => ({ levelOfControl: d.levelOfControl, mode: d.value.mode }) })
  await t.call('get.after', () => chrome.proxy.settings.get({}), (d) => ({ levelOfControl: d.levelOfControl, value: d.value }))
  await t.call('set.badMode', () => chrome.proxy.settings.set({ value: { mode: 'sideways' } }))
  await t.call('clear', () => chrome.proxy.settings.clear({}))
  await t.call('get.cleared', () => chrome.proxy.settings.get({}))
  const ps = chrome.proxy.settings
  const proxyTry = async (name, value) => {
    await t.call(name + '.set', () => ps.set({ value }))
    await t.call(name + '.get', () => ps.get({}), (d) => ({ levelOfControl: d.levelOfControl, value: d.value }))
    await ps.clear({})
  }
  // Ports 9 and 1 are closed, so nothing leaves the machine while a proxy is set.
  await proxyTry('noRules', { mode: 'fixed_servers' })
  await proxyTry('emptyRules', { mode: 'fixed_servers', rules: { bypassList: ['a.example'] } })
  await proxyTry('noSchemeOrPort', { mode: 'fixed_servers', rules: { singleProxy: { host: '127.0.0.1' } } })
  await proxyTry('perScheme', { mode: 'fixed_servers', rules: { proxyForHttp: { host: '127.0.0.1', port: 9 }, proxyForHttps: { scheme: 'https', host: '127.0.0.1' }, proxyForFtp: { scheme: 'socks4', host: '127.0.0.1', port: 9 }, fallbackProxy: { scheme: 'socks5', host: '127.0.0.1' } } })
  await proxyTry('quic', { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'quic', host: '127.0.0.1', port: 9 } } })
  await proxyTry('ipv6', { mode: 'fixed_servers', rules: { singleProxy: { host: '::1', port: 9 } } })
  await proxyTry('singleAndPerScheme', { mode: 'fixed_servers', rules: { singleProxy: { host: '127.0.0.1' }, proxyForHttps: { host: '127.0.0.1' } } })
  await proxyTry('emptyHost', { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '' } } })
  await proxyTry('unicodeHost', { mode: 'fixed_servers', rules: { singleProxy: { host: '\u00e4.example' } } })
  await proxyTry('stringPort', { mode: 'fixed_servers', rules: { singleProxy: { host: '127.0.0.1', port: '9' } } })
  await proxyTry('badScheme', { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'ftp', host: '127.0.0.1' } } })
  await proxyTry('bypassNotArray', { mode: 'fixed_servers', rules: { singleProxy: { host: '127.0.0.1' }, bypassList: 'x' } })
  await proxyTry('pacData', { mode: 'pac_script', pacScript: { data: 'function FindProxyForURL(u, h) { return "DIRECT" }' } })
  await proxyTry('pacUrl', { mode: 'pac_script', pacScript: { url: 'http://127.0.0.1:1/p.pac', mandatory: true } })
  await proxyTry('pacBoth', { mode: 'pac_script', pacScript: { url: 'http://127.0.0.1:1/p.pac', data: 'x' } })
  await proxyTry('pacNone', { mode: 'pac_script' })
  await proxyTry('pacEmpty', { mode: 'pac_script', pacScript: { data: '' } })
  await proxyTry('directWithRules', { mode: 'direct', rules: { singleProxy: { host: '127.0.0.1' } } })
  await proxyTry('autoDetect', { mode: 'auto_detect' })
  await proxyTry('noMode', {})
  await proxyTry('extraProp', { mode: 'direct', foo: 1 })
  await t.call('set.noValue', () => ps.set({}))
  await t.call('set.incognito', () => ps.set({ value: { mode: 'direct' }, scope: 'incognito_persistent' }))
  await t.call('get.incognito', () => ps.get({ incognito: true }))
  await ps.set({ value: { mode: 'direct' } })
  await t.event('onChange.clear', ps.onChange, () => ps.clear({}), { map: (d) => d, filter: (d) => d.levelOfControl === 'controllable_by_this_extension' })
})

// ---------------------------------------------------------------- search, omnibox, readingList
suite('search', async (t) => {
  await t.event('query', chrome.tabs.onCreated, () => chrome.search.query({ text: 'probe words', disposition: 'NEW_TAB' }), { map: () => 'tab created' })
  const tabs = await chrome.tabs.query({})
  const searchTab = tabs.find((x) => (x.url || x.pendingUrl || '').includes('probe'))
  if (searchTab) await closeTabs([searchTab.id])
  await t.call('query.badDisposition', () => chrome.search.query({ text: 'x', disposition: 'SIDEWAYS' }))
  await t.call('query.empty', () => chrome.search.query({ text: '' }))
  await t.call('query.noText', () => chrome.search.query({}))
  await t.call('query.badText', () => chrome.search.query({ text: 5 }))
  await t.call('query.tabAndDisposition', () => chrome.search.query({ text: 'x', tabId: 1, disposition: 'NEW_TAB' }))
  await t.call('query.missingTab', () => chrome.search.query({ text: 'x', tabId: 987654 }))
  await t.call('query.badTab', () => chrome.search.query({ text: 'x', tabId: 'one' }))
})

suite('omnibox', async (t) => {
  await t.call('setDefaultSuggestion', () => chrome.omnibox.setDefaultSuggestion({ description: 'Run <match>probe</match>' }))
  await t.call('setDefaultSuggestion.badXml', () => chrome.omnibox.setDefaultSuggestion({ description: 'Run <match>probe' }))
  const xml = {
    styles: '<url>u</url> <dim>d</dim> &amp; &lt; &gt; &quot; &apos; &#65; &#x42;',
    nested: '<match><dim>x</dim></match>',
    unknownTag: '<b>bold</b> <match a="1">x</match>',
    badEntity: 'a &foo; b',
    bareAmp: 'a & b',
    bareLt: 'a < b',
    strayClose: 'a </dim> b',
    unclosedTwo: '<match><dim>x',
    badAttr: '<match a=1>x</match>',
    long: 'x'.repeat(100) + ' <match>',
    longBefore: 'y'.repeat(30) + '</dim>' + 'z'.repeat(70),
    multiline: 'line one\n<match>two',
    cdata: '<![CDATA[a<b]]>',
    comment: 'a <!-- c --> b',
    empty: '',
    noSemicolon: 'a &amp b',
    badHexRef: 'a &#xZZ; b',
    zeroRef: 'a &#0; b',
    cdataEnd: 'a ]]> b',
    control: 'a \u0001 b',
    selfClosing: '<match/> x',
    closeFirst: '</match> x',
    digitTag: '<1x>',
    attrNoValue: 'a <match b>x</match>',
    attrTwice: '<match a="1" a="2">x</match>',
    openComment: 'a <!-- c',
    openCdata: 'a <![CDATA[x',
    pi: 'a <?pi x?> b',
    twoAmps: 'a & b & c',
    twoEntities: '&foo; &bar;',
    ampThenMismatch: 'a & b </dim>',
    endNoGt: '<match>x</match',
    longEntity: 'x'.repeat(100) + '&foo;',
    tab: 'a\t</dim>',
    unicode: '\u00e9\u4e2d <match>',
  }
  for (const [name, description] of Object.entries(xml)) {
    await t.call('setDefaultSuggestion.' + name, () => chrome.omnibox.setDefaultSuggestion({ description }))
  }
  await t.call('setDefaultSuggestion.missing', () => chrome.omnibox.setDefaultSuggestion({}))
  await t.call('setDefaultSuggestion.content', () => chrome.omnibox.setDefaultSuggestion({ description: 'x', content: 'y' }))
  await t.call('setDefaultSuggestion.badType', () => chrome.omnibox.setDefaultSuggestion({ description: 5 }))
  await t.call('sendSuggestions.returns', () => typeof chrome.omnibox.sendSuggestions(123456, [{ content: 'a', description: 'b' }]))
  await t.call('sendSuggestions.badXml', () => chrome.omnibox.sendSuggestions(123456, [{ content: 'a', description: 'b <match>' }]))
  await t.call('sendSuggestions.missingContent', () => chrome.omnibox.sendSuggestions(123456, [{ description: 'b' }]))
  await t.call('sendSuggestions.badId', () => chrome.omnibox.sendSuggestions('x', []))
  await t.call('setDefaultSuggestion.returns', () => {
    const r = chrome.omnibox.setDefaultSuggestion({ description: 'Run <match>probe</match>' })
    return r && typeof r.then === 'function' ? 'promise' : typeof r
  })
})

suite('readingList', async (t, env) => {
  const url = env.base + 'page?read'
  await t.event('onEntryAdded', chrome.readingList.onEntryAdded, () => chrome.readingList.addEntry({ title: 'Probe read', url, hasBeenRead: false }), { map: (e) => ({ shape: probe.shape(e), title: e.title }) })
  await t.call('addEntry.duplicate', () => chrome.readingList.addEntry({ title: 'Again', url, hasBeenRead: false }))
  await t.call('addEntry.badUrl', () => chrome.readingList.addEntry({ title: 'Bad', url: 'chrome://settings', hasBeenRead: false }))
  await t.call('query', () => chrome.readingList.query({ url }), (r) => r.map((e) => ({ title: e.title, hasBeenRead: e.hasBeenRead })))
  await t.event('onEntryUpdated', chrome.readingList.onEntryUpdated, () => chrome.readingList.updateEntry({ url, hasBeenRead: true, title: 'Read' }), { map: (e) => ({ title: e.title, hasBeenRead: e.hasBeenRead }) })
  await t.call('updateEntry.missing', () => chrome.readingList.updateEntry({ url: env.base + 'nope', hasBeenRead: true }))
  await t.event('onEntryRemoved', chrome.readingList.onEntryRemoved, () => chrome.readingList.removeEntry({ url }), { map: (e) => e.title })
  await t.call('removeEntry.missing', () => chrome.readingList.removeEntry({ url }))

  // Edge cases and the errors Chrome gives for them.
  const other = env.base + 'page?read2'
  await t.call('addEntry.file', () => chrome.readingList.addEntry({ title: 'f', url: 'file:///tmp/probe', hasBeenRead: false }))
  await t.call('addEntry.javascript', () => chrome.readingList.addEntry({ title: 'j', url: 'javascript:void(0)', hasBeenRead: false }))
  await t.call('addEntry.notUrl', () => chrome.readingList.addEntry({ title: 'n', url: 'not a url', hasBeenRead: false }))
  await t.call('addEntry.noTitle', () => chrome.readingList.addEntry({ url: other, hasBeenRead: false }))
  await t.call('addEntry.noRead', () => chrome.readingList.addEntry({ title: 'r', url: other }))
  await t.call('addEntry.badType', () => chrome.readingList.addEntry({ title: 5, url: other, hasBeenRead: false }))
  const seen = []
  let watching = true
  const onUpdated = (e) => watching && seen.push({ shape: probe.shape(e), title: e.title, hasBeenRead: e.hasBeenRead })
  // What an entry added as read sends, with the listeners added first and
  // time for every event to arrive before the next test listens.
  // The flag, not removeListener, ends the recording: this tests the events.
  const addEvents = []
  let adding = true
  const onAdd = (e) => adding && addEvents.push({ event: 'added', hasBeenRead: e.hasBeenRead })
  const onAddUpdate = (e) => adding && addEvents.push({ event: 'updated', hasBeenRead: e.hasBeenRead })
  chrome.readingList.onEntryAdded.addListener(onAdd)
  chrome.readingList.onEntryUpdated.addListener(onAddUpdate)
  await t.call('addEntry.read', () => chrome.readingList.addEntry({ title: 'Probe read 2', url: other, hasBeenRead: true }))
  await probe.sleep(500)
  adding = false
  chrome.readingList.onEntryAdded.removeListener(onAdd)
  chrome.readingList.onEntryUpdated.removeListener(onAddUpdate)
  t.set('addEntry.read.events', addEvents)
  await t.call('query.all', () => chrome.readingList.query({}), (r) => r.filter((e) => e.url.startsWith(env.base)).map((e) => ({ shape: probe.shape(e), title: e.title, hasBeenRead: e.hasBeenRead, url: e.url.replace(env.base, '/') })))
  await t.call('query.read', () => chrome.readingList.query({ hasBeenRead: true }), (r) => r.filter((e) => e.url.startsWith(env.base)).length)
  await t.call('query.unread', () => chrome.readingList.query({ hasBeenRead: false }), (r) => r.filter((e) => e.url.startsWith(env.base)).length)
  await t.call('query.title', () => chrome.readingList.query({ title: 'Probe read 2' }), (r) => r.length)
  await t.call('query.titlePart', () => chrome.readingList.query({ title: 'Probe' }), (r) => r.length)
  await t.call('query.badUrl', () => chrome.readingList.query({ url: 'not a url' }), (r) => r.length)
  chrome.readingList.onEntryUpdated.addListener(onUpdated)
  await t.call('updateEntry.both', () => chrome.readingList.updateEntry({ url: other, title: 'Probe read 3', hasBeenRead: false }))
  await probe.sleep(500)
  t.set('onEntryUpdated.both', seen.splice(0))
  await t.call('updateEntry.titleOnly', () => chrome.readingList.updateEntry({ url: other, title: 'Probe read 4' }))
  await probe.sleep(300)
  t.set('onEntryUpdated.titleOnly', seen.splice(0))
  await t.call('updateEntry.sameValues', () => chrome.readingList.updateEntry({ url: other, title: 'Probe read 4', hasBeenRead: false }))
  await probe.sleep(300)
  t.set('onEntryUpdated.sameValues', seen.splice(0))
  watching = false
  chrome.readingList.onEntryUpdated.removeListener(onUpdated)
  await t.call('updateEntry.nothing', () => chrome.readingList.updateEntry({ url: other }))
  await t.call('updateEntry.badUrl', () => chrome.readingList.updateEntry({ url: 'chrome://settings', hasBeenRead: true }))
  await t.call('removeEntry.badUrl', () => chrome.readingList.removeEntry({ url: 'not a url' }))
  await t.event('onEntryRemoved.shape', chrome.readingList.onEntryRemoved, () => chrome.readingList.removeEntry({ url: other }), {
    map: (e) => ({ shape: probe.shape(e), title: e.title, hasBeenRead: e.hasBeenRead }),
  })
  await t.call('query.end', () => chrome.readingList.query({}), (r) => r.filter((e) => e.url.startsWith(env.base)).length)
})

// ---------------------------------------------------------------- tts
suite('tts', async (t) => {
  await t.call('getVoices', () => chrome.tts.getVoices(), (v) => Array.isArray(v))
  await t.call('isSpeaking', () => chrome.tts.isSpeaking())
  await t.call('speak', () => chrome.tts.speak('probe', { rate: 3, volume: 0 }))
  await t.call('stop', () => chrome.tts.stop())
  await t.call('speak.badRate', () => chrome.tts.speak('probe', { rate: 50 }))
})

// ---------------------------------------------------------------- offscreen
suite('offscreen', async (t) => {
  await t.call('hasDocument', () => chrome.offscreen.hasDocument())
  await t.call('createDocument', () => chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'probe' }))
  await t.call('hasDocument.after', () => chrome.offscreen.hasDocument())
  await t.call('getContexts', () => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }), (c) => c.length)
  await t.call('message', () => chrome.runtime.sendMessage({ offscreen: 'ping' }))
  await t.call('createDocument.second', () => chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'probe' }))
  await t.call('closeDocument', () => chrome.offscreen.closeDocument())
  await t.call('closeDocument.none', () => chrome.offscreen.closeDocument())
  await t.call('createDocument.badReason', () => chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['NOT_A_REASON'], justification: 'probe' }))
  await t.call('createDocument.badUrl', () => chrome.offscreen.createDocument({ url: 'https://example.com/', reasons: ['DOM_PARSER'], justification: 'probe' }))
})

// ---------------------------------------------------------------- sidePanel, commands
suite('sidePanel', async (t, env) => {
  await t.call('getOptions', () => chrome.sidePanel.getOptions({}))
  await t.call('getPanelBehavior', () => chrome.sidePanel.getPanelBehavior())
  await t.call('setPanelBehavior', () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
  await t.call('getPanelBehavior.after', () => chrome.sidePanel.getPanelBehavior())
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  const tab = await openTab(env.base + 'page?panel')
  await t.call('setOptions.tab', () => chrome.sidePanel.setOptions({ tabId: tab.id, path: 'options.html', enabled: true }))
  await t.call('getOptions.tab', () => chrome.sidePanel.getOptions({ tabId: tab.id }), (o) => Object.assign({}, o, { tabId: o.tabId === tab.id }))
  await t.call('setOptions.missingTab', () => chrome.sidePanel.setOptions({ tabId: MISSING_TAB, enabled: false }))
  await t.call('open.noGesture', async () => chrome.sidePanel.open({ windowId: (await chrome.windows.getLastFocused()).id }))
  if (chrome.sidePanel.getLayout) await t.call('getLayout', () => chrome.sidePanel.getLayout())
  await closeTabs([tab.id])
})

suite('commands', async (t) => {
  await t.call('getAll', () => chrome.commands.getAll(), (all) => all.map((c) => ({ name: c.name, description: c.description, shape: probe.shape(c) })).sort((a, b) => a.name.localeCompare(b.name)))
})

// ---------------------------------------------------------------- identity
suite('identity', async (t, env) => {
  t.set('getRedirectURL', chrome.identity.getRedirectURL() === `https://${chrome.runtime.id}.chromiumapp.org/`)
  t.set('getRedirectURL.path', chrome.identity.getRedirectURL('cb') === `https://${chrome.runtime.id}.chromiumapp.org/cb`)
  await t.call('launchWebAuthFlow', () => chrome.identity.launchWebAuthFlow({ url: env.base + 'oauth?id=' + chrome.runtime.id, interactive: false }), (u) => u && u.replace(chrome.runtime.id, '<id>'))
  await t.call('launchWebAuthFlow.needsUser', () => chrome.identity.launchWebAuthFlow({ url: env.base + 'page?login', interactive: false }))
  await t.call('getProfileUserInfo', () => chrome.identity.getProfileUserInfo({}))
  await t.call('getAuthToken', () => chrome.identity.getAuthToken({ interactive: false }))
  await t.call('clearAllCachedAuthTokens', () => chrome.identity.clearAllCachedAuthTokens())
  await t.call('getAccounts', () => chrome.identity.getAccounts && chrome.identity.getAccounts())
})

// ---------------------------------------------------------------- debugger
suite('debugger', async (t, env) => {
  const tab = await openTab(env.base + 'page?debugger')
  const target = { tabId: tab.id }
  await t.call('getTargets', () => chrome.debugger.getTargets(), (all) => ({ shape: probe.shape(all.find((x) => x.tabId === tab.id)), hasTab: all.some((x) => x.tabId === tab.id) }))
  await t.call('attach.badVersion', () => chrome.debugger.attach(target, '0.1'))
  await t.call('attach', () => chrome.debugger.attach(target, '1.3'))
  await t.call('attach.again', () => chrome.debugger.attach(target, '1.3'))
  await t.call('sendCommand', () => chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: '20 + 22', returnByValue: true }), (r) => r.result.value)
  await t.call('sendCommand.bad', () => chrome.debugger.sendCommand(target, 'Nope.nothing', {}))
  await t.event('onEvent', chrome.debugger.onEvent, async () => {
    await chrome.debugger.sendCommand(target, 'Page.enable', {})
    await chrome.debugger.sendCommand(target, 'Page.reload', {})
  }, { filter: (source, method) => method === 'Page.loadEventFired', map: (source, method) => ({ source: probe.shape(source), method }) })
  await t.event('onDetach', chrome.debugger.onDetach, () => chrome.scripting.executeScript({ target, world: 'MAIN', func: () => 1 }).then(() => chrome.debugger.detach(target)), { timeout: 1000, map: (s, r) => r })
  await t.call('detach.again', () => chrome.debugger.detach(target))
  await t.call('attach.missingTab', () => chrome.debugger.attach({ tabId: MISSING_TAB }, '1.3'))
  await closeTabs([tab.id])
})

// ---------------------------------------------------------------- pageCapture, tabCapture
suite('capture', async (t, env) => {
  const tab = await openTab(env.base + 'page?capture')
  await t.call('saveAsMHTML', () => chrome.pageCapture.saveAsMHTML({ tabId: tab.id }), (blob) => blob && { type: Object.prototype.toString.call(blob), size: blob.size > 0 })
  await t.call('saveAsMHTML.missing', () => chrome.pageCapture.saveAsMHTML({ tabId: MISSING_TAB }))
  await t.call('tabCapture.getMediaStreamId', () => chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }), (id) => typeof id)
  await t.call('tabCapture.getMediaStreamId.missing', () => chrome.tabCapture.getMediaStreamId({ targetTabId: MISSING_TAB }))
  await t.call('tabCapture.getCapturedTabs', () => chrome.tabCapture.getCapturedTabs())
  await closeTabs([tab.id])
})

// ---------------------------------------------------------------- userScripts
suite('userScripts', async (t, env) => {
  let available
  try {
    available = typeof chrome.userScripts
    t.set('typeof', available)
  } catch (e) {
    t.set('typeof', 'throws: ' + probe.errorMessage(e))
    return
  }
  if (available !== 'object') return
  await t.call('getScripts', () => chrome.userScripts.getScripts())
  await t.call('configureWorld', () => chrome.userScripts.configureWorld({ messaging: true }))
  await t.call('register', () => chrome.userScripts.register([{ id: 'us', matches: [env.base + 'page?us*'], js: [{ code: 'document.documentElement.dataset.userScript = "ran"' }] }]))
  await t.call('register.duplicate', () => chrome.userScripts.register([{ id: 'us', matches: [env.base + '*'], js: [{ code: '1' }] }]))
  await t.call('getScripts.after', () => chrome.userScripts.getScripts(), (all) => all.map((s) => ({ id: s.id, shape: probe.shape(s) })))
  const tab = await openTab(env.base + 'page?us')
  await t.call('ran', () => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.dataset.userScript || 'no' }), (r) => r[0].result)
  if (chrome.userScripts.execute) await t.call('execute', () => chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: '6 * 7' }] }), (r) => r.map((x) => x.result))
  await t.call('update', () => chrome.userScripts.update([{ id: 'us', matches: [env.base + 'page?us2*'] }]))
  await t.call('unregister', () => chrome.userScripts.unregister({ ids: ['us'] }))
  await t.call('getScripts.final', () => chrome.userScripts.getScripts())
  await closeTabs([tab.id])
})

// ---------------------------------------------------------------- declarativeContent
suite('declarativeContent', async (t) => {
  const dc = chrome.declarativeContent
  await t.callback('removeRules', (cb) => dc.onPageChanged.removeRules(undefined, cb))
  await t.callback('addRules', (cb) => dc.onPageChanged.addRules([{
    id: 'probe',
    conditions: [new dc.PageStateMatcher({ pageUrl: { hostEquals: '127.0.0.1' } })],
    actions: [new dc.ShowAction()],
  }], cb))
  await t.callback('getRules', (cb) => dc.onPageChanged.getRules(cb))
  await t.callback('removeRules.one', (cb) => dc.onPageChanged.removeRules(['probe'], cb))
})

// ---------------------------------------------------------------- extension
suite('extension', async (t) => {
  t.set('inIncognitoContext', chrome.extension.inIncognitoContext)
  await t.call('isAllowedIncognitoAccess', () => chrome.extension.isAllowedIncognitoAccess())
  await t.call('isAllowedFileSchemeAccess', () => chrome.extension.isAllowedFileSchemeAccess())
  t.set('getViews', typeof chrome.extension.getViews)
  t.set('getBackgroundPage', typeof chrome.extension.getBackgroundPage)
  t.set('getURL', typeof chrome.extension.getURL)
})

// ---------------------------------------------------------------- content script
// Reads what content.js recorded in the page it ran in.
suite('contentScript', async (t, env) => {
  // What content.js finds in storage.session depends on this, which the
  // storage suite sets too: set here, so the result does not depend on order.
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  const tab = await openTab(env.base + 'page?content')
  const read = async () => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.documentElement.dataset.probe || null })
    return r.result && JSON.parse(r.result)
  }
  const recorded = await waitFor(read, 5000)
  t.set('recorded', recorded || 'nothing')
  await closeTabs([tab.id])
})

// ---------------------------------------------------------------- management toggle (last: it disables the peer)
suite('management.toggle', async (t) => {
  await t.event('onDisabled', chrome.management.onDisabled, () => chrome.management.setEnabled(PEER_ID, false), { map: (e) => ({ id: e.id === PEER_ID, enabled: e.enabled }) })
  await t.call('get.disabled', () => chrome.management.get(PEER_ID), (e) => ({ enabled: e.enabled, disabledReason: e.disabledReason }))
  await t.event('onEnabled', chrome.management.onEnabled, () => chrome.management.setEnabled(PEER_ID, true), { map: (e) => ({ id: e.id === PEER_ID, enabled: e.enabled }) })
})
