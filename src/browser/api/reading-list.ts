import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { checkArgs, MAX_URL_LENGTH, ParamSpec, sendToPermitted, tryParseUrl } from './lib/arg-spec'

interface Entry {
  url: string
  title: string
  hasBeenRead: boolean
  creationTime: number
  lastUpdateTime: number
}

const STATE_NS = 'readingList'
// Chrome sets no limit; the list is kept in one JSON file, so it has one here.
const MAX_ENTRIES = 5_000
const MAX_TITLE = 4096
/** URLs and titles together, in characters. */
const MAX_TOTAL_CHARS = 8 * 1024 * 1024

const ERR = {
  invalid: 'URL is not valid.',
  unsupported: 'URL is not supported.',
  duplicate: 'Duplicate URL.',
  notFound: 'URL not found.',
  nothing: 'At least one of `title` or `hasBeenRead` must be provided.',
  full: 'Reading list is full.',
}

const sig = (name: string, type: string, param: string) =>
  `readingList.${name}(readingList.${type} ${param}, optional function callback)`
const SIGNATURES: Record<string, [string, ParamSpec[]]> = {
  addEntry: [
    sig('addEntry', 'AddEntryOptions', 'entry'),
    [
      {
        name: 'entry',
        spec: {
          type: 'object',
          properties: { title: { type: 'string' }, url: { type: 'string' }, hasBeenRead: { type: 'boolean' } },
        },
      },
    ],
  ],
  removeEntry: [
    sig('removeEntry', 'RemoveOptions', 'info'),
    [{ name: 'info', spec: { type: 'object', properties: { url: { type: 'string' } } } }],
  ],
  updateEntry: [
    sig('updateEntry', 'UpdateEntryOptions', 'info'),
    [
      {
        name: 'info',
        spec: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string', optional: true },
            hasBeenRead: { type: 'boolean', optional: true },
          },
        },
      },
    ],
  ],
  query: [
    sig('query', 'QueryInfo', 'info'),
    [
      {
        name: 'info',
        spec: {
          type: 'object',
          properties: {
            url: { type: 'string', optional: true },
            title: { type: 'string', optional: true },
            hasBeenRead: { type: 'boolean', optional: true },
          },
        },
      },
    ],
  ],
}

/** chrome.readingList: a list per session, of web pages only, as in Chrome. */
export class ReadingListAPI {
  private entries?: Entry[]
  private loading?: Promise<Entry[]>
  private flushTimer?: NodeJS.Timeout

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const wrap =
      (name: keyof typeof SIGNATURES, fn: (entries: Entry[], ...args: any[]) => any) =>
      async (_event: ExtensionEvent, ...args: any[]) => {
        const [signature, params] = SIGNATURES[name]
        const resolved = checkArgs(signature, params, args)
        const entries = await this.load()
        return fn.call(this, entries, ...resolved)
      }
    handle('readingList.addEntry', wrap('addEntry', this.addEntry))
    handle('readingList.removeEntry', wrap('removeEntry', this.removeEntry))
    handle('readingList.updateEntry', wrap('updateEntry', this.updateEntry))
    handle('readingList.query', wrap('query', this.query))
  }

  private load(): Promise<Entry[]> {
    if (this.entries) return Promise.resolve(this.entries)
    if (!this.loading) {
      this.loading = this.ctx.stateStore.whenHydrated().then(() => {
        if (this.entries) return this.entries
        const saved = this.ctx.stateStore.getNamespace<unknown>(STATE_NS, [])
        const entries = Array.isArray(saved)
          ? saved.filter(
              (e: any): e is Entry =>
                !!e &&
                typeof e.url === 'string' &&
                typeof e.title === 'string' &&
                typeof e.hasBeenRead === 'boolean' &&
                typeof e.creationTime === 'number' &&
                typeof e.lastUpdateTime === 'number',
            )
          : []
        this.entries = entries
        return entries
      })
    }
    return this.loading
  }

  private persist() {
    this.ctx.stateStore.setNamespace(STATE_NS, this.entries)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.ctx.stateStore.flush().catch((error) => console.error('Failed to save the reading list:', error))
    }, 250)
    this.flushTimer.unref?.()
  }

  /** Chrome's checks: a URL at all, then a web page. */
  private checkUrl(url: string, supported = true) {
    const parsed = url.length <= MAX_URL_LENGTH ? tryParseUrl(url) : undefined
    if (!parsed) throw new Error(ERR.invalid)
    if (supported && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(ERR.unsupported)
    return parsed.href
  }

  private copy(entry: Entry): Entry {
    return { ...entry }
  }

  private dispatch(eventName: string, entry: Entry) {
    sendToPermitted(this.ctx, 'readingList', eventName, this.copy(entry))
  }

  private addEntry(entries: Entry[], options: { title: string; url: string; hasBeenRead: boolean }) {
    const url = this.checkUrl(options.url)
    if (entries.some((e) => e.url === url)) throw new Error(ERR.duplicate)
    const used = entries.reduce((sum, e) => sum + e.url.length + e.title.length, 0)
    if (entries.length >= MAX_ENTRIES || used + url.length + Math.min(options.title.length, MAX_TITLE) > MAX_TOTAL_CHARS) {
      throw new Error(ERR.full)
    }
    const now = Date.now()
    const entry: Entry = {
      url,
      title: options.title.slice(0, MAX_TITLE),
      hasBeenRead: false,
      creationTime: now,
      lastUpdateTime: now,
    }
    entries.push(entry)
    this.persist()
    this.dispatch('readingList.onEntryAdded', entry)
    // Chrome adds the entry unread, then marks it read: a second event.
    if (options.hasBeenRead) {
      entry.hasBeenRead = true
      entry.lastUpdateTime = Date.now()
      this.dispatch('readingList.onEntryUpdated', entry)
    }
  }

  private removeEntry(entries: Entry[], info: { url: string }) {
    const url = this.checkUrl(info.url)
    const index = entries.findIndex((e) => e.url === url)
    if (index < 0) throw new Error(ERR.notFound)
    const [entry] = entries.splice(index, 1)
    this.persist()
    this.dispatch('readingList.onEntryRemoved', entry)
  }

  private updateEntry(entries: Entry[], info: { url: string; title?: string; hasBeenRead?: boolean }) {
    const url = this.checkUrl(info.url)
    if (info.title === undefined && info.hasBeenRead === undefined) throw new Error(ERR.nothing)
    const entry = entries.find((e) => e.url === url)
    if (!entry) throw new Error(ERR.notFound)
    // Title first, then read status, each its own event, and none for no change: as Chrome does.
    const title = info.title?.slice(0, MAX_TITLE)
    if (title !== undefined && title !== entry.title) {
      entry.title = title
      entry.lastUpdateTime = Date.now()
      this.persist()
      this.dispatch('readingList.onEntryUpdated', entry)
    }
    if (info.hasBeenRead !== undefined && info.hasBeenRead !== entry.hasBeenRead) {
      entry.hasBeenRead = info.hasBeenRead
      entry.lastUpdateTime = Date.now()
      this.persist()
      this.dispatch('readingList.onEntryUpdated', entry)
    }
  }

  private query(entries: Entry[], info: { url?: string; title?: string; hasBeenRead?: boolean }) {
    const url = info.url !== undefined ? this.checkUrl(info.url, false) : undefined
    return entries
      .filter(
        (e) =>
          (url === undefined || e.url === url) &&
          (info.title === undefined || e.title === info.title) &&
          (info.hasBeenRead === undefined || e.hasBeenRead === info.hasBeenRead),
      )
      .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
      .map((e) => this.copy(e))
  }
}
