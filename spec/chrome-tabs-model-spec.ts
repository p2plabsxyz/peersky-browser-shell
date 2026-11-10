import { expect } from 'chai'
import { EventEmitter } from 'node:events'

import { TabsAPI, globMatch, prepareNavigationUrl } from '../src/browser/api/tabs'
import { WindowsAPI } from '../src/browser/api/windows'
import { SessionsAPI } from '../src/browser/api/sessions'
import { TabGroupsAPI } from '../src/browser/api/tab-groups'
import { ExtensionStore } from '../src/browser/store'
import { ExtensionPermissions } from '../src/browser/permissions'

// A tab and a window as the host gives them, without Electron behind them.
class FakeTab extends EventEmitter {
  url = ''
  title = ''
  loading = false
  muted = false
  zoom = 1
  destroyed = false
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} }
  constructor(public id: number) {
    super()
  }
  getURL() {
    return this.url
  }
  getTitle() {
    return this.title || this.url
  }
  isLoading() {
    return this.loading
  }
  isCurrentlyAudible() {
    return false
  }
  isAudioMuted() {
    return this.muted
  }
  setAudioMuted(muted: boolean) {
    this.muted = muted
  }
  isDestroyed() {
    return this.destroyed
  }
  getType() {
    return 'window'
  }
  getZoomFactor() {
    return this.zoom
  }
  setZoomFactor(zoom: number) {
    this.zoom = zoom
  }
  reload() {}
  reloadIgnoringCache() {}
  async loadURL(url: string) {
    this.emit('did-start-loading')
    this.url = url
    this.emit('did-navigate', {}, url)
    this.emit('did-stop-loading')
  }
  navigate(url: string, title: string) {
    this.url = url
    this.title = title
    this.emit('did-navigate', {}, url)
    this.emit('page-title-updated')
  }
  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  bounds = { x: 10, y: 20, width: 800, height: 600 }
  constructor(public id: number) {
    super()
  }
  isDestroyed() {
    return this.destroyed
  }
  getContentSize() {
    return [this.bounds.width, this.bounds.height]
  }
  getBounds() {
    return { ...this.bounds }
  }
  setBounds(b: any) {
    Object.assign(this.bounds, b)
  }
  isFocused() {
    return false
  }
  isAlwaysOnTop() {
    return false
  }
  isFullScreen() {
    return false
  }
  isMinimized() {
    return false
  }
  isMaximized() {
    return false
  }
  minimize() {}
  maximize() {}
  restore() {}
  unmaximize() {}
  setFullScreen() {}
  focus() {}
  blur() {}
  flashFrame() {}
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

const ext = (id: string, permissions: string[], hosts: string[] = []): any => ({
  id,
  name: id,
  url: `chrome-extension://${id}/`,
  manifest: { manifest_version: 3, permissions, host_permissions: hosts },
})

const TABS = ext('tabsext', ['tabs', 'tabGroups', 'sessions'])
const HOST = ext('hostext', ['storage'], ['https://a.example/*'])
const NONE = ext('noneext', ['storage'])
const EXTENSIONS = [TABS, HOST, NONE]

const setup = () => {
  const handlers = new Map<string, Function>()
  const events: Array<{ name: string; to?: string; args: any[] }> = []
  const hostEvents: Array<{ name: string; args: any[] }> = []
  const groupHook: any[] = []
  let nextId = 100
  const windows: FakeWindow[] = []

  const impl: any = {
    createTab: async (details: any) => {
      const win = windows.find((w) => w.id === details.windowId && !w.destroyed) ?? windows[0]
      const tab = new FakeTab(nextId++)
      if (details.url) void tab.loadURL(details.url)
      return [tab, win]
    },
    createWindow: async (details: any) => {
      const win = new FakeWindow(nextId++)
      windows.push(win)
      const urls = Array.isArray(details.url) ? details.url : [details.url ?? 'about:blank']
      for (const url of urls) {
        const tab = new FakeTab(nextId++)
        tab.url = url
        store.addTab(tab as any, win as any)
      }
      return win
    },
    removeTab: (tab: FakeTab) => queueMicrotask(() => tab.destroy()),
    updateTabGroup: (details: any) => groupHook.push(details),
  }
  const store = new ExtensionStore(impl)
  // The real createTab checks for an Electron WebContents; the fake host's tabs are not.
  store.createTab = async (details: any) => {
    const [tab, win] = await impl.createTab(details)
    if (details.url) store.pendingUrls.set(tab, details.url)
    store.addTab(tab, win)
    return tab
  }
  const state: Record<string, unknown> = {}
  const stateStore: any = {
    whenHydrated: async () => {},
    getNamespace: (name: string, fallback: any) => (state[name] as any) ?? fallback,
    setNamespace: (name: string, value: unknown) => {
      state[name] = value
    },
    flush: async () => {},
  }
  const permissions = new ExtensionPermissions({ stateStore, sendEvent: () => {}, prompt: async () => false })
  const router: any = {
    apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
    broadcastEvent: (name: string, ...args: any[]) => events.push({ name, args }),
    sendEvent: (to: string, name: string, ...args: any[]) => events.push({ name, to, args }),
    // Every extension listens to everything here.
    sendEventForEachListener: (name: string, map: (id: string) => any[]) => {
      for (const e of EXTENSIONS) events.push({ name, to: e.id, args: map(e.id) })
    },
  }
  const session: any = {
    isPersistent: () => true,
    extensions: { getExtension: (id: string) => EXTENSIONS.find((e) => e.id === id) },
  }
  const ctx: any = {
    router,
    store,
    session,
    permissions,
    stateStore,
    emit: (name: string, ...args: any[]) => hostEvents.push({ name, args }),
  }
  const sessions = new SessionsAPI(ctx)
  const groups = new TabGroupsAPI(ctx)
  const tabs = new TabsAPI(ctx)
  const windowsApi = new WindowsAPI(ctx)

  const call = async (extension: any, name: string, ...args: any[]) =>
    handlers.get(name)!({ type: 'service-worker', sender: {}, extension }, ...args)
  const fails = async (promise: Promise<any> | (() => any)) => {
    try {
      await (typeof promise === 'function' ? promise() : promise)
    } catch (e: any) {
      return e.message as string
    }
    return 'no error'
  }
  const openWindow = (...pages: Array<[string, string]>) => {
    const win = new FakeWindow(nextId++)
    windows.push(win)
    const made = pages.map(([url, title]) => {
      const tab = new FakeTab(nextId++)
      tab.url = url
      tab.title = title
      store.addTab(tab as any, win as any)
      return tab
    })
    return { win, tabs: made }
  }
  const order = (win: FakeWindow) => tabs.windowTabs(win as any).map((t) => t.id)
  return { handlers, events, hostEvents, groupHook, store, tabs, groups, sessions, windowsApi, call, fails, openWindow, order, state }
}

describe('chrome.tabs model', () => {
  describe('privacy of tab urls and titles', () => {
    it('shows url, title and favicon only with "tabs" or host access', async () => {
      const h = setup()
      const { tabs: [a, b] } = h.openWindow(['https://a.example/x', 'A page'], ['https://b.example/y', 'B page'])
      const seen = async (e: any, tab: FakeTab) => {
        const t = await h.call(e, 'tabs.get', tab.id)
        return { url: t.url, title: t.title }
      }
      expect(await seen(TABS, b)).to.deep.equal({ url: 'https://b.example/y', title: 'B page' })
      expect(await seen(HOST, a)).to.deep.equal({ url: 'https://a.example/x', title: 'A page' })
      expect(await seen(HOST, b)).to.deep.equal({ url: undefined, title: undefined })
      expect(await seen(NONE, a)).to.deep.equal({ url: undefined, title: undefined })
    })

    it("hides an extension's own page without \"tabs\", as Chrome does", async () => {
      const h = setup()
      const { tabs: [own] } = h.openWindow([`chrome-extension://${NONE.id}/page.html`, 'Own'])
      expect((await h.call(NONE, 'tabs.get', own.id)).url).to.equal(undefined)
    })

    it('never matches a url or title query on a tab the extension may not see', async () => {
      const h = setup()
      h.openWindow(['https://a.example/x', 'A page'], ['https://b.example/y', 'B page'])
      expect(await h.call(HOST, 'tabs.query', { url: 'https://b.example/*' })).to.deep.equal([])
      expect(await h.call(HOST, 'tabs.query', { title: 'B*' })).to.deep.equal([])
      expect(await h.call(NONE, 'tabs.query', { url: '<all_urls>' })).to.deep.equal([])
      expect((await h.call(HOST, 'tabs.query', { url: 'https://a.example/*' })).length).to.equal(1)
      expect((await h.call(TABS, 'tabs.query', { title: 'B*' })).length).to.equal(1)
      // A query without url or title still finds the tabs, without their urls.
      const all = await h.call(NONE, 'tabs.query', {})
      expect(all.length).to.equal(2)
      expect(all.every((t: any) => t.url === undefined && t.title === undefined)).to.equal(true)
    })

    it('hides urls in tabs.onCreated and tabs.onUpdated per extension', async () => {
      const h = setup()
      const { tabs: [a] } = h.openWindow(['https://a.example/x', 'A page'])
      const created = h.events.filter((e) => e.name === 'tabs.onCreated')
      expect(created.find((e) => e.to === TABS.id)!.args[0].url).to.equal('https://a.example/x')
      expect(created.find((e) => e.to === NONE.id)!.args[0]).to.not.have.property('url')

      h.events.length = 0
      a.navigate('https://b.example/secret', 'Secret')
      const updated = h.events.filter((e) => e.name === 'tabs.onUpdated')
      const forNone = updated.filter((e) => e.to === NONE.id).map((e) => e.args[1])
      const forTabs = updated.filter((e) => e.to === TABS.id).map((e) => e.args[1])
      expect(forTabs.some((info) => info.url === 'https://b.example/secret')).to.equal(true)
      expect(forTabs.some((info) => info.title === 'Secret')).to.equal(true)
      expect(forNone.some((info) => 'url' in info || 'title' in info)).to.equal(false)
      // The host-access extension saw a.example, and now may not see the page.
      expect(updated.filter((e) => e.to === HOST.id).some((e) => 'url' in e.args[2])).to.equal(false)
    })

    it('lists windows with populated tabs that hide urls the same way', async () => {
      const h = setup()
      h.openWindow(['https://b.example/y', 'B page'])
      const [win] = await h.call(NONE, 'windows.getAll', { populate: true })
      expect(win.tabs[0]).to.not.have.property('url')
      const [plain] = await h.call(NONE, 'windows.getAll')
      expect(plain).to.not.have.property('tabs')
    })
  })

  describe('navigation', () => {
    const extension: any = { id: 'abc', url: 'chrome-extension://abc/' }
    it('resolves relative urls to the extension and refuses browser and other extensions\' pages', () => {
      expect(prepareNavigationUrl('options.html', extension)).to.equal('chrome-extension://abc/options.html')
      const refused = (url: string) => {
        try {
          prepareNavigationUrl(url, extension)
          return 'allowed'
        } catch (e: any) {
          return e.message
        }
      }
      expect(refused('javascript:alert(1)')).to.match(/^JavaScript URLs are not allowed/)
      expect(refused('  JAVASCRIPT:alert(1)')).to.match(/^JavaScript URLs are not allowed/)
      expect(refused('chrome://kill')).to.equal("I'm sorry. I'm afraid I can't do that.")
      expect(refused('chrome://settings')).to.equal('Cannot navigate to a chrome:// page.')
      expect(refused('peersky://settings')).to.equal('Cannot navigate to a peersky:// page.')
      expect(refused('chrome-extension://other/page.html')).to.equal('allowed')
      expect(refused('view-source:peersky://settings')).to.equal('Cannot navigate to a peersky:// page.')
      expect(refused('devtools://devtools/bundled/inspector.html')).to.match(/^Cannot navigate to a devtools:\/\/ page/)
      expect(refused('https://example.com/')).to.equal('allowed')
      expect(refused('file:///etc/hosts')).to.equal('allowed')
    })

    it('fails on a missing tab with Chrome\'s words', async () => {
      const h = setup()
      h.openWindow(['https://a.example/x', 'A'])
      expect(await h.fails(h.call(TABS, 'tabs.get', 5))).to.equal('No tab with id: 5.')
      expect(await h.fails(h.call(TABS, 'tabs.update', 5, { pinned: true }))).to.equal('No tab with id: 5.')
      expect(await h.fails(h.call(TABS, 'tabs.remove', [5]))).to.equal('No tab with id: 5.')
      expect(await h.fails(h.call(TABS, 'tabs.get', 'x'))).to.equal(
        'Error in invocation of tabs.get(integer tabId, optional function callback): No matching signature.',
      )
      expect(await h.fails(h.call(TABS, 'tabs.query', { status: 'nope' }))).to.equal(
        "Error in invocation of tabs.query(object queryInfo, optional function callback): Error at parameter 'queryInfo': Error at property 'status': Value must be one of complete, loading, unloaded.",
      )
    })

    it('captures only with <all_urls> or activeTab', async () => {
      const h = setup()
      h.openWindow(['https://a.example/x', 'A'])
      expect(await h.fails(h.call(TABS, 'tabs.captureVisibleTab'))).to.equal(
        "Either the '<all_urls>' or 'activeTab' permission is required.",
      )
    })
  })

  describe('matching', () => {
    it('matches globs without stalling on many stars', () => {
      const pattern = '*a'.repeat(40) + '*b'
      const started = Date.now()
      expect(globMatch(pattern, 'a'.repeat(5000))).to.equal(false)
      expect(Date.now() - started).to.be.lessThan(500)
      expect(globMatch('Pro?e *', 'Probe page')).to.equal(true)
      expect(globMatch('/page?x', '/page?x', false)).to.equal(true)
      expect(globMatch('/page?x', '/pageAx', false)).to.equal(false)
    })

    it('answers a url query full of stars quickly', async () => {
      const h = setup()
      h.openWindow(['https://a.example/' + 'a'.repeat(2000), 'A'])
      const started = Date.now()
      const found = await h.call(TABS, 'tabs.query', { url: 'https://a.example/' + '*a'.repeat(30) + '*b' })
      expect(found).to.deep.equal([])
      expect(Date.now() - started).to.be.lessThan(1000)
    })
  })

  describe('order, pinning and moves', () => {
    it('keeps pinned tabs first and gives one tab for a one-tab move list', async () => {
      const h = setup()
      const { win, tabs: [a, b, c] } = h.openWindow(['https://a.example/1', '1'], ['https://a.example/2', '2'], ['https://a.example/3', '3'])
      await h.call(TABS, 'tabs.update', c.id, { pinned: true })
      expect(h.order(win)).to.deep.equal([c.id, a.id, b.id])
      // An unpinned tab cannot go before a pinned one.
      const moved = await h.call(TABS, 'tabs.move', [b.id], { index: 0 })
      expect(Array.isArray(moved)).to.equal(false)
      expect(moved.index).to.equal(1)
      expect(h.order(win)).to.deep.equal([c.id, b.id, a.id])
    })

    it('announces a removed tab once', async () => {
      const h = setup()
      const { tabs: [a] } = h.openWindow(['https://a.example/1', '1'], ['https://a.example/2', '2'])
      await h.call(TABS, 'tabs.remove', a.id)
      await new Promise((r) => setTimeout(r, 10))
      expect(h.events.filter((e) => e.name === 'tabs.onRemoved' && e.args[0] === a.id).length).to.equal(1)
    })

    it('records who muted a tab', async () => {
      const h = setup()
      const { tabs: [a] } = h.openWindow(['https://a.example/1', '1'])
      const tab = await h.call(TABS, 'tabs.update', a.id, { muted: true })
      expect(tab.mutedInfo).to.deep.equal({ muted: true, reason: 'extension', extensionId: TABS.id })
    })
  })

  describe('sessions', () => {
    it('keeps the 25 most recent closed tabs, in memory only', async () => {
      const h = setup()
      const { tabs: list } = h.openWindow(
        ['https://a.example/keep', 'keep'],
        ...Array.from({ length: 30 }, (_, i) => [`https://a.example/${i}`, `t${i}`] as [string, string]),
      )
      for (const tab of list.slice(1)) h.store.removeTab(tab as any)
      const recent = await h.call(TABS, 'sessions.getRecentlyClosed')
      expect(recent.length).to.equal(25)
      expect(recent[0].tab.url).to.equal('https://a.example/29')
      expect(recent[0].tab).to.not.have.property('id')
      expect(typeof recent[0].lastModified).to.equal('number')
      expect(h.events.filter((e) => e.name === 'sessions.onChanged').length).to.equal(30)
      // Nothing of it went to the state store, which can be on disk.
      expect(JSON.stringify(h.state)).to.not.include('a.example')
      expect(await h.fails(h.call(TABS, 'sessions.getRecentlyClosed', { maxResults: 26 }))).to.match(
        /Error at property 'maxResults': Value must be at most 25\.$/,
      )
      // The tab's url is hidden from an extension without access to it.
      expect((await h.call(NONE, 'sessions.getRecentlyClosed', { maxResults: 1 }))[0].tab).to.not.have.property('url')
    })

    it('keeps a closed window, or its only tab', async () => {
      const h = setup()
      h.openWindow(['https://a.example/stay', 'stay'])
      const two = h.openWindow(['https://a.example/w1', 'w1'], ['https://a.example/w2', 'w2'])
      two.win.destroy()
      for (const tab of two.tabs) tab.destroy()
      const one = h.openWindow(['https://a.example/only', 'only'])
      one.win.destroy()
      one.tabs[0].destroy()
      await new Promise((r) => setTimeout(r, 150))
      const recent = await h.call(TABS, 'sessions.getRecentlyClosed')
      expect(recent[0].tab.url).to.equal('https://a.example/only')
      expect(recent[1].window.tabs.map((t: any) => t.url)).to.deep.equal(['https://a.example/w1', 'https://a.example/w2'])
    })

    it('restores by session id and takes the entry off the list', async () => {
      const h = setup()
      const { tabs: [, closed] } = h.openWindow(['https://a.example/stay', 'stay'], ['https://a.example/closed', 'c'])
      h.store.removeTab(closed as any)
      const [entry] = await h.call(TABS, 'sessions.getRecentlyClosed')
      const restored = await h.call(TABS, 'sessions.restore', entry.tab.sessionId)
      expect(restored.tab.url === 'https://a.example/closed' || restored.tab.pendingUrl === 'https://a.example/closed').to.equal(true)
      expect(await h.call(TABS, 'sessions.getRecentlyClosed')).to.deep.equal([])
      expect(await h.fails(h.call(TABS, 'sessions.restore', entry.tab.sessionId))).to.equal(
        `Invalid session id: "${entry.tab.sessionId}".`,
      )
      expect(await h.fails(h.call(TABS, 'sessions.restore'))).to.equal('There are no recently closed sessions.')
      expect(await h.call(TABS, 'sessions.getDevices')).to.deep.equal([])
    })
  })

  describe('tab groups', () => {
    it('groups tabs side by side, tells the host and drops an empty group', async () => {
      const h = setup()
      const { win, tabs: [a, b, c, d] } = h.openWindow(
        ['https://a.example/1', '1'],
        ['https://a.example/2', '2'],
        ['https://a.example/3', '3'],
        ['https://a.example/4', '4'],
      )
      const groupId = await h.call(TABS, 'tabs.group', { tabIds: [d.id, b.id] })
      expect(h.order(win)).to.deep.equal([a.id, b.id, d.id, c.id])
      expect((await h.call(TABS, 'tabs.get', d.id)).groupId).to.equal(groupId)
      expect(h.events.some((e) => e.name === 'tabGroups.onCreated')).to.equal(true)
      expect(h.hostEvents.some((e) => e.name === 'tab-group-created')).to.equal(true)
      expect(h.groupHook[h.groupHook.length - 1].tabIds).to.deep.equal([b.id, d.id])

      // Ungrouping moves the tab past the end of its group.
      await h.call(TABS, 'tabs.ungroup', b.id)
      expect(h.order(win)).to.deep.equal([a.id, d.id, b.id, c.id])
      expect((await h.call(TABS, 'tabs.get', b.id)).groupId).to.equal(-1)

      await h.call(TABS, 'tabs.ungroup', [d.id])
      expect(h.events.some((e) => e.name === 'tabGroups.onRemoved' && e.args[0].id === groupId)).to.equal(true)
      expect(await h.fails(h.call(TABS, 'tabGroups.get', groupId))).to.equal(`No group with id: ${groupId}.`)
      expect(h.groupHook[h.groupHook.length - 1].removed).to.equal(true)
    })

    it('refuses bad colors and moves into another group, and unpins tabs it groups', async () => {
      const h = setup()
      const { tabs: [a, , c, d] } = h.openWindow(
        ['https://a.example/1', '1'],
        ['https://a.example/2', '2'],
        ['https://a.example/3', '3'],
        ['https://a.example/4', '4'],
      )
      await h.call(TABS, 'tabs.update', a.id, { pinned: true })
      const first = await h.call(TABS, 'tabs.group', { tabIds: [a.id] })
      expect((await h.call(TABS, 'tabs.get', a.id)).pinned).to.equal(false)
      await h.call(TABS, 'tabs.group', { tabIds: [c.id, d.id] })
      expect(await h.fails(h.call(TABS, 'tabGroups.update', first, { color: 'plaid' }))).to.equal(
        "Error in invocation of tabGroups.update(integer groupId, object updateProperties, optional function callback): Error at parameter 'updateProperties': Error at property 'color': Value must be one of blue, cyan, green, grey, orange, pink, purple, red, yellow.",
      )
      expect(await h.fails(h.call(TABS, 'tabGroups.move', first, { index: 2 }))).to.equal(
        'Cannot move the group to an index that is in the middle of another group.',
      )
      // New groups take colors not used yet in the window.
      const colors = (await h.call(TABS, 'tabGroups.query', {})).map((g: any) => g.color)
      expect(new Set(colors).size).to.equal(2)
      expect(await h.call(TABS, 'tabGroups.query', { title: 'x*' })).to.deep.equal([])
    })

    it('gives the active tab to a tab outside a group that collapses', async () => {
      const h = setup()
      const { win, tabs: [a, b] } = h.openWindow(['https://a.example/1', '1'], ['https://a.example/2', '2'])
      h.tabs.onActivated(b.id)
      const groupId = await h.call(TABS, 'tabs.group', { tabIds: [b.id] })
      await h.call(TABS, 'tabGroups.update', groupId, { collapsed: true })
      expect(h.store.getActiveTabFromWindow(win as any)?.id).to.equal(a.id)
    })

    it('drops a group when its last tab closes', async () => {
      const h = setup()
      const { tabs: [, b] } = h.openWindow(['https://a.example/1', '1'], ['https://a.example/2', '2'])
      const groupId = await h.call(TABS, 'tabs.group', { tabIds: [b.id] })
      h.store.removeTab(b as any)
      expect(h.events.some((e) => e.name === 'tabGroups.onRemoved' && e.args[0].id === groupId)).to.equal(true)
    })
  })

  describe('windows', () => {
    it("checks arguments with Chrome's words", async () => {
      const h = setup()
      const { win } = h.openWindow(['https://a.example/1', '1'])
      expect(await h.fails(h.call(TABS, 'windows.get', 987))).to.equal('No window with id: 987.')
      expect(await h.fails(h.call(TABS, 'windows.remove', 987))).to.equal('No window with id: 987.')
      expect(await h.fails(h.call(TABS, 'windows.update', win.id, { state: 'minimized', width: 300 }))).to.equal(
        'Invalid value for state',
      )
      expect(await h.fails(h.call(TABS, 'windows.update', win.id, { state: 'maximized', focused: false }))).to.equal(
        'Invalid value for state',
      )
      expect(await h.fails(h.call(TABS, 'windows.create', { type: 'panel-of-doom' }))).to.equal(
        "Error in invocation of windows.create(optional object createData, optional function callback): Error at parameter 'createData': Error at property 'type': Value must be one of normal, panel, popup.",
      )
      expect(await h.fails(h.call(TABS, 'windows.create', { url: 'javascript:1' }))).to.match(/^JavaScript URLs/)
      const resized = await h.call(TABS, 'windows.update', win.id, { width: 640, height: 480 })
      expect([resized.width, resized.height]).to.deep.equal([640, 480])
    })

    it('makes popups that hold their own type and filters by it', async () => {
      const h = setup()
      h.openWindow(['https://a.example/1', '1'])
      const popup = await h.call(TABS, 'windows.create', { url: 'https://a.example/p', type: 'popup' })
      expect(popup.type).to.equal('popup')
      expect(popup.tabs.length).to.equal(1)
      const normal = await h.call(TABS, 'windows.getAll', { windowTypes: ['normal'] })
      expect(normal.every((w: any) => w.type === 'normal')).to.equal(true)
      // A tab asked for in a popup opens in a normal window.
      const tab = await h.call(TABS, 'tabs.create', { windowId: popup.id, url: 'https://a.example/t' })
      expect(tab.windowId).to.not.equal(popup.id)
    })
  })
})
