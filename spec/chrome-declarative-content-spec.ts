import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'

import { compileUrlFilter, decodeIcon, DeclarativeContentAPI, newRegexBudget } from '../src/browser/api/declarative-content'
import { ExtensionStore } from '../src/browser/store'

const probeDir = path.join(__dirname, 'fixtures', 'chrome-api-probe')
const SCRIPT_WORLD = 1000
const CSS_WATCH_WORLD = 1999

const makeExtension = (id: string, manifest: Record<string, any> = {}) =>
  ({
    id,
    name: id,
    path: probeDir,
    url: `chrome-extension://${id}/`,
    manifest: { manifest_version: 3, action: {}, permissions: ['declarativeContent'], ...manifest },
  }) as any

/** A tab that records what was run in it. `css` is what its CSS watcher reports. */
class FakeTab extends EventEmitter {
  static nextId = 100
  id = FakeTab.nextId++
  destroyed = false
  loading = false
  css: string[] = []
  injected: Array<{ world: number; code: string }> = []
  insertedCss: string[] = []
  constructor(public url: string) {
    super()
  }
  getURL() {
    return this.url
  }
  isLoading() {
    return this.loading
  }
  isDestroyed() {
    return this.destroyed
  }
  async insertCSS(css: string) {
    this.insertedCss.push(css)
  }
  executeJavaScriptInIsolatedWorld(world: number, sources: Array<{ code: string }>) {
    this.injected.push({ world, code: sources[0].code })
    if (world !== CSS_WATCH_WORLD) return Promise.resolve(undefined)
    // The first call answers with the matches; later ones wait, as a page
    // that does not change does.
    const calls = this.injected.filter((i) => i.world === CSS_WATCH_WORLD).length
    return calls === 1 ? Promise.resolve(this.css) : new Promise(() => {})
  }
  navigate(url: string) {
    this.url = url
    this.emit('did-navigate', {}, url)
    this.emit('dom-ready')
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function setup(opts: { state?: Record<string, unknown>; hostAccess?: (url: string) => boolean; extensions?: any[] } = {}) {
  const handlers = new Map<string, Function>()
  const state = opts.state ?? {}
  const extensions = new Map<string, any>((opts.extensions ?? [makeExtension('ext')]).map((e) => [e.id, e]))
  const sessionExtensions = Object.assign(new EventEmitter(), { getExtension: (id: string) => extensions.get(id) })
  const store = new ExtensionStore({})
  const ctx: any = {
    router: {
      apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
      sendEvent: () => {},
      broadcastEvent: () => {},
    },
    session: { extensions: sessionExtensions },
    store,
    stateStore: {
      whenHydrated: async () => {},
      getNamespace: (name: string, fallback: any) => (state[name] as any) ?? fallback,
      setNamespace: (name: string, value: unknown) => {
        state[name] = value
      },
      flush: async () => {},
    },
    permissions: {
      has: (extension: any, permission: string) => !!extension.manifest.permissions?.includes(permission),
      hasHostAccess: (_extension: any, url: string) => (opts.hostAccess ? opts.hostAccess(url) : true),
    },
  }
  const api = new DeclarativeContentAPI(ctx)
  const window: any = { id: 1, isDestroyed: () => false }
  const call = (name: string, extension: any, ...args: any[]) =>
    handlers.get(`declarativeContent.${name}`)!({ extension, type: 'service-worker' }, ...args)
  const addTab = async (url: string, css: string[] = [], loading = false) => {
    const tab = new FakeTab(url)
    tab.css = css
    tab.loading = loading
    store.addTab(tab as any, window)
    await tick()
    return tab
  }
  return { api, ctx, store, state, call, addTab, sessionExtensions, extension: extensions.values().next().value }
}

const matcher = (fields: Record<string, any> = {}) => ({ instanceType: 'declarativeContent.PageStateMatcher', ...fields })
const show = { instanceType: 'declarativeContent.ShowAction' }
const script = (js: string[]) => ({ instanceType: 'declarativeContent.RequestContentScript', js })

/** An icon as the renderer packs one: width, height, then RGBA. */
const packIcon = (width: number, height: number, rgba = [255, 0, 0, 255]) => {
  const bytes = Buffer.alloc(8 + width * height * 4)
  bytes.writeUInt32LE(width, 0)
  bytes.writeUInt32LE(height, 4)
  for (let i = 8; i < bytes.length; i += 4) bytes.set(rgba, i)
  return bytes.toString('base64')
}

describe('chrome.declarativeContent', () => {
  describe('UrlFilter', () => {
    const test = (filter: any, url: string) => compileUrlFilter(filter)(new URL(url))

    it('compares host criteria with a dot before the host, as Chrome does', () => {
      expect(test({ hostContains: '.example' }, 'https://www.example.com/')).to.equal(true)
      expect(test({ hostContains: '.example' }, 'https://example.com/')).to.equal(true)
      expect(test({ hostContains: '.example' }, 'https://badexample.com/')).to.equal(false)
      expect(test({ hostEquals: 'example.com' }, 'https://example.com:8080/')).to.equal(true)
      expect(test({ hostEquals: 'example.com' }, 'https://www.example.com/')).to.equal(false)
      expect(test({ hostPrefix: 'www' }, 'https://www.example.com/')).to.equal(true)
      expect(test({ hostSuffix: '.example.com' }, 'https://example.com/')).to.equal(true)
      expect(test({ hostSuffix: 'example.com' }, 'https://badexample.com/')).to.equal(true)
    })

    it('matches path, query and the whole URL without its fragment or user name', () => {
      expect(test({ pathPrefix: '/a/' }, 'https://x.test/a/b?c')).to.equal(true)
      expect(test({ pathEquals: '/a/b' }, 'https://x.test/a/b?c')).to.equal(true)
      expect(test({ querySuffix: 'c=1' }, 'https://x.test/?b=2&c=1')).to.equal(true)
      expect(test({ queryEquals: '' }, 'https://x.test/')).to.equal(true)
      expect(test({ urlEquals: 'https://x.test/a' }, 'https://user:pw@x.test/a#frag')).to.equal(true)
      expect(test({ urlSuffix: '#frag' }, 'https://x.test/a#frag')).to.equal(false)
      expect(test({ urlMatches: 'x\\.test/a$' }, 'https://x.test/a#frag')).to.equal(true)
      expect(test({ originAndPathMatches: '/a$' }, 'https://x.test/a?q=1')).to.equal(true)
      expect(test({ hostEquals: 'x.test', pathPrefix: '/b' }, 'https://x.test/a')).to.equal(false)
    })

    it('matches schemes, ports with their defaults, and CIDR blocks', () => {
      expect(test({ schemes: ['https'] }, 'https://x.test/')).to.equal(true)
      expect(test({ schemes: ['https'] }, 'http://x.test/')).to.equal(false)
      expect(test({ ports: [443] }, 'https://x.test/')).to.equal(true)
      expect(test({ ports: [[8000, 9000]] }, 'http://x.test:8473/')).to.equal(true)
      expect(test({ ports: [[9000, 8000]] }, 'http://x.test:8473/')).to.equal(false)
      expect(test({ cidrBlocks: ['127.0.0.0/8'] }, 'http://127.1.2.3/')).to.equal(true)
      expect(test({ cidrBlocks: ['127.0.0.0/8'] }, 'http://localhost/')).to.equal(false)
      expect(test({ cidrBlocks: ['::1/128'] }, 'http://[::1]:8080/')).to.equal(true)
    })

    it("refuses what Chrome refuses, with Chrome's messages", () => {
      expect(() => compileUrlFilter({ hostEquals: 'Example.com' })).to.throw('Host values need to be in lower case.')
      expect(() => compileUrlFilter({ schemes: ['HTTP'] })).to.throw('Scheme values need to be in lower case.')
      expect(() => compileUrlFilter({ cidrBlocks: ['nope'] })).to.throw('Failed parsing CIDR')
      expect(() => compileUrlFilter({ hostEquals: 5 })).to.throw("UrlFilter attribute 'hostEquals' expected a string value.")
      expect(() => compileUrlFilter({ nope: 'x' })).to.throw("Unknown attribute 'nope' in UrlFilter.")
      expect(() => compileUrlFilter({ ports: [[1, 2, 3]] })).to.throw('Invalid port ranges in UrlFilter.')
      expect(() => compileUrlFilter({ urlMatches: '(' })).to.throw("Could not parse regular expression '(': missing ): (")
      expect(() => compileUrlFilter({ urlMatches: 'a(?=b)' })).to.throw('invalid perl operator: (?=')
      expect(() => compileUrlFilter({ urlMatches: '(a)\\1' })).to.throw('invalid escape sequence: \\1')
    })

    it('does not let a regular expression that backtracks without end hold up the main process', () => {
      const filter = compileUrlFilter({ urlMatches: '(a+)+b' })
      const url = new URL(`http://x.test/${'a'.repeat(40)}`)
      const started = Date.now()
      expect(filter(url)).to.equal(false)
      expect(Date.now() - started).to.be.below(1000)
      // Once it took too long it is not run again.
      const again = Date.now()
      expect(filter(url)).to.equal(false)
      expect(Date.now() - again).to.be.below(20)
    })

    it("turns off all of an extension's regular expressions once one takes too long, even when it adds them again", () => {
      const budget = newRegexBudget()
      const slow = compileUrlFilter({ urlMatches: '(a+)+b' }, budget)
      const fine = compileUrlFilter({ urlMatches: 'x\\.test' }, budget)
      const url = new URL(`http://x.test/${'a'.repeat(40)}`)
      expect(fine(url)).to.equal(true)
      expect(slow(url)).to.equal(false)
      expect(fine(url)).to.equal(false)
      const started = Date.now()
      expect(compileUrlFilter({ urlMatches: '(a+)+b' }, budget)(url)).to.equal(false)
      expect(Date.now() - started).to.be.below(20)
      // Another extension's are not touched.
      expect(compileUrlFilter({ urlMatches: 'x\\.test' })(url)).to.equal(true)
    })
  })

  describe('rules', () => {
    it('keeps rules across a new instance, as Chrome keeps them across restarts', async () => {
      const first = setup()
      await first.call('addRules', first.extension, [{ id: 'a', conditions: [matcher()], actions: [show] }])
      const second = setup({ state: first.state })
      const rules = await second.call('getRules', second.extension)
      expect(rules).to.deep.equal([{ id: 'a', priority: 100, conditions: [matcher()], actions: [show] }])
    })

    it('refuses a batch with a used id and keeps none of it', async () => {
      const { call, extension } = setup()
      await call('addRules', extension, [{ id: 'a', conditions: [], actions: [] }])
      await expect(
        call('addRules', extension, [{ id: 'b', conditions: [], actions: [] }, { id: 'a', conditions: [], actions: [] }]),
      ).to.be.rejectedWith('Id a was used multiple times.')
      expect((await call('getRules', extension)).map((r: any) => r.id)).to.deep.equal(['a'])
    })

    it('makes ids that skip ones in use, and gives rules back sorted by id', async () => {
      const { call, extension } = setup()
      await call('addRules', extension, [{ id: '_0_', conditions: [], actions: [] }, { id: 'b', conditions: [], actions: [] }])
      const [added] = await call('addRules', extension, [{ conditions: [], actions: [] }])
      expect(added.id).to.equal('_1_')
      expect((await call('getRules', extension)).map((r: any) => r.id)).to.deep.equal(['_0_', '_1_', 'b'])
    })

    it("keeps each extension's rules to itself", async () => {
      const a = makeExtension('a')
      const b = makeExtension('b')
      const { call } = setup({ extensions: [a, b] })
      await call('addRules', a, [{ id: 'x', conditions: [], actions: [] }])
      expect(await call('getRules', b)).to.deep.equal([])
      await call('removeRules', b)
      expect((await call('getRules', a)).length).to.equal(1)
    })

    it('refuses rules the extension may not have', async () => {
      const noAction = makeExtension('plain', { action: undefined })
      const { call } = setup({ extensions: [noAction] })
      await expect(call('addRules', noAction, [{ conditions: [], actions: [show] }])).to.be.rejectedWith(
        "Can't use declarativeContent.ShowAction without an action",
      )
      await expect(call('addRules', noAction, [{ conditions: [matcher({ isBookmarked: true })], actions: [] }])).to.be.rejectedWith(
        "Property 'isBookmarked' requires 'bookmarks' permission",
      )
      await expect(call('addRules', noAction, [{ conditions: [{ pageUrl: {} }], actions: [] }])).to.be.rejectedWith('Invalid invocation')
      await expect(call('addRules', noAction, 'nope')).to.be.rejectedWith('Invalid invocation')
    })

    it('caps how many rules an extension keeps', async () => {
      const { call, extension } = setup()
      const many = Array.from({ length: 1001 }, () => ({ conditions: [], actions: [] }))
      await expect(call('addRules', extension, many)).to.be.rejectedWith('at most 1000 rules')
    })
  })

  describe('pages', () => {
    it('shows the action on a tab only while a rule matches it', async () => {
      const { call, extension, store, addTab } = setup()
      const tab = await addTab('https://www.example.com/a')
      const changes: number[] = []
      store.on('declarative-action-changed', (_id: string, tabId: number) => changes.push(tabId))
      await call('addRules', extension, [{ conditions: [matcher({ pageUrl: { hostSuffix: 'example.com' } })], actions: [show] }])
      expect(store.getDeclarativeAction('ext', tab.id)).to.deep.equal({ show: true, icon: undefined })
      tab.navigate('https://other.test/')
      expect(store.getDeclarativeAction('ext', tab.id)).to.equal(undefined)
      expect(changes).to.deep.equal([tab.id, tab.id])
    })

    it('gives the action the icon of the highest priority rule that matches', async () => {
      const { call, extension, store, addTab } = setup()
      const tab = await addTab('https://example.com/')
      const icon = (rgba: number[]) => ({ instanceType: 'declarativeContent.SetIcon', imageData: { 2: packIcon(2, 2, rgba) } })
      await call('addRules', extension, [
        { priority: 1, conditions: [matcher()], actions: [icon([255, 0, 0, 255])] },
        { priority: 5, conditions: [matcher()], actions: [icon([0, 0, 255, 255])] },
      ])
      const state = store.getDeclarativeAction('ext', tab.id)!
      expect(state.show).to.equal(false)
      expect(state.icon!['2']).to.equal(decodeIcon(packIcon(2, 2, [0, 0, 255, 255]))!.toDataURL())
      await expect(
        call('addRules', extension, [{ conditions: [], actions: [{ instanceType: 'declarativeContent.SetIcon', imageData: { 2: 'AAAA' } }] }]),
      ).to.be.rejectedWith('Icon dictionary must be of the form')
    })

    it('injects a RequestContentScript once per page, only with host access and never into browser pages', async () => {
      const { call, extension, addTab } = setup({ hostAccess: (url) => !url.includes('denied') })
      const allowed = await addTab('https://allowed.example/')
      const denied = await addTab('https://denied.example/')
      const browserPage = await addTab('peersky://settings')
      await call('addRules', extension, [{ id: 's', conditions: [matcher()], actions: [script(['inject.js', '../../package.json'])] }])
      await tick()
      const scripts = (tab: FakeTab) => tab.injected.filter((i) => i.world === SCRIPT_WORLD)
      expect(scripts(allowed).map((i) => i.code.trim())).to.deep.equal(["document.documentElement.dataset.injected = 'yes'\n'from file'"])
      expect(scripts(denied)).to.deep.equal([])
      expect(scripts(browserPage)).to.deep.equal([])
      // Same page: not again. A new page: again.
      allowed.emit('did-navigate-in-page', {}, 'https://allowed.example/#x', true)
      await tick()
      expect(scripts(allowed).length).to.equal(1)
      allowed.navigate('https://allowed.example/next')
      await tick()
      expect(scripts(allowed).length).to.equal(2)
    })

    it('waits for the page to be ready before it injects', async () => {
      const { call, extension, addTab } = setup()
      const tab = await addTab('https://example.com/', [], true)
      await call('addRules', extension, [{ conditions: [matcher()], actions: [script(['inject.js'])] }])
      await tick()
      expect(tab.injected.filter((i) => i.world === SCRIPT_WORLD)).to.deep.equal([])
      tab.loading = false
      tab.emit('dom-ready')
      await tick()
      expect(tab.injected.filter((i) => i.world === SCRIPT_WORLD).length).to.equal(1)
    })

    it('matches CSS selectors that the page reports, in web pages only', async () => {
      const { call, extension, store, addTab } = setup()
      const page = await addTab('https://example.com/', ['.found'])
      const browserPage = await addTab('peersky://settings', ['.found'])
      await call('addRules', extension, [
        { id: 'css', conditions: [matcher({ css: ['.found'] })], actions: [show] },
        { id: 'missing', conditions: [matcher({ css: ['.missing'] })], actions: [script(['inject.js'])] },
      ])
      await tick()
      expect(store.getDeclarativeAction('ext', page.id)).to.deep.equal({ show: true, icon: undefined })
      expect(page.injected.filter((i) => i.world === SCRIPT_WORLD)).to.deep.equal([])
      expect(browserPage.injected.filter((i) => i.world === CSS_WATCH_WORLD)).to.deep.equal([])
      expect(store.getDeclarativeAction('ext', browserPage.id)).to.equal(undefined)
    })

    it('ends what the rules did when the extension unloads, and keeps the rules', async () => {
      const { call, extension, store, addTab, sessionExtensions, state } = setup()
      const tab = await addTab('https://example.com/')
      await call('addRules', extension, [{ conditions: [matcher()], actions: [show] }])
      expect(store.getDeclarativeAction('ext', tab.id)?.show).to.equal(true)
      sessionExtensions.emit('extension-unloaded', {}, extension)
      expect(store.getDeclarativeAction('ext', tab.id)).to.equal(undefined)
      expect((state['declarativeContent.rules'] as any).ext.length).to.equal(1)
    })

    it('forgets a tab that closes', async () => {
      const { call, extension, store, addTab } = setup()
      const tab = await addTab('https://example.com/')
      await call('addRules', extension, [{ conditions: [matcher()], actions: [show] }])
      store.removeTab(tab as any)
      expect(store.getDeclarativeAction('ext', tab.id)).to.equal(undefined)
    })
  })

  describe('icons', () => {
    it('reads the icons the renderer packs, and refuses anything else', () => {
      const image = decodeIcon(packIcon(2, 3))!
      expect(image.getSize()).to.deep.equal({ width: 2, height: 3 })
      expect(decodeIcon(packIcon(2, 3).slice(0, -4))).to.equal(undefined)
      expect(decodeIcon(packIcon(1000, 1))).to.equal(undefined)
      expect(decodeIcon('')).to.equal(undefined)
    })
  })
})
