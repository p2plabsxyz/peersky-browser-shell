import { app, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * chrome.downloads
 *
 * Every download in the session is listed, as Chrome lists every download
 * in the profile, and the list is kept across restarts. Downloads an
 * extension starts land in the downloads folder, under the relative name it
 * asks for; the files of downloads the host starts stay where the host puts
 * them.
 */

type State = 'in_progress' | 'interrupted' | 'complete'

interface DownloadRecord {
  id: number
  url: string
  finalUrl: string
  referrer: string
  filename: string
  incognito: boolean
  danger: string
  mime: string
  startTime: string
  endTime?: string
  state: State
  paused: boolean
  canResume: boolean
  error?: string
  bytesReceived: number
  totalBytes: number
  fileSize: number
  exists: boolean
  byExtensionId?: string
  byExtensionName?: string
}

type PersistedDownloadsState = {
  nextId: number
  items: DownloadRecord[]
}

interface PendingDownload {
  id: number
  extensionId: string
  url: string
  /** Where the file goes, when the extension named it and nobody else gets a say. */
  target?: string
  /** The name the extension asked for, relative to the downloads folder. */
  relative?: string
  conflictAction: ConflictAction
  saveAs: boolean
  expires: number
}

/** A download whose file is written to a temporary name and moved when done. */
interface Placement {
  temp: string
  relative?: string
  conflictAction: ConflictAction
  /** Extensions whose onDeterminingFilename answer is awaited. */
  waiting: Set<string>
  suggestion?: { filename?: string; conflictAction?: ConflictAction }
  decided: Promise<void>
  decide: () => void
}

type ConflictAction = 'uniquify' | 'overwrite' | 'prompt'

const DOWNLOADS_STATE_NS = 'downloads'
const MAX_RECORDS = 5000
const MAX_URL_LENGTH = 2 * 1024 * 1024
const PENDING_MS = 60_000
/** Chrome waits for every onDeterminingFilename listener; this one gives up after a while. */
const DETERMINING_TIMEOUT_MS = 30_000

const ERRORS = {
  invalidId: 'Invalid downloadId',
  invalidUrl: 'Invalid URL',
  invalidFilename: 'Invalid filename',
  notInProgress: 'Download must be in progress',
  notComplete: 'Download must be complete',
  notResumable: 'DownloadItem.canResume must be true',
  userGesture: 'User gesture required',
  openPermission: 'The "downloads.open" permission is required',
  uiPermission: 'downloads.setUiOptions requires "downloads.ui" permission',
  shelfPermission: 'downloads.setShelfEnabled requires "downloads.shelf" permission',
  uiDisabled: 'Another extension has disabled the download UI',
  notDangerous: 'Download is not dangerous',
  fileDeleted: 'Download file already deleted',
  fileNotRemoved: 'Unable to remove file',
  emptyFile: 'Filename not yet determined',
  iconNotFound: 'Icon not found',
  invalidOrderBy: 'Invalid orderBy field',
  invalidLimit: 'Invalid query limit',
  invalidFilter: 'Invalid query filter',
  invalidState: 'Invalid state',
  invalidDanger: 'Invalid danger type',
  headerName: 'Invalid request header name',
  headerUnsafe: 'Unsafe request header name',
  headerValue: 'Invalid request header value',
}

/** Headers a page may not set, which an extension may not set on a download either. */
const UNSAFE_HEADERS = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'content-transfer-encoding', 'date', 'dnt',
  'expect', 'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'user-agent', 'via',
])

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

const ORDER_FIELDS = new Set([
  'id', 'url', 'finalUrl', 'filename', 'danger', 'mime', 'startTime', 'endTime', 'state', 'paused',
  'error', 'bytesReceived', 'totalBytes', 'fileSize', 'exists',
])

/**
 * Chrome's rule for a suggested filename: relative to the downloads folder,
 * with no way out of it and nothing a file system treats specially.
 */
function checkRelativeFilename(filename: unknown): string {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 1024) {
    throw new Error(ERRORS.invalidFilename)
  }
  if (path.isAbsolute(filename) || path.win32.isAbsolute(filename) || /^[a-zA-Z]:/.test(filename)) {
    throw new Error(ERRORS.invalidFilename)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f<>:"|?*]/.test(filename)) throw new Error(ERRORS.invalidFilename)
  const parts = filename.split(/[\\/]/)
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.length > 255) throw new Error(ERRORS.invalidFilename)
    if (/[. ]$/.test(part) || /^ /.test(part) || RESERVED_WINDOWS_NAMES.test(part)) {
      throw new Error(ERRORS.invalidFilename)
    }
  }
  return parts.join(path.sep)
}

/** A file name the server suggested, made safe to use as a single name. */
function safeBasename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = path.basename(name || '').replace(/[\x00-\x1f\x7f<>:"|?*\\/]/g, '_').replace(/^[. ]+|[. ]+$/g, '')
  return cleaned && !RESERVED_WINDOWS_NAMES.test(cleaned) ? cleaned.slice(0, 255) : 'download'
}

async function exists(file: string) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const isoNow = () => new Date().toISOString()

export class DownloadsAPI {
  private nextId = 1
  private records = new Map<number, DownloadRecord>()
  private pending: PendingDownload[] = []
  private items = new Map<number, Electron.DownloadItem>()
  private placements = new Map<number, Placement>()
  /** Paths a download is about to take, so two never pick the same name. */
  private reserved = new Set<string>()
  /** Extensions that turned the download UI off. */
  private uiDisabledBy = new Set<string>()
  private restoreReady: Promise<void>

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('downloads.download', this.download)
    handle('downloads.search', this.search)
    handle('downloads.pause', this.pause)
    handle('downloads.resume', this.resume)
    handle('downloads.cancel', this.cancel)
    handle('downloads.erase', this.erase)
    handle('downloads.acceptDanger', this.acceptDanger)
    handle('downloads.getFileIcon', this.getFileIcon)
    handle('downloads.open', this.open)
    handle('downloads.removeFile', this.removeFile)
    handle('downloads.setUiOptions', this.setUiOptions)
    handle('downloads.setShelfEnabled', this.setShelfEnabled)
    handle('downloads.show', this.show)
    handle('downloads.showDefaultFolder', this.showDefaultFolder)
    handle('downloads.determineFilename', this.determineFilename)

    this.restoreReady = this.restore()
    this.observeSessionDownloads()

    // browsingData.removeDownloads: the list forgets them; the files stay.
    this.ctx.store.on('clear-downloads', (options: { since?: number } = {}) => {
      void this.clearSince(typeof options?.since === 'number' ? options.since : 0)
    })
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event: unknown, extension: Electron.Extension) => {
      if (this.uiDisabledBy.delete(extension.id)) this.applyUi(extension, true)
    })
  }

  // ------------------------------------------------------------ state

  private async restore() {
    await this.ctx.stateStore.whenHydrated()
    const state = this.ctx.stateStore.getNamespace<PersistedDownloadsState>(DOWNLOADS_STATE_NS, {
      nextId: 1,
      items: [],
    })
    // A download may have started while the list was read; it keeps its id.
    this.nextId = Math.max(this.nextId, Number(state?.nextId) || 1)
    for (const item of Array.isArray(state?.items) ? state.items : []) {
      if (!item || typeof item.id !== 'number' || this.records.has(item.id)) continue
      const record = this.fromStored(item)
      this.records.set(record.id, record)
      this.nextId = Math.max(this.nextId, record.id + 1)
    }
    // A download that was running when the browser closed did not finish.
    let changed = false
    for (const record of this.records.values()) {
      if (record.state === 'in_progress') {
        record.state = 'interrupted'
        record.error = 'CRASH'
        record.paused = false
        record.canResume = false
        changed = true
      }
    }
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        if (!record.exists || !record.filename) return
        if (!(await exists(record.filename))) {
          record.exists = false
          changed = true
        }
      }),
    )
    if (changed) this.persist()
  }

  /** A stored record, from this version or the one before, in Chrome's shape. */
  private fromStored(item: any): DownloadRecord {
    const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
    const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
    const record: DownloadRecord = {
      id: item.id,
      url: str(item.url),
      finalUrl: str(item.finalUrl, str(item.url)),
      referrer: str(item.referrer),
      filename: str(item.filename),
      incognito: false,
      danger: str(item.danger, 'safe'),
      mime: str(item.mime),
      startTime: str(item.startTime, isoNow()),
      state: ['in_progress', 'interrupted', 'complete'].includes(item.state) ? item.state : 'interrupted',
      paused: item.paused === true,
      canResume: item.canResume === true,
      bytesReceived: num(item.bytesReceived),
      totalBytes: num(item.totalBytes, -1),
      fileSize: num(item.fileSize, num(item.totalBytes, -1)),
      exists: item.exists !== false,
    }
    if (typeof item.endTime === 'string') record.endTime = item.endTime
    if (typeof item.error === 'string') record.error = item.error
    const byId = item.byExtensionId ?? item.extensionId
    if (typeof byId === 'string') {
      record.byExtensionId = byId
      record.byExtensionName = str(item.byExtensionName)
    }
    return record
  }

  private persist() {
    // Newest kept when the list grows too long.
    const items = [...this.records.values()].sort((a, b) => a.id - b.id).slice(-MAX_RECORDS)
    if (items.length < this.records.size) {
      const keep = new Set(items.map((r) => r.id))
      for (const id of [...this.records.keys()]) if (!keep.has(id)) this.records.delete(id)
    }
    this.ctx.stateStore.setNamespace(DOWNLOADS_STATE_NS, { nextId: this.nextId, items })
    void this.ctx.stateStore.flush().catch(() => {})
  }

  /** Chrome's DownloadItem: optional fields only when they have a value. */
  private view(record: DownloadRecord, opts: { created?: boolean } = {}) {
    const out: Record<string, any> = {
      id: record.id,
      url: record.url,
      finalUrl: record.finalUrl,
      referrer: record.referrer,
      filename: record.filename,
      incognito: record.incognito,
      danger: record.danger,
      mime: record.mime,
      startTime: record.startTime,
      state: record.state,
      paused: record.paused,
      canResume: record.canResume,
      bytesReceived: record.bytesReceived,
      totalBytes: record.totalBytes,
      fileSize: record.fileSize,
      exists: record.exists,
    }
    if (record.endTime) out.endTime = record.endTime
    if (record.error) out.error = record.error
    // Chrome names the extension only once the download is under way.
    if (record.byExtensionId && !opts.created) {
      out.byExtensionId = record.byExtensionId
      out.byExtensionName = record.byExtensionName ?? ''
    }
    return out
  }

  /** Sends an event to every extension that may see downloads. */
  private broadcast(eventName: string, ...args: any[]) {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const all = ((sessionExtensions as any).getAllExtensions?.() || []) as Electron.Extension[]
    for (const extension of all) {
      if (!this.ctx.permissions.has(extension, 'downloads')) continue
      this.ctx.router.sendEvent(extension.id, eventName, ...args)
    }
  }

  private changed(record: DownloadRecord, before: Partial<DownloadRecord>) {
    const delta: Record<string, any> = { id: record.id }
    for (const [key, previous] of Object.entries(before)) {
      const current = (record as any)[key]
      if (current === previous) continue
      const entry: Record<string, any> = {}
      if (previous !== undefined) entry.previous = previous
      if (current !== undefined) entry.current = current
      delta[key] = entry
    }
    if (Object.keys(delta).length > 1) this.broadcast('downloads.onChanged', delta)
  }

  private snapshot(record: DownloadRecord): Partial<DownloadRecord> {
    const { state, paused, canResume, error, totalBytes, fileSize, filename, exists: fileExists, endTime, finalUrl, mime } =
      record
    return { state, paused, canResume, error, totalBytes, fileSize, filename, exists: fileExists, endTime, finalUrl, mime }
  }

  // ------------------------------------------------------------ the session's downloads

  private downloadsFolder() {
    return app.getPath('downloads')
  }

  private takePending(item: Electron.DownloadItem): PendingDownload | undefined {
    const now = Date.now()
    this.pending = this.pending.filter((p) => p.expires > now)
    const chain = [item.getURL(), ...(item.getURLChain?.() || [])]
    const index = this.pending.findIndex((p) => chain.includes(p.url))
    return index >= 0 ? this.pending.splice(index, 1)[0] : undefined
  }

  private observeSessionDownloads() {
    this.ctx.session.on('will-download', (_event, item) => {
      const pending = this.takePending(item)
      void this.restoreReady
      const id = pending?.id ?? this.nextId++
      const sessionExtensions = this.ctx.session.extensions || this.ctx.session
      const extension = pending ? sessionExtensions.getExtension(pending.extensionId) : undefined

      const record: DownloadRecord = {
        id,
        url: pending?.url ?? item.getURL(),
        finalUrl: item.getURL(),
        referrer: '',
        filename: '',
        incognito: false,
        danger: 'safe',
        mime: item.getMimeType() || '',
        startTime: new Date(item.getStartTime() ? item.getStartTime() * 1000 : Date.now()).toISOString(),
        state: 'in_progress',
        paused: false,
        canResume: false,
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes() || -1,
        fileSize: item.getTotalBytes() || -1,
        exists: true,
      }
      const chain = item.getURLChain?.() || []
      if (chain.length) record.finalUrl = chain[chain.length - 1]

      if (pending && extension) {
        this.place(item, record, pending)
      } else if (item.getSavePath()) {
        record.filename = item.getSavePath()
      }

      this.records.set(id, record)
      this.items.set(id, item)
      this.persist()
      this.broadcast('downloads.onCreated', this.view(record, { created: true }))
      if (pending && extension) {
        record.byExtensionId = extension.id
        record.byExtensionName = extension.name
      }
      this.watch(item, record)
    })
  }

  /** Decides where an extension's download is written, as the call asked. */
  private place(item: Electron.DownloadItem, record: DownloadRecord, pending: PendingDownload) {
    const listening = this.listeningForFilenames()
    if (pending.saveAs || pending.conflictAction === 'prompt') {
      // The person picks the place; Electron asks with its dialog.
      const name = pending.relative ?? safeBasename(item.getFilename())
      item.setSaveDialogOptions({ defaultPath: path.join(this.downloadsFolder(), name) })
      return
    }
    if (pending.target && listening.length === 0) {
      item.setSavePath(pending.target)
      record.filename = pending.target
      return
    }
    // The final name is chosen later, so the file starts under a name of its own.
    const temp = path.join(this.downloadsFolder(), `Unconfirmed ${randomUUID().slice(0, 8)}.crdownload`)
    item.setSavePath(temp)
    record.filename = path.join(this.downloadsFolder(), pending.relative ?? safeBasename(item.getFilename()))
    if (pending.target) this.reserved.delete(pending.target)
    let decide!: () => void
    const decided = new Promise<void>((resolve) => (decide = resolve))
    const placement: Placement = {
      temp,
      relative: pending.relative,
      conflictAction: pending.conflictAction,
      waiting: new Set(listening),
      decided,
      decide,
    }
    this.placements.set(record.id, placement)
    if (placement.waiting.size === 0) {
      decide()
      return
    }
    const timer = setTimeout(decide, DETERMINING_TIMEOUT_MS)
    void decided.then(() => clearTimeout(timer))
    const view = { ...this.view(record, { created: true }), filename: '' }
    for (const extensionId of listening) {
      this.ctx.router.sendEvent(extensionId, 'downloads.onDeterminingFilename', view)
    }
  }

  /** Extensions with an onDeterminingFilename listener. */
  private listeningForFilenames(): string[] {
    const router = this.ctx.router as any
    if (typeof router.hasListener !== 'function') return []
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const all = ((sessionExtensions as any).getAllExtensions?.() || []) as Electron.Extension[]
    return all
      .filter((e) => this.ctx.permissions.has(e, 'downloads') && router.hasListener(e.id, 'downloads.onDeterminingFilename'))
      .map((e) => e.id)
  }

  /** An onDeterminingFilename listener's answer: suggest() with or without a name. */
  private determineFilename = (
    { extension }: ExtensionEvent,
    id: number,
    suggestion?: { filename?: unknown; conflictAction?: unknown },
  ) => {
    const placement = this.placements.get(id)
    if (!placement || !placement.waiting.has(extension.id)) return
    placement.waiting.delete(extension.id)
    if (suggestion && typeof suggestion === 'object' && suggestion.filename !== undefined) {
      const filename = checkRelativeFilename(suggestion.filename)
      const conflictAction = suggestion.conflictAction ?? 'uniquify'
      if (conflictAction !== 'uniquify' && conflictAction !== 'overwrite' && conflictAction !== 'prompt') {
        throw new Error("Error at parameter 'suggestion': Error at property 'conflictAction': Invalid enumeration value.")
      }
      // The extension installed last wins in Chrome; here, the last to answer.
      placement.suggestion = { filename, conflictAction: conflictAction as ConflictAction }
      const record = this.records.get(id)
      if (record) {
        const before = this.snapshot(record)
        record.filename = path.join(this.downloadsFolder(), filename)
        this.changed(record, before)
      }
    }
    if (placement.waiting.size === 0) placement.decide()
  }

  /** A path not taken yet: "name (1).ext" and so on, as Chrome numbers them. */
  private async uniquePath(target: string): Promise<string> {
    const { dir, name, ext } = path.parse(target)
    for (let n = 0; n < 1000; n++) {
      const candidate = n === 0 ? target : path.join(dir, `${name} (${n})${ext}`)
      if (this.reserved.has(candidate)) continue
      if (!(await exists(candidate))) return candidate
    }
    return path.join(dir, `${name} (${randomUUID().slice(0, 8)})${ext}`)
  }

  /** Moves a finished download from its temporary name to the one decided. */
  private async finishPlacement(record: DownloadRecord, placement: Placement) {
    await placement.decided
    const relative = placement.suggestion?.filename ?? placement.relative
    const conflictAction = placement.suggestion?.conflictAction ?? placement.conflictAction
    const wanted = path.join(this.downloadsFolder(), relative ?? path.basename(record.filename))
    await fs.mkdir(path.dirname(wanted), { recursive: true })
    const target = conflictAction === 'overwrite' ? wanted : await this.uniquePath(wanted)
    await fs.rename(placement.temp, target)
    return target
  }

  private watch(item: Electron.DownloadItem, record: DownloadRecord) {
    item.on('updated', (_event, state) => {
      const before = this.snapshot(record)
      record.bytesReceived = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes() || -1
      record.fileSize = record.totalBytes
      record.paused = item.isPaused()
      record.canResume = item.canResume() && (record.paused || state === 'interrupted')
      if (!this.placements.has(record.id) && item.getSavePath()) record.filename = item.getSavePath()
      if (state === 'interrupted') {
        record.state = 'interrupted'
        record.error = 'NETWORK_FAILED'
      } else if (record.state !== 'complete') {
        record.state = 'in_progress'
        delete record.error
      }
      this.changed(record, before)
    })

    item.once('done', (_event, state) => {
      void (async () => {
        const before = this.snapshot(record)
        const placement = this.placements.get(record.id)
        record.bytesReceived = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes() || record.bytesReceived
        record.paused = false
        record.canResume = false
        if (state === 'completed') {
          if (placement) {
            try {
              record.filename = await this.finishPlacement(record, placement)
            } catch {
              record.state = 'interrupted'
              record.error = 'FILE_FAILED'
            }
          } else if (item.getSavePath()) {
            record.filename = item.getSavePath()
          }
          if (record.state !== 'interrupted') {
            record.state = 'complete'
            delete record.error
          }
        } else {
          record.state = 'interrupted'
          record.error = state === 'cancelled' ? 'USER_CANCELED' : 'NETWORK_FAILED'
          record.exists = false
          if (placement) void fs.rm(placement.temp, { force: true }).catch(() => {})
        }
        if (placement) this.placements.delete(record.id)
        this.reserved.delete(record.filename)
        record.fileSize = record.state === 'complete' ? record.bytesReceived : record.totalBytes
        record.endTime = isoNow()
        this.items.delete(record.id)
        this.persist()
        this.changed(record, before)
      })()
    })
  }

  // ------------------------------------------------------------ calls

  private record(id: unknown): DownloadRecord {
    const record = Number.isInteger(id) ? this.records.get(id as number) : undefined
    if (!record) throw new Error(ERRORS.invalidId)
    return record
  }

  private download = async ({ extension }: ExtensionEvent, options: chrome.downloads.DownloadOptions) => {
    await this.restoreReady
    if (!options || typeof options !== 'object') throw new Error(ERRORS.invalidUrl)
    const url = options.url
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) throw new Error(ERRORS.invalidUrl)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(ERRORS.invalidUrl)
    }
    // Web content, or the extension's own files; never local files or browser pages.
    const ownPage = parsed.protocol === 'chrome-extension:' && parsed.hostname === extension.id
    if (!['http:', 'https:', 'data:', 'blob:'].includes(parsed.protocol) && !ownPage) {
      throw new Error(ERRORS.invalidUrl)
    }
    const relative = options.filename !== undefined ? checkRelativeFilename(options.filename) : undefined
    const conflictAction = (options.conflictAction ?? 'uniquify') as ConflictAction
    if (!['uniquify', 'overwrite', 'prompt'].includes(conflictAction)) {
      throw new Error(
        "Error in invocation of downloads.download(downloads.DownloadOptions options, optional function callback): Error at parameter 'options': Error at property 'conflictAction': Value must be one of overwrite, prompt, uniquify.",
      )
    }
    const method = options.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(
        "Error in invocation of downloads.download(downloads.DownloadOptions options, optional function callback): Error at parameter 'options': Error at property 'method': Value must be one of GET, POST.",
      )
    }
    // Electron starts downloads with GET only.
    if (method === 'POST' || options.body !== undefined) throw new Error('POST downloads are not supported.')
    const headers: Record<string, string> = {}
    if (options.headers !== undefined) {
      if (!Array.isArray(options.headers) || options.headers.length > 100) throw new Error(ERRORS.headerName)
      for (const header of options.headers) {
        const name = header?.name
        if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(ERRORS.headerName)
        const lower = name.toLowerCase()
        if (UNSAFE_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) {
          throw new Error(ERRORS.headerUnsafe)
        }
        // eslint-disable-next-line no-control-regex
        if (typeof header.value !== 'string' || /[\r\n\x00]/.test(header.value)) throw new Error(ERRORS.headerValue)
        headers[name] = header.value
      }
    }

    let target: string | undefined
    if (relative !== undefined && conflictAction !== 'prompt' && options.saveAs !== true) {
      const wanted = path.join(this.downloadsFolder(), relative)
      await fs.mkdir(path.dirname(wanted), { recursive: true })
      target = conflictAction === 'overwrite' ? wanted : await this.uniquePath(wanted)
      this.reserved.add(target)
    }

    const id = this.nextId++
    this.pending.push({
      id,
      extensionId: extension.id,
      url: parsed.href === url ? url : parsed.href,
      target,
      relative,
      conflictAction,
      saveAs: options.saveAs === true,
      expires: Date.now() + PENDING_MS,
    })
    this.persist()
    this.ctx.session.downloadURL(url, Object.keys(headers).length ? { headers } : undefined)
    return id
  }

  /** Chrome's DownloadQuery, field by field. */
  private search = async (_event: ExtensionEvent, query: chrome.downloads.DownloadQuery = {}) => {
    await this.restoreReady
    if (!query || typeof query !== 'object') throw new Error(ERRORS.invalidFilter)
    const q = query as Record<string, any>
    const regex = (key: string) => {
      if (q[key] === undefined) return undefined
      if (typeof q[key] !== 'string' || q[key].length > 1000) throw new Error(`Invalid ${key}`)
      try {
        return new RegExp(q[key])
      } catch {
        throw new Error(`Invalid ${key}`)
      }
    }
    const filenameRegex = regex('filenameRegex')
    const urlRegex = regex('urlRegex')
    const finalUrlRegex = regex('finalUrlRegex')
    if (q.state !== undefined && !['in_progress', 'interrupted', 'complete'].includes(q.state)) {
      throw new Error(ERRORS.invalidState)
    }
    const limit = q.limit === undefined ? 1000 : q.limit
    if (!Number.isInteger(limit) || limit < 0) throw new Error(ERRORS.invalidLimit)
    const orderBy: string[] = q.orderBy === undefined ? [] : q.orderBy
    if (!Array.isArray(orderBy) || orderBy.some((f) => typeof f !== 'string' || !ORDER_FIELDS.has(f.replace(/^-/, '')))) {
      throw new Error(ERRORS.invalidOrderBy)
    }
    const terms = Array.isArray(q.query) ? q.query.filter((t: unknown) => typeof t === 'string').slice(0, 50) : []
    const time = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN)

    let items = [...this.records.values()].filter((r) => {
      for (const key of ['id', 'url', 'finalUrl', 'filename', 'danger', 'mime', 'startTime', 'endTime', 'state', 'paused', 'error', 'bytesReceived', 'totalBytes', 'fileSize', 'exists']) {
        if (q[key] !== undefined && (r as any)[key] !== q[key]) return false
      }
      if (filenameRegex && !filenameRegex.test(r.filename)) return false
      if (urlRegex && !urlRegex.test(r.url)) return false
      if (finalUrlRegex && !finalUrlRegex.test(r.finalUrl)) return false
      for (const term of terms) {
        const exclude = term.startsWith('-')
        const word = (exclude ? term.slice(1) : term).toLowerCase()
        const hit = r.filename.toLowerCase().includes(word) || r.url.toLowerCase().includes(word)
        if (hit === exclude) return false
      }
      const start = new Date(r.startTime).getTime()
      if (q.startedBefore !== undefined && !(start < time(q.startedBefore))) return false
      if (q.startedAfter !== undefined && !(start > time(q.startedAfter))) return false
      const end = r.endTime ? new Date(r.endTime).getTime() : NaN
      if (q.endedBefore !== undefined && !(end < time(q.endedBefore))) return false
      if (q.endedAfter !== undefined && !(end > time(q.endedAfter))) return false
      if (typeof q.totalBytesGreater === 'number' && !(r.totalBytes > q.totalBytesGreater)) return false
      if (typeof q.totalBytesLess === 'number' && !(r.totalBytes < q.totalBytesLess)) return false
      return true
    })

    if (orderBy.length) {
      items.sort((a, b) => {
        for (const field of orderBy) {
          const desc = field.startsWith('-')
          const key = field.replace(/^-/, '')
          const av = (a as any)[key]
          const bv = (b as any)[key]
          if (av === bv) continue
          const cmp = av === undefined ? -1 : bv === undefined ? 1 : av < bv ? -1 : 1
          return desc ? -cmp : cmp
        }
        return 0
      })
    }
    if (limit > 0) items = items.slice(0, limit)
    return items.map((r) => this.view(r))
  }

  private pause = async (_event: ExtensionEvent, id: number) => {
    await this.restoreReady
    const record = this.record(id)
    const item = this.items.get(record.id)
    if (!item || record.state !== 'in_progress') throw new Error(ERRORS.notInProgress)
    item.pause()
  }

  private resume = async (_event: ExtensionEvent, id: number) => {
    await this.restoreReady
    const record = this.record(id)
    const item = this.items.get(record.id)
    if (record.paused && !(item?.canResume() ?? false)) throw new Error(ERRORS.notResumable)
    if (item && item.isPaused()) item.resume()
  }

  private cancel = async (_event: ExtensionEvent, id: number) => {
    await this.restoreReady
    const record = this.record(id)
    const item = this.items.get(record.id)
    if (item && record.state === 'in_progress') item.cancel()
  }

  private erase = async (event: ExtensionEvent, query: chrome.downloads.DownloadQuery = {}) => {
    const matching = await this.search(event, { ...query, limit: query?.limit ?? 0 })
    const erased: number[] = []
    for (const { id } of matching) {
      const item = this.items.get(id)
      if (item && this.records.get(id)?.state === 'in_progress') item.cancel()
      this.records.delete(id)
      this.items.delete(id)
      erased.push(id)
    }
    if (erased.length) {
      this.persist()
      for (const id of erased) this.broadcast('downloads.onErased', id)
    }
    return erased
  }

  private async clearSince(since: number) {
    await this.restoreReady
    const erased: number[] = []
    for (const record of [...this.records.values()]) {
      if (new Date(record.startTime).getTime() < since) continue
      this.records.delete(record.id)
      erased.push(record.id)
    }
    if (erased.length) {
      this.persist()
      for (const id of erased) this.broadcast('downloads.onErased', id)
    }
  }

  private acceptDanger = async (_event: ExtensionEvent, id: number) => {
    await this.restoreReady
    this.record(id)
    // Nothing here is marked dangerous: PeerSky has no download scanning.
    throw new Error(ERRORS.notDangerous)
  }

  private getFileIcon = async (_event: ExtensionEvent, id: number, options?: { size?: number }) => {
    await this.restoreReady
    const record = this.record(id)
    const size = options?.size ?? 32
    if (size !== 16 && size !== 32) throw new Error('Invalid icon size')
    if (!record.filename) throw new Error(ERRORS.emptyFile)
    try {
      const icon = await app.getFileIcon(record.filename, { size: size === 16 ? 'small' : 'normal' })
      if (icon.isEmpty()) throw new Error('empty')
      return icon.toDataURL()
    } catch {
      throw new Error(ERRORS.iconNotFound)
    }
  }

  private open = async ({ extension, gesture }: ExtensionEvent, id: number) => {
    await this.restoreReady
    const record = this.record(id)
    if (!gesture && !this.ctx.store.hasUserGesture(extension.id)) throw new Error(ERRORS.userGesture)
    if (record.state !== 'complete') throw new Error(ERRORS.notComplete)
    if (!this.ctx.permissions.has(extension, 'downloads.open')) throw new Error(ERRORS.openPermission)
    if (!record.exists || !(await exists(record.filename))) throw new Error(ERRORS.fileDeleted)
    const failure = await shell.openPath(record.filename)
    if (failure) throw new Error(failure)
  }

  private show = async (_event: ExtensionEvent, id: number) => {
    await this.restoreReady
    const record = this.record(id)
    if (!record.filename) throw new Error(ERRORS.emptyFile)
    shell.showItemInFolder(record.filename)
  }

  private showDefaultFolder = async () => {
    await shell.openPath(this.downloadsFolder())
  }

  private removeFile = async (_event: ExtensionEvent, id: number) => {
    await this.restoreReady
    const record = this.record(id)
    if (record.state !== 'complete') throw new Error(ERRORS.notComplete)
    if (!record.exists || !record.filename) throw new Error(ERRORS.fileDeleted)
    try {
      await fs.unlink(record.filename)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(ERRORS.fileNotRemoved)
    }
    const before = this.snapshot(record)
    record.exists = false
    this.persist()
    this.changed(record, before)
  }

  private applyUi(extension: Electron.Extension, enabled: boolean) {
    try {
      this.ctx.store.impl.setDownloadUiEnabled?.(extension, enabled)
    } catch (error) {
      console.error('setDownloadUiEnabled failed', error)
    }
  }

  private setUi(extension: Electron.Extension, enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new Error("Error at parameter 'options': Missing required property 'enabled'.")
    if (enabled) {
      this.uiDisabledBy.delete(extension.id)
      if (this.uiDisabledBy.size > 0) throw new Error(ERRORS.uiDisabled)
    } else {
      this.uiDisabledBy.add(extension.id)
    }
    this.applyUi(extension, this.uiDisabledBy.size === 0)
  }

  private setUiOptions = async ({ extension }: ExtensionEvent, options: { enabled?: boolean }) => {
    if (!this.ctx.permissions.has(extension, 'downloads.ui')) throw new Error(ERRORS.uiPermission)
    this.setUi(extension, options?.enabled)
  }

  private setShelfEnabled = async ({ extension }: ExtensionEvent, enabled: boolean) => {
    if (!this.ctx.permissions.has(extension, 'downloads.shelf')) throw new Error(ERRORS.shelfPermission)
    this.setUi(extension, enabled)
  }
}
