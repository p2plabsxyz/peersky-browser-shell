import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { isForbiddenStorageKey, readStorageFile, StorageCrypto, writeStorageFile } from './storage-file'

type Area = 'sync' | 'local'

export class StorageSyncAPI {
  /** undefined for an in-memory session: its storage stays in memory. */
  private dirs: Partial<Record<Area, string>> = {}
  /** Where 1.x kept every session's storage, read once for a new session file. */
  private legacyDirs: Record<Area, string>
  private memory: Record<Area, Map<string, Record<string, any>>> = { sync: new Map(), local: new Map() }
  private ready: Promise<void>
  private localReady: Promise<void>
  private chainSync = new Map<string, Promise<unknown>>()
  private chainLocal = new Map<string, Promise<unknown>>()
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
    this.ready = mkdir(this.dirs.sync)
    this.localReady = mkdir(this.dirs.local)

    const handle = this.ctx.router.apiHandler()
    handle('storage.sync.get', this.get, { permission: 'storage' })
    handle('storage.sync.set', this.set, { permission: 'storage' })
    handle('storage.sync.remove', this.remove, { permission: 'storage' })
    handle('storage.sync.clear', this.clear, { permission: 'storage' })
    handle('storage.sync.getBytesInUse', this.getBytesInUse, { permission: 'storage' })
    handle('storage.local.get', this.localGet, { permission: 'storage' })
    handle('storage.local.set', this.localSet, { permission: 'storage' })
    handle('storage.local.remove', this.localRemove, { permission: 'storage' })
    handle('storage.local.clear', this.localClear, { permission: 'storage' })
    handle('storage.local.getBytesInUse', this.localGetBytesInUse, { permission: 'storage' })
    handle('storage.managed.get', this.managedGet, { permission: 'storage' })
  }

  private enqueueSync<T>(extensionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chainSync.get(extensionId) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    this.chainSync.set(extensionId, next)
    return next
  }

  private enqueueLocal<T>(extensionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chainLocal.get(extensionId) ?? Promise.resolve()
    const next = prev.then(() => fn(), () => fn())
    this.chainLocal.set(extensionId, next)
    return next
  }

  private filePath(area: Area, extensionId: string) {
    const dir = this.dirs[area]
    return dir ? path.join(dir, `${extensionId}.json`) : undefined
  }

  private async readArea(area: Area, extensionId: string): Promise<Record<string, any>> {
    const file = this.filePath(area, extensionId)
    if (!file) {
      return structuredClone(this.memory[area].get(extensionId) ?? {})
    }
    try {
      await fs.access(file)
    } catch {
      // No file for this session yet: start from what 1.x kept, if anything.
      const legacy = path.join(this.legacyDirs[area], `${extensionId}.json`)
      try {
        await fs.access(legacy)
      } catch {
        return {}
      }
      return readStorageFile(legacy, this.crypto, area)
    }
    return readStorageFile(file, this.crypto, area)
  }

  private async writeArea(area: Area, extensionId: string, data: Record<string, any>) {
    const file = this.filePath(area, extensionId)
    if (!file) {
      this.memory[area].set(extensionId, structuredClone(data))
      return
    }
    await writeStorageFile(file, data, this.crypto)
  }

  private load = async (extensionId: string): Promise<Record<string, any>> => {
    await this.ready
    return this.readArea('sync', extensionId)
  }

  private save = async (extensionId: string, data: Record<string, any>) => {
    await this.ready
    await this.writeArea('sync', extensionId, data)
  }

  private get = async (event: ExtensionEvent, keys?: string | string[] | Record<string, any> | null) => {
    return this.enqueueSync(event.extension.id, () => this.getImpl(event, keys))
  }

  private getImpl = async (
    { extension }: ExtensionEvent,
    keys?: string | string[] | Record<string, any> | null,
  ) => {
    const data = await this.load(extension.id)
    if (keys == null) return data

    const result: Record<string, any> = {}
    if (typeof keys === 'string') {
      if (isForbiddenStorageKey(keys)) return result
      if (keys in data) result[keys] = data[keys]
    } else if (Array.isArray(keys)) {
      keys.forEach(k => {
        if (isForbiddenStorageKey(k)) return
        if (k in data) result[k] = data[k]
      })
    } else {
      Object.entries(keys).forEach(([k, defaultVal]) => {
        if (isForbiddenStorageKey(k)) return
        result[k] = k in data ? data[k] : defaultVal
      })
    }
    return result
  }

  private set = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    return this.enqueueSync(extension.id, () => this.setImpl({ extension } as ExtensionEvent, items))
  }

  private setImpl = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('Invalid items')
    }

    Object.entries(items).forEach(([k, v]) => {
      if (isForbiddenStorageKey(k)) {
        throw new Error('Invalid storage key')
      }
      let same = false
      if (typeof v === 'object' && v !== null) {
        try {
          same = JSON.stringify(data[k]) === JSON.stringify(v)
        } catch {
          same = false
        }
      } else {
        same = data[k] === v
      }
      if (!same) {
        changes[k] = { newValue: v }
        if (k in data) changes[k].oldValue = data[k]
        data[k] = v
      }
    })

    if (Object.keys(changes).length > 0) {
      await this.save(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'sync')
    }
  }

  private remove = async ({ extension }: ExtensionEvent, keys: string | string[]) => {
    return this.enqueueSync(extension.id, () => this.removeImpl({ extension } as ExtensionEvent, keys))
  }

  private removeImpl = async ({ extension }: ExtensionEvent, keys: string | string[]) => {
    if (!keys) return
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    const toDelete = Array.isArray(keys) ? keys : [keys]
    toDelete.forEach(k => {
      if (isForbiddenStorageKey(k)) return
      if (k in data) {
        changes[k] = { oldValue: data[k] }
        delete data[k]
      }
    })

    if (Object.keys(changes).length > 0) {
      await this.save(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'sync')
    }
  }

  private clear = async ({ extension }: ExtensionEvent) => {
    return this.enqueueSync(extension.id, () => this.clearImpl({ extension } as ExtensionEvent))
  }

  private clearImpl = async ({ extension }: ExtensionEvent) => {
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    Object.keys(data).forEach(k => {
      changes[k] = { oldValue: data[k] }
    })

    if (Object.keys(changes).length > 0) {
      await this.save(extension.id, {})
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'sync')
    }
  }

  private getBytesInUse = async ({ extension }: ExtensionEvent, keys?: string | string[] | null) => {
    return this.enqueueSync(extension.id, async () => {
      const result = await this.getImpl({ extension } as ExtensionEvent, keys)
      return Buffer.byteLength(JSON.stringify(result))
    })
  }

  private localLoad = async (extensionId: string): Promise<Record<string, any>> => {
    await this.localReady
    return this.readArea('local', extensionId)
  }

  private localSave = async (extensionId: string, data: Record<string, any>) => {
    await this.localReady
    await this.writeArea('local', extensionId, data)
  }

  private localGet = async ({ extension }: ExtensionEvent, keys?: string | string[] | Record<string, any> | null) => {
    return this.enqueueLocal(extension.id, () => this.localGetImpl({ extension } as ExtensionEvent, keys))
  }

  private localGetImpl = async (
    { extension }: ExtensionEvent,
    keys?: string | string[] | Record<string, any> | null,
  ) => {
    const data = await this.localLoad(extension.id)
    if (keys == null) return data
    const result: Record<string, any> = {}
    if (typeof keys === 'string') {
      if (isForbiddenStorageKey(keys)) return result
      if (keys in data) result[keys] = data[keys]
    } else if (Array.isArray(keys)) {
      keys.forEach(k => {
        if (isForbiddenStorageKey(k)) return
        if (k in data) result[k] = data[k]
      })
    } else {
      Object.entries(keys).forEach(([k, defaultVal]) => {
        if (isForbiddenStorageKey(k)) return
        result[k] = k in data ? data[k] : defaultVal
      })
    }
    return result
  }

  private localSet = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    return this.enqueueLocal(extension.id, () => this.localSetImpl({ extension } as ExtensionEvent, items))
  }

  private localSetImpl = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    const data = await this.localLoad(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      throw new Error('Invalid items')
    }

    Object.entries(items).forEach(([k, v]) => {
      if (isForbiddenStorageKey(k)) {
        throw new Error('Invalid storage key')
      }
      let same = false
      if (typeof v === 'object' && v !== null) {
        try {
          same = JSON.stringify(data[k]) === JSON.stringify(v)
        } catch {
          same = false
        }
      } else {
        same = data[k] === v
      }
      if (!same) {
        changes[k] = { newValue: v }
        if (k in data) changes[k].oldValue = data[k]
        data[k] = v
      }
    })

    if (Object.keys(changes).length > 0) {
      await this.localSave(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'local')
    }
  }

  private localRemove = async ({ extension }: ExtensionEvent, keys: string | string[]) => {
    return this.enqueueLocal(extension.id, () => this.localRemoveImpl({ extension } as ExtensionEvent, keys))
  }

  private localRemoveImpl = async ({ extension }: ExtensionEvent, keys: string | string[]) => {
    if (!keys) return
    const data = await this.localLoad(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}
    const toDelete = Array.isArray(keys) ? keys : [keys]
    toDelete.forEach(k => {
      if (isForbiddenStorageKey(k)) return
      if (k in data) {
        changes[k] = { oldValue: data[k] }
        delete data[k]
      }
    })
    if (Object.keys(changes).length > 0) {
      await this.localSave(extension.id, data)
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'local')
    }
  }

  private localClear = async ({ extension }: ExtensionEvent) => {
    return this.enqueueLocal(extension.id, () => this.localClearImpl({ extension } as ExtensionEvent))
  }

  private localClearImpl = async ({ extension }: ExtensionEvent) => {
    const data = await this.localLoad(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}
    Object.keys(data).forEach(k => {
      changes[k] = { oldValue: data[k] }
    })
    if (Object.keys(changes).length > 0) {
      await this.localSave(extension.id, {})
      this.ctx.router.sendEvent(extension.id, 'storage.onChanged', changes, 'local')
    }
  }

  private localGetBytesInUse = async ({ extension }: ExtensionEvent, keys?: string | string[] | null) => {
    return this.enqueueLocal(extension.id, async () => {
      const result = await this.localGetImpl({ extension } as ExtensionEvent, keys)
      return Buffer.byteLength(JSON.stringify(result))
    })
  }

  /**
   * chrome.storage.managed — enterprise policy, read-only to the extension.
   * There is no OS policy store here, so the host seeds a `managedConfig`
   * object into the extension's local storage and this exposes it.
   */
  private managedGet = async (
    { extension }: ExtensionEvent,
    keys?: string | string[] | Record<string, unknown> | null,
  ) => {
    const data = await this.localLoad(extension.id)
    const policy =
      data.managedConfig && typeof data.managedConfig === 'object'
        ? Object.assign(Object.create(null), data.managedConfig as Record<string, unknown>)
        : Object.create(null)
    if (keys == null) return { ...policy }
    const result: Record<string, unknown> = Object.create(null)
    if (typeof keys === 'string') {
      if (Object.prototype.hasOwnProperty.call(policy, keys)) result[keys] = policy[keys]
    } else if (Array.isArray(keys)) {
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(policy, k)) result[k] = policy[k]
      }
    } else {
      for (const [k, defaultVal] of Object.entries(keys)) {
        result[k] = Object.prototype.hasOwnProperty.call(policy, k) ? policy[k] : defaultVal
      }
    }
    return result
  }
}
