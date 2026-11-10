import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { AlarmsAPI } from '../src/browser/api/alarms'
import { parseCssColor } from '../src/browser/api/browser-action'
import { formatShortcut } from '../src/browser/api/commands'
import { ContextMenusAPI } from '../src/browser/api/context-menus'
import { ManagementAPI, permissionWarnings } from '../src/browser/api/management'
import { NotificationsAPI } from '../src/browser/api/notifications'
import { chromeJsonBytes, StorageSyncAPI } from '../src/browser/api/storage-sync'
import { ExtensionStateStore } from '../src/browser/state-store'

// The platform APIs (storage, alarms, management, ...) with a fake context:
// what the parity probe cannot reach in one run, such as a restart, a quota
// or a refusal.

const fakeExtension = (id: string, manifest: any = {}, extra: any = {}): any => ({
  id,
  name: manifest.name || id,
  path: `/extensions/${id}`,
  url: `chrome-extension://${id}/`,
  version: manifest.version || '1.0',
  manifest: { manifest_version: 3, version: '1.0', ...manifest },
  ...extra,
})

function createContext(opts: { storagePath?: string; extensions?: any[]; impl?: any; stateDir?: string } = {}) {
  const handlers = new Map<string, Function>()
  const events: Array<{ extensionId?: string; name: string; args: any[] }> = []
  const sessionExtensions: any = new EventEmitter()
  const loaded = new Map<string, any>((opts.extensions || []).map((e) => [e.id, e]))
  sessionExtensions.getExtension = (id: string) => loaded.get(id) || null
  sessionExtensions.getAllExtensions = () => [...loaded.values()]
  sessionExtensions.removeExtension = (id: string) => {
    const ext = loaded.get(id)
    loaded.delete(id)
    if (ext) sessionExtensions.emit('extension-unloaded', {}, ext)
  }
  sessionExtensions.loadExtension = async (p: string) => {
    const ext = (opts.extensions || []).find((e) => e.path === p)
    loaded.set(ext.id, ext)
    sessionExtensions.emit('extension-loaded', {}, ext)
    return ext
  }
  const session: any = { extensions: sessionExtensions, storagePath: opts.storagePath ?? null, partition: 'test' }
  const store: any = new EventEmitter()
  store.impl = opts.impl || {}
  store.gesture = false
  store.hasUserGesture = () => store.gesture
  store.noteUserGesture = () => {}
  store.getTabById = () => undefined
  store.getLastFocusedWindow = () => undefined
  store.getActiveTabOfCurrentWindow = () => undefined
  store.tabDetailsCache = new Map()
  const stateStore = opts.stateDir
    ? new ExtensionStateStore(session, { baseDir: opts.stateDir })
    : { whenHydrated: async () => {}, getNamespace: (_n: string, f: any) => f, setNamespace: () => {}, flush: async () => {} }
  const permissions: any = {
    has: (ext: any, p: string) => (ext.manifest.permissions || []).includes(p),
    getAll: (ext: any) => ({ permissions: ext.manifest.permissions || [], origins: ext.manifest.host_permissions || [] }),
  }
  const router: any = {
    apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
    sendEvent: (extensionId: string, name: string, ...args: any[]) => events.push({ extensionId, name, args }),
    sendEventWhenListening: (extensionId: string, name: string, args: any[]) => events.push({ extensionId, name, args }),
    broadcastEvent: (name: string, ...args: any[]) => events.push({ name, args }),
  }
  const ctx: any = { router, session, store, stateStore, permissions, emit: () => {} }
  const call = (name: string, extension: any, ...args: any[]) =>
    Promise.resolve().then(() => handlers.get(name)!({ type: 'service-worker', extension, gesture: false }, ...args))
  const callWithGesture = (name: string, extension: any, ...args: any[]) =>
    Promise.resolve().then(() => handlers.get(name)!({ type: 'frame', extension, gesture: true }, ...args))
  return { ctx, handlers, events, call, callWithGesture, sessionExtensions, loaded }
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error: any) {
    return error.message as string
  }
  return undefined
}

describe('platform APIs', () => {
  let temp: string

  beforeEach(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-platform-'))
  })

  afterEach(async () => {
    // A save may still be writing its temporary file; try again then.
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  describe('chrome.storage', () => {
    const ext = fakeExtension('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { permissions: ['storage'] })

    it('keeps local and sync for the next run of the app, in the session folder', async () => {
      const first = createContext({ storagePath: temp, extensions: [ext] })
      new StorageSyncAPI(first.ctx)
      await first.call('storage.local.set', ext, { a: 1, nested: { b: [1, 2] } })
      await first.call('storage.sync.set', { ...ext }, { s: 'x' })

      const second = createContext({ storagePath: temp, extensions: [ext] })
      new StorageSyncAPI(second.ctx)
      expect(await second.call('storage.local.get', ext, null)).to.deep.equal({ a: 1, nested: { b: [1, 2] } })
      expect(await second.call('storage.sync.get', ext, 's')).to.deep.equal({ s: 'x' })
      const files = await fs.readdir(path.join(temp, 'extension-local'))
      expect(files).to.deep.equal([`${ext.id}.json`])
    })

    it('writes nothing to disk for a session without a folder', async () => {
      const { ctx, call } = createContext({ extensions: [ext] })
      new StorageSyncAPI(ctx)
      await call('storage.local.set', ext, { a: 1 })
      expect(await call('storage.local.get', ext, 'a')).to.deep.equal({ a: 1 })
      expect(await fs.readdir(temp)).to.deep.equal([])
    })

    it('stores keys such as __proto__ as data, without reaching a prototype', async () => {
      const { ctx, call } = createContext({ storagePath: temp, extensions: [ext] })
      new StorageSyncAPI(ctx)
      await call('storage.local.set', ext, JSON.parse('{"__proto__": {"polluted": true}, "constructor": 2}'))
      const all: any = await call('storage.local.get', ext, null)
      expect(Object.keys(all)).to.deep.equal(['__proto__', 'constructor'])
      expect(all.polluted).to.equal(undefined)
      expect(({} as any).polluted).to.equal(undefined)
    })

    it('holds sync to its item count, total and per-item quotas, and writes nothing past one', async () => {
      const { ctx, call } = createContext({ storagePath: temp, extensions: [ext] })
      new StorageSyncAPI(ctx)
      const many: Record<string, number> = {}
      for (let i = 0; i < 513; i++) many[`k${i}`] = 1
      expect(await errorOf(call('storage.sync.set', ext, many))).to.equal('Resource::kMaxItems quota exceeded')
      const big: Record<string, string> = {}
      for (let i = 0; i < 20; i++) big[`t${i}`] = 'x'.repeat(8000)
      expect(await errorOf(call('storage.sync.set', ext, big))).to.equal('Resource::kQuotaBytes quota exceeded')
      // 'e' plus '"', 8190 letters and '"' is 8193 bytes: one too many.
      expect(await errorOf(call('storage.sync.set', ext, { e: 'x'.repeat(8190) }))).to.equal(
        'Resource::kQuotaBytesPerItem quota exceeded',
      )
      await call('storage.sync.set', ext, { e: 'x'.repeat(8189) })
      expect(await call('storage.sync.getBytesInUse', ext, null)).to.equal(8192)
    })

    it('limits sync writes to 120 a minute, per method, as Chrome does', async () => {
      const { ctx, call } = createContext({ extensions: [ext] })
      new StorageSyncAPI(ctx)
      for (let i = 0; i < 120; i++) await call('storage.sync.set', ext, { n: i })
      expect(await errorOf(call('storage.sync.set', ext, { n: 'over' }))).to.equal(
        'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.',
      )
      expect(await call('storage.sync.get', ext, 'n')).to.deep.equal({ n: 119 })
      await call('storage.sync.remove', ext, 'n')
    })

    it('holds local to 10 MB unless the extension has unlimitedStorage', async () => {
      const unlimited = fakeExtension('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { permissions: ['storage', 'unlimitedStorage'] })
      const { ctx, call } = createContext({ extensions: [ext, unlimited] })
      new StorageSyncAPI(ctx)
      const huge = { huge: 'x'.repeat(10 * 1024 * 1024) }
      expect(await errorOf(call('storage.local.set', ext, huge))).to.equal('Resource::kQuotaBytes quota exceeded')
      await call('storage.local.set', unlimited, huge)
    })

    it('counts bytes as Chrome does', () => {
      expect(chromeJsonBytes('ü<')).to.equal(10)
      expect(chromeJsonBytes(3000000000)).to.equal(12)
      expect(chromeJsonBytes(0.1)).to.equal(3)
      expect(chromeJsonBytes({ d: [1, 2] })).to.equal(11)
    })

    it('fires onChanged only for real changes, with the area', async () => {
      const { ctx, call, events } = createContext({ extensions: [ext] })
      new StorageSyncAPI(ctx)
      await call('storage.local.set', ext, { same: 1 })
      await call('storage.local.set', ext, { same: 1 })
      await call('storage.local.remove', ext, 'missing')
      await call('storage.local.clear', ext)
      await call('storage.local.clear', ext)
      expect(events.map((e) => [e.name, e.args])).to.deep.equal([
        ['storage.onChanged', [{ same: { newValue: 1 } }, 'local']],
        ['storage.onChanged', [{ same: { oldValue: 1 } }, 'local']],
      ])
    })

    it('refuses writes to managed and reads the host policy', async () => {
      const { ctx, call } = createContext({
        extensions: [ext],
        impl: { getManagedStorage: () => ({ policy: true }) },
      })
      new StorageSyncAPI(ctx)
      expect(await call('storage.managed.get', ext, null)).to.deep.equal({ policy: true })
      for (const method of ['set', 'remove', 'clear']) {
        expect(await errorOf(call(`storage.managed.${method}`, ext, { a: 1 }))).to.equal('This is a read-only store.')
      }
    })

    it('deletes an extension storage file when it is uninstalled', async () => {
      const { ctx, call } = createContext({ storagePath: temp, extensions: [ext] })
      new StorageSyncAPI(ctx)
      await call('storage.local.set', ext, { a: 1 })
      ctx.store.emit('extension-uninstalled', ext.id)
      await call('storage.local.getKeys', ext)
      expect(await fs.readdir(path.join(temp, 'extension-local'))).to.deep.equal([])
    })
  })

  describe('chrome.alarms', () => {
    const ext = fakeExtension('cccccccccccccccccccccccccccccccc', { permissions: ['alarms'] })

    it('comes back after a restart and after the extension loads again, and is gone after an uninstall', async () => {
      const first = createContext({ stateDir: temp, extensions: [ext] })
      new AlarmsAPI(first.ctx)
      await first.call('alarms.create', ext, 'later', { delayInMinutes: 30 })
      await first.ctx.stateStore.flush()

      const second = createContext({ stateDir: temp, extensions: [ext] })
      await second.ctx.stateStore.hydrate()
      new AlarmsAPI(second.ctx)
      const alarm: any = await second.call('alarms.get', ext, 'later')
      expect(alarm.name).to.equal('later')
      expect(alarm.persistAcrossSessions).to.equal(true)

      second.sessionExtensions.removeExtension(ext.id)
      expect(await second.call('alarms.getAll', ext)).to.deep.equal([])
      await second.sessionExtensions.loadExtension(ext.path)
      await new Promise((r) => setTimeout(r, 10))
      expect(((await second.call('alarms.getAll', ext)) as any[]).map((a) => a.name)).to.deep.equal(['later'])

      second.ctx.store.emit('extension-uninstalled', ext.id)
      expect(await second.call('alarms.getAll', ext)).to.deep.equal([])
    })

    it('refuses a 501st alarm and holds an installed extension to 30 seconds', async () => {
      const store = fakeExtension('dddddddddddddddddddddddddddddddd', { permissions: ['alarms'] })
      const { ctx, call } = createContext({ extensions: [store], impl: { getExtensionInstallType: () => 'normal' } })
      new AlarmsAPI(ctx)
      await call('alarms.create', store, 'soon', { delayInMinutes: 0.01 })
      const soon: any = await call('alarms.get', store, 'soon')
      expect(soon.scheduledTime - Date.now()).to.be.greaterThan(25_000)
      for (let i = 1; i < 500; i++) await call('alarms.create', store, `a${i}`, { delayInMinutes: 10 })
      expect(await errorOf(call('alarms.create', store, 'one more', { delayInMinutes: 10 }))).to.equal(
        'An extension cannot have more than 500 active alarms.',
      )
      await call('alarms.clearAll', store)
    })
  })

  describe('chrome.management', () => {
    const watcher = fakeExtension('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', { permissions: ['management'] })
    const nosy = fakeExtension('ffffffffffffffffffffffffffffffff', { permissions: [] })
    const target = fakeExtension('gggggggggggggggggggggggggggggggg', { name: 'Target', permissions: ['storage'] })

    it('turns another extension off and on by unloading and loading it, and tells only extensions with management', async () => {
      const { ctx, call, events, loaded } = createContext({ extensions: [watcher, nosy, target] })
      new ManagementAPI(ctx)
      await call('management.setEnabled', watcher, target.id, false)
      expect(loaded.has(target.id)).to.equal(false)
      const off: any = await call('management.get', watcher, target.id)
      expect(off.enabled).to.equal(false)
      expect(off.disabledReason).to.equal('unknown')
      await call('management.setEnabled', watcher, target.id, true)
      expect(loaded.has(target.id)).to.equal(true)
      expect(events.map((e) => [e.extensionId, e.name])).to.deep.equal([
        [watcher.id, 'management.onDisabled'],
        [watcher.id, 'management.onEnabled'],
      ])
    })

    it('leaves turning extensions off to the host when it has the hook', async () => {
      const calls: any[] = []
      const { ctx, call, loaded } = createContext({
        extensions: [watcher, target],
        impl: { setExtensionEnabled: (details: any) => calls.push(details) },
      })
      new ManagementAPI(ctx)
      await call('management.setEnabled', watcher, target.id, false)
      expect(calls).to.deep.equal([{ id: target.id, path: target.path, enabled: false }])
      expect(loaded.has(target.id)).to.equal(true)
    })

    it('removes an extension only after a gesture and the person saying yes', async () => {
      let answer = false
      const asked: any[] = []
      const { ctx, call, callWithGesture, loaded, events } = createContext({
        extensions: [watcher, target],
        impl: { confirmUninstall: (d: any) => (asked.push(d), answer) },
      })
      new ManagementAPI(ctx)
      expect(await errorOf(call('management.uninstall', watcher, target.id))).to.equal(
        'chrome.management.uninstall requires a user gesture.',
      )
      expect(await errorOf(callWithGesture('management.uninstall', watcher, target.id))).to.equal(
        `Extension ${target.id} uninstall canceled by user.`,
      )
      expect(loaded.has(target.id)).to.equal(true)
      answer = true
      const uninstalled: string[] = []
      ctx.store.on('extension-uninstalled', (id: string) => uninstalled.push(id))
      await callWithGesture('management.uninstall', watcher, target.id)
      expect(loaded.has(target.id)).to.equal(false)
      expect(uninstalled).to.deep.equal([target.id])
      expect(asked[0].by.id).to.equal(watcher.id)
      expect(events.some((e) => e.name === 'management.onUninstalled' && e.args[0] === target.id)).to.equal(true)
    })

    it('words permission warnings as Chrome does', () => {
      expect(permissionWarnings(['tabs', 'history'], [])).to.deep.equal([
        'Read and change your browsing history on all your signed-in devices',
      ])
      expect(permissionWarnings(['tabs'], ['<all_urls>'])).to.deep.equal([
        'Read and change all your data on all websites',
      ])
      expect(permissionWarnings([], ['https://a.example/*', 'https://*.b.example/*'])).to.deep.equal([
        'Read and change your data on a.example and all b.example sites',
      ])
      expect(permissionWarnings(['clipboardRead', 'clipboardWrite', 'storage'], [])).to.deep.equal([
        'Read and modify data you copy and paste',
      ])
    })
  })

  describe('chrome.contextMenus', () => {
    const ext = fakeExtension('hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh', { permissions: ['contextMenus'] })

    it('refuses duplicates, missing parents, cycles and bad patterns with Chrome messages, and removes children with a parent', async () => {
      const { ctx, call } = createContext({ extensions: [ext] })
      const menus = new ContextMenusAPI(ctx)
      await call('contextMenus.create', ext, { id: 'p', title: 'P' })
      await call('contextMenus.create', ext, { id: 'c', parentId: 'p', title: 'C' })
      await call('contextMenus.create', ext, { id: 5, title: 'number five' })
      expect(await errorOf(call('contextMenus.create', ext, { id: 'p', title: 'again' }))).to.equal(
        'Cannot create item with duplicate id p',
      )
      expect(await errorOf(call('contextMenus.create', ext, { id: 'x', parentId: 'nope', title: 'X' }))).to.equal(
        'Cannot find menu item with id nope',
      )
      expect(await errorOf(call('contextMenus.update', ext, 'p', { parentId: 'c' }))).to.equal('Unknown error.')
      expect(await errorOf(call('contextMenus.create', ext, { id: 'u', title: 'U', documentUrlPatterns: ['nope'] }))).to.equal(
        "Invalid url pattern 'nope'",
      )
      // 5 and '5' are two ids.
      expect(await errorOf(call('contextMenus.remove', ext, '5'))).to.equal('Cannot find menu item with id 5')
      await call('contextMenus.remove', ext, 'p')
      expect(await errorOf(call('contextMenus.update', ext, 'c', { title: 'x' }))).to.equal(
        'Cannot find menu item with id c',
      )
      expect((menus as any).menus.get(ext.id).size).to.equal(1)
    })
  })

  describe('chrome.notifications', () => {
    const ext = fakeExtension('iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii', { permissions: ['notifications'] })

    it('answers clear and update for a missing id with false, and lists open ones as an object', async () => {
      const { ctx, call } = createContext({ extensions: [ext] })
      new NotificationsAPI(ctx)
      expect(await call('notifications.clear', ext, 'nope')).to.equal(false)
      expect(await call('notifications.update', ext, 'nope', { title: 'x' })).to.equal(false)
      expect(await call('notifications.getAll', ext)).to.deep.equal({})
      expect(await errorOf(call('notifications.create', ext, 'n', { type: 'fancy' }))).to.match(
        /Value must be one of basic, image, list, progress\.$/,
      )
    })
  })

  describe('chrome.action and chrome.commands', () => {
    it('parses colours as Chrome does', () => {
      expect(parseCssColor('#f008')).to.deep.equal([255, 0, 0, 136])
      expect(parseCssColor('rgba(1,2,3,0.5)')).to.deep.equal([1, 2, 3, 127])
      expect(parseCssColor('hsl(120,100%,50%)')).to.deep.equal([0, 255, 0, 255])
      expect(parseCssColor('red')).to.deep.equal([255, 0, 0, 255])
      for (const bad of ['transparent', ' #00ff00', 'rgb(300,0,0)', '#12345']) {
        expect(() => parseCssColor(bad)).to.throw('The color specification could not be parsed.')
      }
    })

    it('shows shortcuts in the platform form', () => {
      expect(formatShortcut('Ctrl+Shift+Y', 'darwin')).to.equal('⇧⌘Y')
      expect(formatShortcut('Shift+Ctrl+Y', 'linux')).to.equal('Ctrl+Shift+Y')
      expect(formatShortcut('MacCtrl+Alt+K', 'darwin')).to.equal('⌃⌥K')
    })
  })
})
