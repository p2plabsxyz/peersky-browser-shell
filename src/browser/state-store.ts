import { app } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const STATE_SCHEMA_VERSION = 1

type StatePayload = {
  schemaVersion: number
  namespaces: Record<string, unknown>
}

type StateStoreOptions = {
  baseDir?: string
}

const sanitizeName = (input: string) =>
  input.replace(/[^a-z0-9._-]+/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'default'

const STATE_FILENAME = 'chrome-extension-api-state.json'

export class ExtensionStateStore {
  /** undefined: an in-memory session, whose state is never written. */
  private filePath?: string
  /** Where 1.x kept every session's state, read once if filePath is new. */
  private legacyPath?: string
  private state: StatePayload = { schemaVersion: STATE_SCHEMA_VERSION, namespaces: {} }
  private dirty = false
  private hydrated = false
  private hydratePromise?: Promise<void>

  constructor(private session: Electron.Session, opts: StateStoreOptions = {}) {
    if (opts.baseDir) {
      const partition = (session as any)?.partition || 'default'
      this.filePath = path.join(opts.baseDir, `${sanitizeName(partition)}.json`)
      return
    }
    // Each session keeps its state in its own data folder, so two profiles
    // never share alarms, grants or downloads. A session without a folder is
    // in memory, like an incognito one, and so is its state.
    const storagePath = (session as any)?.storagePath as string | null | undefined
    if (storagePath) {
      this.filePath = path.join(storagePath, STATE_FILENAME)
      this.legacyPath = path.join(app.getPath('userData'), 'chrome-extension-api-state', 'default.json')
    }
  }

  async hydrate() {
    if (this.hydratePromise) {
      return this.hydratePromise
    }
    this.hydratePromise = this.doHydrate()
    return this.hydratePromise
  }

  private async doHydrate() {
    if (this.hydrated) return
    this.hydrated = true

    if (!this.filePath) return

    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      // Nothing here yet: take over what 1.x kept for every session, once.
      if (!this.legacyPath) return
      try {
        raw = await fs.readFile(this.legacyPath, 'utf8')
        this.dirty = true
      } catch {
        return
      }
    }

    try {
      const parsed = JSON.parse(raw)
      if (
        parsed &&
        parsed.schemaVersion === STATE_SCHEMA_VERSION &&
        parsed.namespaces &&
        typeof parsed.namespaces === 'object'
      ) {
        this.state = parsed
        return
      }
    } catch {
      // Ignore malformed files and start clean.
    }

    this.state = { schemaVersion: STATE_SCHEMA_VERSION, namespaces: {} }
    this.dirty = true
  }

  async whenHydrated() {
    await this.hydrate()
  }

  getNamespace<T>(name: string, fallback: T): T {
    const value = this.state.namespaces[name]
    return (value as T) ?? fallback
  }

  setNamespace(name: string, value: unknown) {
    this.state.namespaces[name] = value
    this.dirty = true
  }

  private flushing?: Promise<void>

  /**
   * Writes the state if it changed. One write at a time, each to a new file
   * moved over the old one, so a crash mid-write leaves the last good file.
   * A change made while a write is under way is written by the next flush.
   */
  async flush() {
    while (this.flushing) await this.flushing.catch(() => {})
    if (!this.dirty || !this.filePath) return
    const filePath = this.filePath
    this.dirty = false
    const data = JSON.stringify(this.state, null, 2)
    const write = (async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        await fs.writeFile(temp, data, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temp, filePath)
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {})
        throw error
      }
    })()
    this.flushing = write
    try {
      await write
    } catch (error) {
      this.dirty = true
      throw error
    } finally {
      if (this.flushing === write) this.flushing = undefined
    }
  }
}
