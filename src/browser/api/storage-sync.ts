import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

export class StorageSyncAPI {
  private baseDir: string
  private ready: Promise<void>

  constructor(private ctx: ExtensionContext) {
    this.baseDir = path.join(app.getPath('userData'), 'extension-sync')
    this.ready = fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 })

    const handle = this.ctx.router.apiHandler()
    handle('storage.sync.get', this.get, { permission: 'storage' })
    handle('storage.sync.set', this.set, { permission: 'storage' })
    handle('storage.sync.remove', this.remove, { permission: 'storage' })
    handle('storage.sync.clear', this.clear, { permission: 'storage' })
    handle('storage.sync.getBytesInUse', this.getBytesInUse, { permission: 'storage' })
  }

  private getFilePath = (extensionId: string) => {
    return path.join(this.baseDir, `${extensionId}.json`)
  }

  private load = async (extensionId: string): Promise<Record<string, any>> => {
    await this.ready
    let buffer: Buffer
    try {
      buffer = await fs.readFile(this.getFilePath(extensionId))
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {}
      console.error('Failed to load storage sync data', err)
      return {}
    }
    let json: string
    try {
      if (safeStorage.isEncryptionAvailable()) {
        try {
          json = safeStorage.decryptString(buffer)
        } catch {
          json = buffer.toString('utf-8')
        }
      } else {
        json = buffer.toString('utf-8')
      }
      return JSON.parse(json)
    } catch (err: any) {
      console.error('Failed to parse storage sync data', err)
      return {}
    }
  }

  private save = async (extensionId: string, data: Record<string, any>) => {
    await this.ready
    const json = JSON.stringify(data)
    const content = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : json
    await fs.writeFile(this.getFilePath(extensionId), content, { mode: 0o600 })
  }

  private get = async ({ extension }: ExtensionEvent, keys?: string | string[] | Record<string, any> | null) => {
    const data = await this.load(extension.id)
    if (keys == null) return data

    const result: Record<string, any> = {}
    if (typeof keys === 'string') {
      if (keys in data) result[keys] = data[keys]
    } else if (Array.isArray(keys)) {
      keys.forEach(k => {
        if (k in data) result[k] = data[k]
      })
    } else {
      Object.entries(keys).forEach(([k, defaultVal]) => {
        result[k] = k in data ? data[k] : defaultVal
      })
    }
    return result
  }

  private set = async ({ extension }: ExtensionEvent, items: Record<string, any>) => {
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    Object.entries(items).forEach(([k, v]) => {
      const same = typeof v === 'object' && v !== null
        ? JSON.stringify(data[k]) === JSON.stringify(v)
        : data[k] === v
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
    if (!keys) return
    const data = await this.load(extension.id)
    const changes: Record<string, chrome.storage.StorageChange> = {}

    const toDelete = Array.isArray(keys) ? keys : [keys]
    toDelete.forEach(k => {
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
    const result = await this.get({ extension } as ExtensionEvent, keys)
    return Buffer.byteLength(JSON.stringify(result))
  }
}
