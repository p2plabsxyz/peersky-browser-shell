import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { readStorageFile, StorageCrypto, writeStorageFile } from './storage-file'

/**
 * chrome.storage.local and chrome.storage.sync, kept by the shell in one
 * encrypted file per extension and area in the session's folder (in memory for
 * a session without one), with Chrome's quotas, errors and change events.
 *
 * chrome.storage.session is Electron's own, which is Chrome's code: it lives
 * in memory, and content scripts share it. Content scripts reach only
 * Electron's local and sync, which the shell cannot serve.
 */
type Area = 'sync' | 'local'
type Data = Record<string, unknown>

interface AreaLimits {
  quotaBytes?: number
  quotaBytesPerItem?: number
  maxItems?: number
  writesPerMinute?: number
  writesPerHour?: number
}

/** Extensions whose 1.x local storage was moved into Electron's own store. */
const LOCAL_MOVED_NS = 'storage.local.moved'
/** Extensions whose 1.x local data was handed out once already. */
const LOCAL_TRIED_NS = 'storage.local.tried'

const EXTENSION_ID = /^[a-p]{32}$/

const LIMITS: Record<Area, AreaLimits> = {
  sync: { quotaBytes: 102400, quotaBytesPerItem: 8192, maxItems: 512, writesPerMinute: 120, writesPerHour: 1800 },
  local: { quotaBytes: 10485760 },
}

/** Data larger than this is read from its file each time rather than kept in memory. */
const MAX_CACHED_BYTES = 8 * 1024 * 1024

const ACCESS_LEVELS = ['TRUSTED_AND_UNTRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']

const invocationError = (signature: string, detail = 'No matching signature.') =>
  new Error(`Error in invocation of storage.${signature}: ${detail}`)

const SIGNATURES = {
  get: 'get(optional [string|array|object] keys, optional function callback)',
  getKeys: 'getKeys(optional function callback)',
  set: 'set(object items, optional function callback)',
  remove: 'remove([string|array] keys, optional function callback)',
  getBytesInUse: 'getBytesInUse(optional [string|array] keys, optional function callback)',
  setAccessLevel: 'setAccessLevel(object accessOptions, optional function callback)',
}

const isPlainObject = (value: unknown): value is Data =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const has = (data: Data, key: string) => Object.prototype.hasOwnProperty.call(data, key)

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8')

/**
 * How many bytes Chrome's JSON writer uses for a value: it writes "<" as
 * <, a double with no fraction as "3000000000.0", and no spaces. Chrome
 * counts quotas and getBytesInUse in these bytes.
 */
export function chromeJsonBytes(value: unknown): number {
  if (value === null || value === undefined) return 4
  switch (typeof value) {
    case 'boolean':
      return value ? 4 : 5
    case 'number': {
      if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 && !Object.is(value, -0)) {
        return String(value).length
      }
      let real = String(value)
      if (!/[.eE]/.test(real)) real += '.0'
      return real.length
    }
    case 'string':
      return chromeStringBytes(value)
    case 'object': {
      if (Array.isArray(value)) {
        let n = 2 + Math.max(0, value.length - 1)
        for (const item of value) n += chromeJsonBytes(item)
        return n
      }
      const keys = Object.keys(value as object)
      let n = 2 + Math.max(0, keys.length - 1)
      for (const key of keys) n += chromeStringBytes(key) + 1 + chromeJsonBytes((value as any)[key])
      return n
    }
    default:
      return 4
  }
}

function chromeStringBytes(text: string): number {
  let n = 2
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (char === '"' || char === '\\' || char === '\b' || char === '\f' || char === '\n' || char === '\r' || char === '\t') n += 2
    else if (code < 0x20 || char === '<' || code === 0x2028 || code === 0x2029) n += 6
    else n += utf8(char)
  }
  return n
}

const itemBytes = (key: string, value: unknown) => utf8(key) + chromeJsonBytes(value)

/** A value as Chrome stores it: plain JSON, with each object's keys in order. */
function normalize(value: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    throw new Error('Cannot serialize value to JSON')
  }
  if (json === undefined) return undefined
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (v && typeof v === 'object') {
      const out: Data = Object.create(null)
      for (const key of Object.keys(v).sort()) out[key] = sortKeys((v as Data)[key])
      return out
    }
    return v
  }
  return sortKeys(JSON.parse(json))
}

/** Hands data back as ordinary objects, which copy across to the extension. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    const out: Data = {}
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: plain((value as Data)[key]), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return value
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class StorageSyncAPI {
  /** undefined for an in-memory session: its storage stays in memory. */
  private dirs: Partial<Record<Area, string>> = {}
  /** Where 1.x kept every session's storage, read once for a new session file. */
  private legacyDirs: Record<Area, string>
  /** The data of a session without a folder, which is never written. */
  private memory: Record<Area, Map<string, Data>> = { sync: new Map(), local: new Map() }
  /** What was last read or written, so a call need not read the file again. */
  private cache: Record<Area, Map<string, Data>> = { sync: new Map(), local: new Map() }
  private ready: Record<Area, Promise<void>>
  private chains: Record<Area, Map<string, Promise<unknown>>> = { sync: new Map(), local: new Map() }
  private accessLevels = new Map<string, string>()
  private writes = new Map<string, number[]>()
  private crypto: StorageCrypto = safeStorage

  constructor(private ctx: ExtensionContext) {
    // Each session keeps extension storage in its own data folder, so two
    // profiles never share it, and an in-memory (private) session never
    // writes it to disk.
    const storagePath = (ctx.session as any)?.storagePath as string | null | undefined
    this.legacyDirs = {
      sync: path.join(app.getPath('userData'), 'extension-sync'),
      local: path.join(app.getPath('userData'), 'extension-local'),
    }
    if (storagePath) {
      this.dirs = {
        sync: path.join(storagePath, 'extension-sync'),
        local: path.join(storagePath, 'extension-local'),
      }
    }
    const mkdir = (dir?: string) =>
      dir ? fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {}) : Promise.resolve()
    this.ready = { sync: mkdir(this.dirs.sync), local: mkdir(this.dirs.local) }

    const handle = this.ctx.router.apiHandler()
    const opts = { permission: 'storage' }
    // chrome.storage.local is Electron's own store, the one content scripts
    // use too, so every part of an extension sees the same data, as in
    // Chrome. What 1.x kept for it in the shell's encrypted file is handed to
    // the extension's first context once, which writes it there.
    handle('storage.local.migrate', this.migrateLocal, opts)
    handle('storage.local.migrated', this.migratedLocal, opts)

    for (const area of ['sync'] as Area[]) {
      handle(`storage.${area}.get`, (event: ExtensionEvent, keys?: unknown) => this.get(area, event, keys), opts)
      handle(`storage.${area}.getKeys`, (event: ExtensionEvent) => this.getKeys(area, event), opts)
      handle(`storage.${area}.set`, (event: ExtensionEvent, items?: unknown) => this.set(area, event, items), opts)
      handle(`storage.${area}.remove`, (event: ExtensionEvent, keys?: unknown) => this.remove(area, event, keys), opts)
      handle(`storage.${area}.clear`, (event: ExtensionEvent) => this.clear(area, event), opts)
      handle(
        `storage.${area}.getBytesInUse`,
        (event: ExtensionEvent, keys?: unknown) => this.getBytesInUse(area, event, keys),
        opts,
      )
      handle(
        `storage.${area}.setAccessLevel`,
        (event: ExtensionEvent, options?: unknown) => this.setAccessLevel(area, event, options),
        opts,
      )
    }
    handle('storage.managed.get', this.managedGet, opts)
    handle('storage.managed.getKeys', this.managedGetKeys, opts)
    handle('storage.managed.getBytesInUse', this.managedGetBytesInUse, opts)
    handle('storage.managed.setAccessLevel', (event: ExtensionEvent, options?: unknown) =>
      this.setAccessLevel('managed', event, options), opts)
    for (const method of ['set', 'remove', 'clear']) {
      handle(`storage.managed.${method}`, () => {
        throw new Error('This is a read-only store.')
      }, opts)
    }

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      for (const area of ['local', 'sync'] as Area[]) this.cache[area].delete(extension.id)
      for (const key of [...this.accessLevels.keys()]) {
        if (key.startsWith(`${extension.id}:`)) this.accessLevels.delete(key)
      }
    })
    // Chrome deletes an extension's storage with the extension.
    this.ctx.store.on('extension-uninstalled', (extensionId: string) => {
      void this.removeNativeLocal(extensionId)
      for (const area of ['local', 'sync'] as Area[]) {
        void this.enqueue(area, extensionId, async () => {
          this.cache[area].delete(extensionId)
          this.memory[area].delete(extensionId)
          const file = this.filePath(area, extensionId)
          if (file) await fs.rm(file, { force: true }).catch(() => {})
        })
      }
    })
  }

  // ---------------------------------------------------------------- local, from 1.x

  /** Who is moving an extension's 1.x local data now, until when. */
  private moving = new Map<string, { token: string; expires: number }>()

  private movedLocal(): Record<string, true> {
    return this.ctx.stateStore.getNamespace<Record<string, true>>(LOCAL_MOVED_NS, {})
  }

  /** The 1.x local files of an extension that exist: this session's and userData's. */
  private async oldLocalFiles(extensionId: string) {
    const files = [this.filePath('local', extensionId)]
    if (this.dirs.local && EXTENSION_ID.test(extensionId)) {
      files.push(path.join(this.legacyDirs.local, `${extensionId}.json`))
    }
    const found: string[] = []
    for (const file of files) {
      if (!file) continue
      try {
        await fs.access(file)
        found.push(file)
      } catch {}
    }
    return found
  }

  /**
   * Hands the extension's first context what 1.x kept for it in
   * chrome.storage.local, once. The answer is { done } when there is nothing
   * to move, { wait } while another context is moving it, or { token, data,
   * keepNewer }: the context writes data to Electron's store and calls
   * storage.local.migrated with the token, and only then are the old files
   * deleted. If it never does (the context closed, the write failed), the
   * files stay and the next context tries again; that time a value written
   * since wins over the old one (keepNewer).
   */
  private migrateLocal = async ({ extension }: ExtensionEvent) => {
    const id = extension.id
    await this.ctx.stateStore.whenHydrated()
    if (this.movedLocal()[id]) return { done: true }
    const claim = this.moving.get(id)
    if (claim && claim.expires > Date.now()) return { wait: true }
    const files = await this.oldLocalFiles(id)
    if (files.length === 0) {
      await this.finishLocalMove(id, [])
      return { done: true }
    }
    const data = await this.enqueue('local', id, () => this.load('local', id))
    const keys = Object.keys(data)
    if (keys.length === 0) {
      await this.finishLocalMove(id, files)
      return { done: true }
    }
    const token = randomUUID()
    const triedBefore = this.ctx.stateStore.getNamespace<Record<string, true>>(LOCAL_TRIED_NS, {})
    const tried = !!triedBefore[id]
    if (!tried) {
      this.ctx.stateStore.setNamespace(LOCAL_TRIED_NS, { ...triedBefore, [id]: true })
      await this.ctx.stateStore.flush().catch(() => {})
    }
    this.moving.set(id, { token, expires: Date.now() + 30_000 })
    const plain: Data = {}
    for (const key of keys) plain[key] = data[key]
    return { token, data: plain, keepNewer: tried }
  }

  private migratedLocal = async ({ extension }: ExtensionEvent, token?: unknown) => {
    const claim = this.moving.get(extension.id)
    if (!claim || typeof token !== 'string' || claim.token !== token) return false
    this.moving.delete(extension.id)
    await this.finishLocalMove(extension.id, await this.oldLocalFiles(extension.id))
    return true
  }

  private async finishLocalMove(extensionId: string, files: string[]) {
    this.ctx.stateStore.setNamespace(LOCAL_MOVED_NS, { ...this.movedLocal(), [extensionId]: true })
    const tried = { ...this.ctx.stateStore.getNamespace<Record<string, true>>(LOCAL_TRIED_NS, {}) }
    if (tried[extensionId]) {
      delete tried[extensionId]
      this.ctx.stateStore.setNamespace(LOCAL_TRIED_NS, tried)
    }
    await this.ctx.stateStore.flush().catch(() => {})
    this.cache.local.delete(extensionId)
    this.memory.local.delete(extensionId)
    for (const file of files) await fs.rm(file, { force: true }).catch(() => {})
  }

  /** Electron keeps chrome.storage.local in the session folder, by extension id. */
  private async removeNativeLocal(extensionId: string) {
    const storagePath = (this.ctx.session as any)?.storagePath as string | null | undefined
    if (!storagePath || !EXTENSION_ID.test(extensionId)) return
    await fs
      .rm(path.join(storagePath, 'Local Extension Settings', extensionId), { recursive: true, force: true })
      .catch(() => {})
    const moved = { ...this.movedLocal() }
    delete moved[extensionId]
    this.ctx.stateStore.setNamespace(LOCAL_MOVED_NS, moved)
  }

  // ---------------------------------------------------------------- reading and writing

  private enqueue<T>(area: Area, extensionId: string, fn: () => Promise<T>): Promise<T> {
    const chain = this.chains[area]
    const prev = chain.get(extensionId) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    chain.set(extensionId, next)
    // Forget a finished chain, so one entry per extension does not linger.
    void next.then(
      () => chain.get(extensionId) === next && chain.delete(extensionId),
      () => chain.get(extensionId) === next && chain.delete(extensionId),
    )
    return next
  }

  private filePath(area: Area, extensionId: string) {
    const dir = this.dirs[area]
    // An id is 32 letters; anything else never names a file.
    if (!dir || !/^[a-z0-9_-]{1,64}$/i.test(extensionId)) return undefined
    return path.join(dir, `${extensionId}.json`)
  }

  private async load(area: Area, extensionId: string): Promise<Data> {
    await this.ready[area]
    const cached = this.cache[area].get(extensionId)
    if (cached) return cached
    if (!this.dirs[area]) {
      let data = this.memory[area].get(extensionId)
      if (!data) this.memory[area].set(extensionId, (data = Object.create(null) as Data))
      return data
    }
    const file = this.filePath(area, extensionId)
    if (!file) return Object.create(null)
    let data: Data
    try {
      await fs.access(file)
      data = await readStorageFile(file, this.crypto, area)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      // No file for this session yet: start from what 1.x kept, if anything.
      const legacy = path.join(this.legacyDirs[area], `${extensionId}.json`)
      try {
        await fs.access(legacy)
        data = await readStorageFile(legacy, this.crypto, area)
      } catch (legacyError: any) {
        if (legacyError?.code !== 'ENOENT') throw legacyError
        data = Object.create(null)
      }
    }
    if (chromeJsonBytes(data) <= MAX_CACHED_BYTES) this.cache[area].set(extensionId, data)
    return data
  }

  private async save(area: Area, extensionId: string, data: Data) {
    await this.ready[area]
    if (!this.dirs[area]) {
      this.memory[area].set(extensionId, data)
      return
    }
    const file = this.filePath(area, extensionId)
    if (!file) return
    this.cache[area].delete(extensionId)
    await writeStorageFile(file, data, this.crypto)
    if (chromeJsonBytes(data) <= MAX_CACHED_BYTES) this.cache[area].set(extensionId, data)
  }

  /** Chrome's write rate limits for sync, counted per method as Chrome does. */
  private checkWriteRate(area: Area, extensionId: string, method: string) {
    const limits = LIMITS[area]
    if (!limits.writesPerMinute && !limits.writesPerHour) return
    const key = `${area}:${extensionId}:${method}`
    const now = Date.now()
    const times = (this.writes.get(key) || []).filter((t) => now - t < 3_600_000)
    const lastMinute = times.filter((t) => now - t < 60_000).length
    if (limits.writesPerMinute && lastMinute >= limits.writesPerMinute) {
      throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.')
    }
    if (limits.writesPerHour && times.length >= limits.writesPerHour) {
      throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.')
    }
    times.push(now)
    this.writes.set(key, times)
  }

  private quotaFor(area: Area, extension: Electron.Extension): AreaLimits {
    if (area === 'local' && this.ctx.permissions.has(extension, 'unlimitedStorage')) return {}
    return LIMITS[area]
  }

  /** Refuses data that would go past the area's quota, with Chrome's message. */
  private checkQuota(limits: AreaLimits, data: Data, changed: string[]) {
    if (limits.quotaBytesPerItem) {
      for (const key of changed) {
        if (has(data, key) && itemBytes(key, data[key]) > limits.quotaBytesPerItem) {
          throw new Error('Resource::kQuotaBytesPerItem quota exceeded')
        }
      }
    }
    if (limits.quotaBytes) {
      let total = 0
      for (const key of Object.keys(data)) total += itemBytes(key, data[key])
      if (total > limits.quotaBytes) throw new Error('Resource::kQuotaBytes quota exceeded')
    }
    if (limits.maxItems && Object.keys(data).length > limits.maxItems) {
      throw new Error('Resource::kMaxItems quota exceeded')
    }
  }

  private sendChanges(area: string, extensionId: string, changes: Data) {
    if (Object.keys(changes).length === 0) return
    const sorted: Data = {}
    for (const key of Object.keys(changes).sort()) {
      Object.defineProperty(sorted, key, { value: changes[key], enumerable: true, writable: true, configurable: true })
    }
    this.ctx.router.sendEvent(extensionId, 'storage.onChanged', sorted, area)
  }

  // ---------------------------------------------------------------- the API

  private readKeys(keys: unknown): string[] | null | Data {
    if (keys === undefined || keys === null) return null
    if (typeof keys === 'string') return [keys]
    if (Array.isArray(keys)) {
      if (!keys.every((k) => typeof k === 'string')) {
        throw invocationError(SIGNATURES.get, "Error at parameter 'keys': Value did not match any choice.")
      }
      return keys as string[]
    }
    if (isPlainObject(keys)) return keys
    throw invocationError(SIGNATURES.get)
  }

  private pick(data: Data, keys: string[] | null | Data): Data {
    const out: Data = Object.create(null)
    if (keys === null) {
      for (const key of Object.keys(data).sort()) out[key] = data[key]
    } else if (Array.isArray(keys)) {
      for (const key of [...new Set(keys)].sort()) if (has(data, key)) out[key] = data[key]
    } else {
      for (const key of Object.keys(keys).sort()) {
        if (has(data, key)) out[key] = data[key]
        else {
          const fallback = normalize(keys[key])
          if (fallback !== undefined) out[key] = fallback
        }
      }
    }
    return out
  }

  private get(area: Area, { extension }: ExtensionEvent, keys: unknown) {
    const wanted = this.readKeys(keys)
    return this.enqueue(area, extension.id, async () => plain(this.pick(await this.load(area, extension.id), wanted)))
  }

  private getKeys(area: Area, { extension }: ExtensionEvent) {
    return this.enqueue(area, extension.id, async () => Object.keys(await this.load(area, extension.id)).sort())
  }

  private getBytesInUse(area: Area, { extension }: ExtensionEvent, keys: unknown) {
    if (keys !== undefined && keys !== null && typeof keys !== 'string' &&
      !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) {
      throw invocationError(SIGNATURES.getBytesInUse)
    }
    return this.enqueue(area, extension.id, async () => {
      const data = await this.load(area, extension.id)
      const wanted = keys === undefined || keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : [...new Set(keys as string[])]
      let total = 0
      for (const key of wanted) if (has(data, key)) total += itemBytes(key, data[key])
      return total
    })
  }

  private set(area: Area, { extension }: ExtensionEvent, items: unknown) {
    if (!isPlainObject(items)) throw invocationError(SIGNATURES.set)
    // Read the values now: a value that is not JSON is refused before anything is written.
    const values: [string, unknown][] = []
    for (const key of Object.keys(items)) {
      const value = normalize(items[key])
      if (value !== undefined) values.push([key, value])
    }
    return this.enqueue(area, extension.id, async () => {
      this.checkWriteRate(area, extension.id, 'set')
      const current = await this.load(area, extension.id)
      const next: Data = Object.assign(Object.create(null), current)
      const changes: Data = Object.create(null)
      for (const [key, value] of values) {
        if (has(current, key) && sameValue(current[key], value)) continue
        const change: Data = { newValue: value }
        if (has(current, key)) change.oldValue = current[key]
        changes[key] = change
        next[key] = value
      }
      const changed = Object.keys(changes)
      if (changed.length === 0) return
      this.checkQuota(this.quotaFor(area, extension), next, changed)
      await this.save(area, extension.id, next)
      this.sendChanges(area, extension.id, plain(changes) as Data)
    })
  }

  private remove(area: Area, { extension }: ExtensionEvent, keys: unknown) {
    if (typeof keys !== 'string' && !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) {
      throw invocationError(SIGNATURES.remove)
    }
    const list = typeof keys === 'string' ? [keys] : (keys as string[])
    return this.enqueue(area, extension.id, async () => {
      this.checkWriteRate(area, extension.id, 'remove')
      const current = await this.load(area, extension.id)
      const changes: Data = Object.create(null)
      const next: Data = Object.assign(Object.create(null), current)
      for (const key of list) {
        if (!has(next, key)) continue
        changes[key] = { oldValue: next[key] }
        delete next[key]
      }
      if (Object.keys(changes).length === 0) return
      await this.save(area, extension.id, next)
      this.sendChanges(area, extension.id, plain(changes) as Data)
    })
  }

  private clear(area: Area, { extension }: ExtensionEvent) {
    return this.enqueue(area, extension.id, async () => {
      this.checkWriteRate(area, extension.id, 'clear')
      const current = await this.load(area, extension.id)
      const changes: Data = Object.create(null)
      for (const key of Object.keys(current)) changes[key] = { oldValue: current[key] }
      if (Object.keys(changes).length === 0) return
      await this.save(area, extension.id, Object.create(null))
      this.sendChanges(area, extension.id, plain(changes) as Data)
    })
  }

  /**
   * Chrome lets content scripts into an area this opens. Content scripts
   * never reach the shell's areas, so the level is only kept.
   */
  private setAccessLevel(area: string, { extension }: ExtensionEvent, options: unknown) {
    if (!isPlainObject(options)) throw invocationError(SIGNATURES.setAccessLevel)
    const level = options.accessLevel
    if (typeof level !== 'string' || !ACCESS_LEVELS.includes(level)) {
      throw invocationError(
        SIGNATURES.setAccessLevel,
        level === undefined
          ? "Error at parameter 'accessOptions': Missing required property 'accessLevel'."
          : `Error at parameter 'accessOptions': Error at property 'accessLevel': Value must be one of ${ACCESS_LEVELS.join(', ')}.`,
      )
    }
    this.accessLevels.set(`${extension.id}:${area}`, level)
  }

  // ---------------------------------------------------------------- managed

  /** Policy the host sets for the extension, read only. Without the hook there is none. */
  private async policy(extension: Electron.Extension): Promise<Data> {
    let value: unknown
    try {
      value = await this.ctx.store.impl.getManagedStorage?.(extension)
    } catch {
      value = undefined
    }
    const normalized = isPlainObject(value) ? normalize(value) : undefined
    return (normalized as Data) || Object.create(null)
  }

  private managedGet = async ({ extension }: ExtensionEvent, keys?: unknown) => {
    const wanted = this.readKeys(keys)
    return plain(this.pick(await this.policy(extension), wanted))
  }

  private managedGetKeys = async ({ extension }: ExtensionEvent) => {
    return Object.keys(await this.policy(extension)).sort()
  }

  private managedGetBytesInUse = async ({ extension }: ExtensionEvent, keys?: unknown) => {
    if (keys !== undefined && keys !== null && typeof keys !== 'string' &&
      !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) {
      throw invocationError(SIGNATURES.getBytesInUse)
    }
    const data = await this.policy(extension)
    const wanted = keys === undefined || keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : (keys as string[])
    let total = 0
    for (const key of new Set(wanted)) if (has(data, key)) total += itemBytes(key, data[key])
    return total
  }

  /**
   * The host's policy for an extension changed: fires storage.onChanged for
   * the managed area with what changed, as Chrome does.
   */
  managedChanged(extensionId: string, changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) {
    this.sendChanges('managed', extensionId, plain(changes) as Data)
  }
}
