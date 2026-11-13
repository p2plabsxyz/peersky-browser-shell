import { expect } from 'chai'
import { session } from 'electron'
import { EventEmitter, once } from 'node:events'
import * as path from 'node:path'

import { ElectronChromeExtensions } from '../'
import { uuid } from './spec-helpers'

import { BookmarksAPI } from '../src/browser/api/bookmarks'
import { HistoryAPI } from '../src/browser/api/history'
import { TopSitesAPI } from '../src/browser/api/top-sites'
import { ReadingListAPI } from '../src/browser/api/reading-list'
import { SearchAPI } from '../src/browser/api/search'
import { OmniboxAPI, parseOmniboxDescription } from '../src/browser/api/omnibox'

const ext = (id: string, permissions: string[], extra: Record<string, unknown> = {}): any => ({
  id,
  name: id,
  manifest: { manifest_version: 3, permissions, ...extra },
})

/** A fake ExtensionContext: handlers, sent events and the saved state are all visible. */
const makeCtx = (extensions: any[], saved: Record<string, unknown> = {}) => {
  const handlers = new Map<string, Function>()
  const events: Array<{ id: string; name: string; args: any[] }> = []
  const emitted: Array<{ name: string; args: any[] }> = []
  const state: Record<string, unknown> = saved
  let flushes = 0
  const sessionExtensions: any = new EventEmitter()
  sessionExtensions.getAllExtensions = () => extensions
  sessionExtensions.getExtension = (id: string) => extensions.find((e) => e.id === id) ?? null
  const store: any = new EventEmitter()
  store.impl = {}
  store.gestures = [] as string[]
  store.noteUserGesture = (id: string) => store.gestures.push(id)
  const ctx: any = {
    emit: (name: string, ...args: any[]) => emitted.push({ name, args }),
    router: {
      apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
      sendEvent: (id: string, name: string, ...args: any[]) => events.push({ id, name, args }),
      sendEventWhenListening: (id: string, name: string, args: any[]) => events.push({ id, name, args }),
    },
    session: { extensions: sessionExtensions },
    store,
    stateStore: {
      whenHydrated: async () => {},
      getNamespace: (name: string, fallback: unknown) => state[name] ?? fallback,
      setNamespace: (name: string, value: unknown) => {
        state[name] = value
      },
      flush: async () => {
        flushes++
      },
    },
    permissions: { has: (e: any, p: string) => (e.manifest.permissions || []).includes(p) },
  }
  const call = (name: string, extension: any, ...args: any[]) =>
    Promise.resolve().then(() => handlers.get(name)!({ type: 'service-worker', sender: {}, extension }, ...args))
  /** What a restart reads back: the state as written to disk. */
  const disk = () => JSON.parse(JSON.stringify(state))
  return { ctx, handlers, events, emitted, state, call, disk, sessionExtensions, store, flushes: () => flushes }
}

const fakeTab = (id: number, url = '') => {
  const tab: any = new EventEmitter()
  tab.id = id
  tab.url = url
  tab.getURL = () => tab.url
  tab.isDestroyed = () => false
  tab.loaded = [] as string[]
  tab.loadURL = async (u: string) => {
    tab.loaded.push(u)
  }
  return tab
}

describe('chrome.bookmarks, history, topSites, readingList, search and omnibox', () => {
  describe('bookmarks', () => {
    const marks = ext('marks', ['bookmarks'])
    const other = ext('other', [])

    it('keeps the tree across a restart, and never gives an id twice', async () => {
      const first = makeCtx([marks])
      new BookmarksAPI(first.ctx)
      const a = await first.call('bookmarks.create', marks, { parentId: '1', title: 'A', url: 'https://a.example' })
      expect(a.id).to.equal('5')
      expect(a.url).to.equal('https://a.example/')
      await first.call('bookmarks.remove', marks, a.id)

      const second = makeCtx([marks], first.disk())
      new BookmarksAPI(second.ctx)
      const b = await second.call('bookmarks.create', marks, { title: 'B', url: 'https://b.example/' })
      expect(b.id).to.equal('6')
      expect(b.parentId).to.equal('2')
      const tree = await second.call('bookmarks.getTree', marks)
      expect(tree[0].children.map((c: any) => c.id)).to.deep.equal(['1', '2'])
      expect(tree[0].children[1].children.map((c: any) => c.title)).to.deep.equal(['B'])
    })

    it('starts again from a fresh tree when the saved one is damaged', async () => {
      const { ctx, call } = makeCtx([marks], { bookmarks: { version: 1, nextId: 9, root: { id: '0', children: 'x' } } })
      new BookmarksAPI(ctx)
      const tree = await call('bookmarks.getTree', marks)
      expect(tree[0].children.map((c: any) => c.title)).to.deep.equal(['Bookmarks Bar', 'Other Bookmarks'])
    })

    it("refuses arguments of the wrong type with Chrome's invocation error", async () => {
      const { ctx, call } = makeCtx([marks])
      new BookmarksAPI(ctx)
      await expect(call('bookmarks.create', marks, { parentId: '1', title: 'x', bogus: true })).to.be.rejectedWith(
        "Error in invocation of bookmarks.create(bookmarks.CreateDetails bookmark, optional function callback): Error at parameter 'bookmark': Unexpected property: 'bogus'.",
      )
      await expect(call('bookmarks.getRecent', marks, 'ten')).to.be.rejectedWith('No matching signature.')
      await expect(call('bookmarks.move', marks, '5')).to.be.rejectedWith('No matching signature.')
    })

    it('sends events only to extensions that hold the bookmarks permission', async () => {
      const { ctx, call, events, emitted } = makeCtx([marks, other])
      new BookmarksAPI(ctx)
      const node = await call('bookmarks.create', marks, { parentId: '1', title: 'A' })
      expect(events.map((e) => [e.id, e.name])).to.deep.equal([['marks', 'bookmarks.onCreated']])
      // The host hears of it too, with the extension that made the change.
      expect(emitted[0].name).to.equal('bookmarks-changed')
      expect(emitted[0].args[0]).to.include({ type: 'created', id: node.id, extensionId: 'marks' })
    })

    it('counts a move index before the node leaves its place, as Chrome does', async () => {
      const { ctx, call, events } = makeCtx([marks])
      new BookmarksAPI(ctx)
      const [a, b] = [
        await call('bookmarks.create', marks, { parentId: '1', title: 'a' }),
        await call('bookmarks.create', marks, { parentId: '1', title: 'b' }),
        await call('bookmarks.create', marks, { parentId: '1', title: 'c' }),
      ]
      events.length = 0
      // Index 1 is where a already is: nothing moves, nothing is sent.
      await call('bookmarks.move', marks, a.id, { index: 1 })
      expect(events).to.deep.equal([])
      const moved = await call('bookmarks.move', marks, a.id, { index: 2 })
      expect(moved.index).to.equal(1)
      expect(events[0].args[1]).to.deep.equal({ parentId: '1', index: 1, oldParentId: '1', oldIndex: 0 })
      const children = await call('bookmarks.getChildren', marks, '1')
      expect(children.map((c: any) => c.title)).to.deep.equal(['b', 'a', 'c'])
      expect(b.title).to.equal('b')
    })

    it('sends one onChanged per change, and none for no change', async () => {
      const { ctx, call, events } = makeCtx([marks])
      new BookmarksAPI(ctx)
      const a = await call('bookmarks.create', marks, { parentId: '1', title: 'a', url: 'https://a.example/' })
      events.length = 0
      await call('bookmarks.update', marks, a.id, { title: 'b', url: 'https://b.example/' })
      await call('bookmarks.update', marks, a.id, { title: 'b' })
      expect(events.map((e) => e.args[1])).to.deep.equal([
        { title: 'b', url: 'https://a.example/' },
        { title: 'b', url: 'https://b.example/' },
      ])
    })

    it('refuses to grow without bound', async () => {
      const { ctx, call } = makeCtx([marks])
      new BookmarksAPI(ctx)
      await expect(
        call('bookmarks.create', marks, { parentId: '1', title: 'x'.repeat(33 * 1024 * 1024) }),
      ).to.be.rejectedWith('Bookmark storage is full.')
    })

    it('refuses folders nested deeper than the state file can hold', async () => {
      const { ctx, call } = makeCtx([marks])
      new BookmarksAPI(ctx)
      let parentId = '1'
      for (let i = 0; i < 199; i++) parentId = (await call('bookmarks.create', marks, { parentId, title: 'f' })).id
      await expect(call('bookmarks.create', marks, { parentId, title: 'too deep' })).to.be.rejectedWith(
        'Bookmark folders are nested too deeply.',
      )
      const top = (await call('bookmarks.getChildren', marks, '1'))[0]
      const other = await call('bookmarks.create', marks, { parentId: '2', title: 'o' })
      await call('bookmarks.create', marks, { parentId: other.id, title: 'child' })
      // Moving a two-level folder under the deepest one would pass the limit too.
      const deepest = (await call('bookmarks.search', marks, { title: 'f' })).pop()
      await expect(call('bookmarks.move', marks, other.id, { parentId: deepest.id })).to.be.rejectedWith(
        'Bookmark folders are nested too deeply.',
      )
      expect(top.title).to.equal('f')
    })

    it("lets the host replace and import its own bookmarks, as an import extensions can follow", async () => {
      const { ctx, call, events, emitted } = makeCtx([marks])
      const api = new BookmarksAPI(ctx)
      await call('bookmarks.create', marks, { parentId: '1', title: 'old' })
      events.length = 0
      emitted.length = 0
      const tree = await api.replaceTree({
        bookmarksBar: [{ title: 'Docs', children: [{ title: 'Spec', url: 'https://spec.example' }] }],
        mobile: [{ title: 'Phone', url: 'https://phone.example/' }, { title: 'bad', url: 'not a url' }],
      })
      expect(events.map((e) => e.name)).to.deep.equal([
        'bookmarks.onImportBegan',
        'bookmarks.onRemoved',
        'bookmarks.onCreated',
        'bookmarks.onCreated',
        'bookmarks.onCreated',
        'bookmarks.onImportEnded',
      ])
      // Mobile bookmarks shows up now it holds something; the bad URL was left out.
      expect(tree[0].children.map((c: any) => [c.id, c.folderType, c.children.length])).to.deep.equal([
        ['1', 'bookmarks-bar', 1],
        ['2', 'other', 0],
        ['3', 'mobile', 1],
      ])
      expect((await call('bookmarks.get', marks, '3'))[0].title).to.equal('Mobile Bookmarks')
      // Changes the host makes are not echoed back to it.
      expect(emitted).to.deep.equal([])

      const added = await api.importNodes([{ title: 'Imported', url: 'https://i.example/' }])
      expect(added[0].parentId).to.equal('2')
      expect((await call('bookmarks.search', marks, 'imported')).length).to.equal(1)
    })
  })

  describe('history', () => {
    const reader = ext('reader', ['history'])
    const tops = ext('tops', ['topSites'])
    const plain = ext('plain', ['storage'])

    const setup = (extensions: any[], saved?: Record<string, unknown>) => {
      const h = makeCtx(extensions, saved)
      const api = new HistoryAPI(h.ctx)
      new TopSitesAPI(h.ctx)
      return { ...h, api }
    }
    const navigate = async (store: any, tab: any, url: string) => {
      tab.url = url
      tab.emit('did-navigate', {}, url, 200, 'OK')
      await new Promise((r) => setTimeout(r, 5))
    }

    it('records top-level visits of tracked tabs, and never the browser’s own pages', async () => {
      const { store, call, events } = setup([reader])
      const tab = fakeTab(7)
      store.emit('tab-added', tab)
      await navigate(store, tab, 'https://news.example/a')
      tab.emit('did-navigate-in-page', {}, 'https://news.example/a#frame', false)
      tab.url = 'https://news.example/b'
      tab.emit('did-navigate-in-page', {}, tab.url, true)
      await new Promise((r) => setTimeout(r, 5))
      tab.emit('page-title-updated', {}, 'News B')
      await new Promise((r) => setTimeout(r, 5))
      await navigate(store, tab, 'peersky://settings')
      await navigate(store, tab, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html')
      const items = await call('history.search', reader, { text: '' })
      expect(items.map((i: any) => [i.url, i.title])).to.deep.equal([
        ['https://news.example/b', 'News B'],
        ['https://news.example/a', ''],
      ])
      expect(events.filter((e) => e.name === 'history.onVisited').map((e) => e.id)).to.deep.equal(['reader', 'reader'])
    })

    it('keeps no visits when no loaded extension holds history or topSites', async () => {
      const { store, state } = setup([plain])
      const tab = fakeTab(1)
      store.emit('tab-added', tab)
      await navigate(store, tab, 'https://private.example/')
      expect(state.history).to.equal(undefined)
    })

    it('throws the visits away when the last extension that needed them unloads', async () => {
      const extensions = [reader, plain]
      const { store, state, sessionExtensions } = setup(extensions)
      const tab = fakeTab(1)
      store.emit('tab-added', tab)
      await navigate(store, tab, 'https://kept.example/')
      expect((state.history as any).urls.length).to.equal(1)
      extensions.splice(0, 1)
      sessionExtensions.emit('extension-unloaded', {}, reader)
      await new Promise((r) => setTimeout(r, 5))
      expect(state.history).to.equal(undefined)
    })

    it('waits for extensions to load after a restart before it drops saved visits', async () => {
      const saved = { history: { version: 1, nextUrlId: 2, nextVisitId: 2, urls: [{ id: 1, url: 'https://x.example/', title: 'X', typedCount: 0, visits: [[1, Date.now(), 0]] }] } }
      const { api, state } = setup([], JSON.parse(JSON.stringify(saved)))
      expect(await api.dropIfUnneeded()).to.equal(false)
      expect(state.history).to.not.equal(undefined)
      api.startupGraceMs = 0
      expect(await api.dropIfUnneeded()).to.equal(true)
      expect(state.history).to.equal(undefined)
    })

    it('keeps visits across a restart, and forgets those older than 90 days', async () => {
      const old = Date.now() - 91 * 24 * 60 * 60 * 1000
      const saved = {
        history: {
          version: 1,
          nextUrlId: 3,
          nextVisitId: 3,
          urls: [
            { id: 1, url: 'https://old.example/', title: 'Old', typedCount: 0, visits: [[1, old, 0]] },
            { id: 2, url: 'https://new.example/', title: 'New', typedCount: 0, visits: [[2, Date.now() - 1000, 0]] },
          ],
        },
      }
      const { call } = setup([reader], JSON.parse(JSON.stringify(saved)))
      const items = await call('history.search', reader, { text: '', startTime: 0 })
      expect(items.map((i: any) => i.title)).to.deep.equal(['New'])
    })

    it('clears visits since a time when the host asks (clear-history), and all on clearHistory()', async () => {
      const { store, call, events, api } = setup([reader])
      await call('history.addUrl', reader, { url: 'https://a.example/' })
      const since = Date.now() + 1
      await new Promise((r) => setTimeout(r, 5))
      await call('history.addUrl', reader, { url: 'https://b.example/' })
      events.length = 0
      store.emit('clear-history', { since })
      await new Promise((r) => setTimeout(r, 5))
      expect(events.map((e) => e.args[0])).to.deep.equal([{ allHistory: false, urls: ['https://b.example/'] }])
      expect((await call('history.search', reader, { text: '' })).map((i: any) => i.url)).to.deep.equal(['https://a.example/'])
      await api.clear()
      expect(events[1].args[0]).to.deep.equal({ allHistory: true, urls: [] })
      expect(await call('history.search', reader, { text: '' })).to.deep.equal([])
    })

    it("follows Chrome's addUrl: a first visit to an intranet name counts as typed", async () => {
      const { call } = setup([reader])
      await call('history.addUrl', reader, { url: 'http://intranet/' })
      await call('history.addUrl', reader, { url: 'http://intranet/' })
      await call('history.addUrl', reader, { url: 'https://example.com/' })
      expect((await call('history.getVisits', reader, { url: 'http://intranet/' })).map((v: any) => v.transition)).to.deep.equal(['typed', 'link'])
      expect((await call('history.getVisits', reader, { url: 'https://example.com/' })).map((v: any) => v.transition)).to.deep.equal(['link'])
      await expect(call('history.addUrl', reader, { url: 'not a url' })).to.be.rejectedWith('Url is invalid.')
      // Taken, but not kept, as Chrome does for its own pages.
      await call('history.addUrl', reader, { url: 'peersky://settings' })
      expect((await call('history.search', reader, { text: 'settings', startTime: 0 })).length).to.equal(0)
    })

    it('drops the oldest pages when huge URLs would fill the state file', async () => {
      const { call } = setup([reader])
      const big = (i: number) => `data:text/plain,${i}${'x'.repeat(2 * 1024 * 1024 - 32)}`
      for (let i = 0; i < 9; i++) await call('history.addUrl', reader, { url: big(i) })
      const kept = await call('history.search', reader, { text: '', startTime: 0, maxResults: 0 })
      expect(kept.length).to.be.lessThan(9)
      expect(kept[0].url).to.equal(big(8))
    })

    it('sends onVisited only to extensions holding history; topSites lists the most visited', async () => {
      const { call, events } = setup([reader, tops])
      await call('history.addUrl', reader, { url: 'https://one.example/' })
      await call('history.addUrl', reader, { url: 'https://two.example/' })
      await call('history.addUrl', reader, { url: 'https://two.example/' })
      expect(new Set(events.map((e) => e.id))).to.deep.equal(new Set(['reader']))
      const top = await call('topSites.get', tops)
      expect(top).to.deep.equal([
        { url: 'https://two.example/', title: '' },
        { url: 'https://one.example/', title: '' },
      ])
    })
  })

  describe('readingList', () => {
    const reader = ext('reader', ['readingList'])
    const other = ext('other', [])

    it('keeps the list across a restart, web pages only, with events for permitted extensions', async () => {
      const first = makeCtx([reader, other])
      new ReadingListAPI(first.ctx)
      await first.call('readingList.addEntry', reader, { title: 'T', url: 'https://r.example', hasBeenRead: false })
      await expect(
        first.call('readingList.addEntry', reader, { title: 'P', url: 'peersky://settings', hasBeenRead: false }),
      ).to.be.rejectedWith('URL is not supported.')
      expect(first.events.map((e) => e.id)).to.deep.equal(['reader'])

      const second = makeCtx([reader], first.disk())
      new ReadingListAPI(second.ctx)
      const entries = await second.call('readingList.query', reader, {})
      expect(entries.map((e: any) => [e.url, e.title, e.hasBeenRead])).to.deep.equal([['https://r.example/', 'T', false]])
      await expect(
        second.call('readingList.addEntry', reader, { title: 'Again', url: 'https://r.example/', hasBeenRead: true }),
      ).to.be.rejectedWith('Duplicate URL.')
    })
  })

  describe('search', () => {
    const searcher = ext('searcher', ['search'])

    const setup = () => {
      const h = makeCtx([searcher])
      const active = fakeTab(11)
      const win = { id: 3 }
      const created: any[] = []
      h.store.getTabById = (id: number) => (id === 11 ? active : undefined)
      h.store.getCurrentWindowForExtension = () => win
      h.store.getActiveTabFromWindow = () => active
      h.store.createTab = async (details: any) => created.push(['tab', details])
      h.store.createWindow = async (_event: any, details: any) => created.push(['window', details])
      new SearchAPI(h.ctx)
      return { ...h, active, created }
    }

    it("searches with the host's engine, in the tab or window asked for", async () => {
      const { call, store, active, created } = setup()
      store.impl.getSearchUrl = (text: string) => `https://search.example/?q=${encodeURIComponent(text)}`
      await call('search.query', searcher, { text: 'peer to peer' })
      expect(active.loaded).to.deep.equal(['https://search.example/?q=peer%20to%20peer'])
      await call('search.query', searcher, { text: 'a', disposition: 'NEW_TAB' })
      await expect(call('search.query', searcher, { text: 'a', tabId: 99 })).to.be.rejectedWith('No tab with id: 99.')
      // Without createWindow, a new window is a new tab.
      await call('search.query', searcher, { text: 'b', disposition: 'NEW_WINDOW' })
      store.impl.createWindow = () => {}
      await call('search.query', searcher, { text: 'c', disposition: 'NEW_WINDOW' })
      expect(created).to.deep.equal([
        ['tab', { url: 'https://search.example/?q=a', active: true }],
        ['tab', { url: 'https://search.example/?q=b', active: true }],
        ['window', { url: 'https://search.example/?q=c', focused: true }],
      ])
    })

    it('falls back to DuckDuckGo when the hook gives nothing usable', async () => {
      const { call, store, active } = setup()
      store.impl.getSearchUrl = () => 'javascript:alert(1)'
      await call('search.query', searcher, { text: 'x y' })
      expect(active.loaded).to.deep.equal(['https://duckduckgo.com/?q=x%20y'])
    })
  })

  describe('omnibox', () => {
    const keyworded = ext('kw', [], { omnibox: { keyword: 'kw' } })
    const plain = ext('plain', [])
    const otherKw = ext('kw2', [], { omnibox: { keyword: 'two' } })

    it('turns a description into text and styles', () => {
      expect(parseOmniboxDescription('Go to <url>a.example</url> <match>now</match> &amp; <dim><match>x</match></dim>')).to.deep.equal({
        text: 'Go to a.example now & x',
        styles: [
          { type: 'url', offset: 6, length: 9 },
          { type: 'match', offset: 16, length: 3 },
          { type: 'match', offset: 22, length: 1 },
          { type: 'dim', offset: 22, length: 1 },
        ],
      })
      expect(parseOmniboxDescription('<b>plain</b> <![CDATA[<raw>]]> &#x263A;').text).to.equal('plain <raw> ☺')
      expect(() => parseOmniboxDescription('a</fragment><x>')).to.throw(
        'Invalid XML: bad content: Entity: line 1: parser error : Extra content at the end of the document',
      )
    })

    it('lists keywords, and hands the host the suggestions for its own request only', async () => {
      const { ctx, call, events, store } = makeCtx([keyworded, plain, otherKw])
      const api = new OmniboxAPI(ctx)
      expect(api.getKeywords()).to.deep.equal([
        { extensionId: 'kw', keyword: 'kw', name: 'kw' },
        { extensionId: 'kw2', keyword: 'two', name: 'kw2' },
      ])
      const tick = () => new Promise((r) => setTimeout(r, 0))
      const pending = api.inputChanged('kw', 'hello')
      await tick()
      const [text, requestId] = events[0].args
      expect([events[0].name, text]).to.deep.equal(['omnibox.onInputChanged', 'hello'])
      // Another extension cannot answer it, and a stale request id is dropped.
      await call('omnibox.sendSuggestions', otherKw, requestId, [{ content: 'evil', description: 'evil' }])
      await call('omnibox.sendSuggestions', keyworded, requestId + 1, [{ content: 'old', description: 'old' }])
      await call('omnibox.sendSuggestions', keyworded, requestId, [
        { content: 'hello world', description: 'Say <match>hello</match>', deletable: true },
      ])
      expect(await pending).to.deep.equal([
        {
          content: 'hello world',
          description: 'Say hello',
          descriptionStyles: [{ type: 'match', offset: 4, length: 5 }],
          deletable: true,
        },
      ])
      expect(await api.inputChanged('kw', 'late', 10)).to.deep.equal([])
      api.inputEntered('kw', 'hello world', 'newForegroundTab')
      await tick()
      expect(store.gestures).to.deep.equal(['kw'])
      expect(events[events.length - 1]).to.deep.equal({ id: 'kw', name: 'omnibox.onInputEntered', args: ['hello world', 'newForegroundTab'] })
      expect(() => api.inputEntered('kw', 'x', 'sideways' as any)).to.throw('Unknown disposition')
      expect(() => api.inputStarted('plain')).to.throw('has no omnibox keyword')
    })

    it('keeps the default suggestion, and refuses an extension without an omnibox key', async () => {
      const { ctx, call, disk } = makeCtx([keyworded, plain])
      new OmniboxAPI(ctx)
      await call('omnibox.setDefaultSuggestion', keyworded, { description: 'Search <match>%s</match>' })
      await expect(call('omnibox.setDefaultSuggestion', plain, { description: 'x' })).to.be.rejectedWith(
        "requires the 'omnibox' manifest key",
      )
      const restarted = makeCtx([keyworded], disk())
      const api = new OmniboxAPI(restarted.ctx)
      expect(await api.getDefaultSuggestion('kw')).to.deep.equal({
        description: 'Search %s',
        descriptionStyles: [{ type: 'match', offset: 7, length: 2 }],
      })
    })
  })

  describe('omnibox, end to end with a service worker', () => {
    let ses: Electron.Session
    let extensions: ElectronChromeExtensions
    let extension: Electron.Extension

    before(async () => {
      ses = session.fromPartition(`persist:omnibox-${uuid()}`)
      extensions = new ElectronChromeExtensions({ license: 'internal-license-do-not-use' as any, session: ses })
      extension = await (ses.extensions || ses).loadExtension(path.join(__dirname, 'fixtures', 'chrome-omnibox'))
    })

    const told = async (action: () => void) => {
      const heard = once(extensions, 'omnibox-default-suggestion')
      action()
      const [info] = (await heard) as any[]
      return info.description
    }

    // Driven right after the extension loads, before its worker can start.
    it('drives the extension from the host, as an address bar would', async function () {
      this.timeout(30_000)
      expect(extensions.getOmniboxKeywords()).to.deep.equal([
        { extensionId: extension.id, keyword: 'omni', name: 'chrome-omnibox' },
      ])
      expect(await told(() => extensions.omniboxInputStarted(extension.id))).to.equal('started')
      const suggestions = await extensions.omniboxInputChanged(extension.id, 'cats', { timeoutMs: 10_000 })
      expect(suggestions).to.deep.equal([
        {
          content: 'cats one',
          description: 'First cats',
          descriptionStyles: [{ type: 'match', offset: 6, length: 4 }],
          deletable: false,
        },
        {
          content: 'cats two',
          description: 'Second',
          descriptionStyles: [{ type: 'dim', offset: 0, length: 6 }],
          deletable: true,
        },
      ])
      expect(await told(() => extensions.omniboxInputEntered(extension.id, 'cats one', 'newForegroundTab'))).to.equal(
        'entered cats one newForegroundTab',
      )
      expect(await told(() => extensions.omniboxDeleteSuggestion(extension.id, 'cats two'))).to.equal('deleted cats two')
      expect(await told(() => extensions.omniboxInputCancelled(extension.id))).to.equal('cancelled')
      expect((await extensions.getOmniboxDefaultSuggestion(extension.id))?.description).to.equal('cancelled')
    })

    it("throws Chrome's invocation error in the worker when suggest gets a bad suggestion", async () => {
      const heard = once(extensions, 'omnibox-default-suggestion')
      expect(await extensions.omniboxInputChanged(extension.id, 'bad', { timeoutMs: 1000 })).to.deep.equal([])
      const [info] = (await heard) as any[]
      expect(info.description).to.equal(
        "threw Error in invocation of omnibox.sendSuggestions(integer requestId, array suggestResults): Error at parameter 'suggestResults': Error at index 0: Missing required property 'content'.",
      )
    })
  })
})
