import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ArgSpec, checkArgs, ParamSpec } from './arg-check'

const DATA_TYPES = [
  'appcache',
  'cache',
  'cacheStorage',
  'cookies',
  'downloads',
  'fileSystems',
  'formData',
  'history',
  'indexedDB',
  'localStorage',
  'serverBoundCertificates',
  'passwords',
  'pluginData',
  'serviceWorkers',
  'webSQL',
] as const
type DataType = (typeof DATA_TYPES)[number]

/** Gone from Chrome: a remove() that names them changes nothing. */
const IGNORED = new Set<DataType>(['appcache', 'serverBoundCertificates', 'passwords', 'pluginData', 'webSQL'])
/** Not kept per origin, so they cannot be removed for some origins only. */
const NOT_BY_ORIGIN = new Set<DataType>(['downloads', 'formData', 'history'])
/** Kept per origin in the session's storage. */
const STORAGE_TYPES: Partial<Record<DataType, NonNullable<Electron.ClearDataOptions['dataTypes']>[number]>> = {
  fileSystems: 'fileSystems',
  indexedDB: 'indexedDB',
  localStorage: 'localStorage',
  serviceWorkers: 'serviceWorkers',
}

const REMOVAL_OPTIONS: ArgSpec = {
  type: 'object',
  ref: 'browsingData.RemovalOptions',
  properties: {
    since: { type: 'number', optional: true },
    originTypes: {
      type: 'object',
      optional: true,
      properties: {
        unprotectedWeb: { type: 'boolean', optional: true },
        protectedWeb: { type: 'boolean', optional: true },
        extension: { type: 'boolean', optional: true },
      },
    },
    origins: { type: 'array', items: { type: 'string' }, optional: true, minItems: 1 },
    excludeOrigins: { type: 'array', items: { type: 'string' }, optional: true },
  },
}
const DATA_TYPE_SET: ArgSpec = {
  type: 'object',
  ref: 'browsingData.DataTypeSet',
  properties: Object.fromEntries(DATA_TYPES.map((t) => [t, { type: 'boolean', optional: true }])) as Record<
    string,
    ArgSpec
  >,
}
const OPTIONS_ONLY: ParamSpec[] = [{ name: 'options', spec: REMOVAL_OPTIONS }]

/** The single-type calls, and the type each removes. */
const REMOVE_ONE: Record<string, DataType> = {
  removeAppcache: 'appcache',
  removeCache: 'cache',
  removeCacheStorage: 'cacheStorage',
  removeCookies: 'cookies',
  removeDownloads: 'downloads',
  removeFileSystems: 'fileSystems',
  removeFormData: 'formData',
  removeHistory: 'history',
  removeIndexedDB: 'indexedDB',
  removeLocalStorage: 'localStorage',
  removePasswords: 'passwords',
  removePluginData: 'pluginData',
  removeServiceWorkers: 'serviceWorkers',
  removeWebSQL: 'webSQL',
}

const MAX_ORIGINS = 1000
const COOKIE_TIMES_NS = 'browsingDataCookieTimes'
const MAX_TRACKED_COOKIES = 20000

/** What the host hears after a removal, to clear what only it keeps. */
export interface BrowsingDataRemoval {
  extensionId: string
  /** Milliseconds since the epoch; 0 for all time. */
  since: number
  dataTypes: string[]
  origins?: string[]
  excludeOrigins?: string[]
}

/** 'example.com' for www.example.com, the host itself for an IP or a single label. */
function siteOf(host: string): string {
  const h = host.replace(/^\./, '').replace(/\.$/, '').toLowerCase()
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return h
  const labels = h.split('.')
  if (labels.length <= 2) return h
  // Without a public suffix list: two-letter country codes often have a
  // second level of their own (co.uk, com.au), so keep three labels there.
  const tld = labels[labels.length - 1]
  const second = labels[labels.length - 2]
  const keep = tld.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|mil)$/.test(second) ? 3 : 2
  return labels.slice(-keep).join('.')
}

const cookieKey = (c: Electron.Cookie) => `${c.domain || ''}|${c.path || '/'}|${c.name}`

/**
 * chrome.browsingData, mapped onto the session: cookies, the cache and each
 * kind of site storage, for all origins or some, with Chrome's errors.
 *
 * Electron removes storage for all time only, so a `since` other than 0
 * removes cache and site storage from every time; cookies follow `since`
 * from the times this library saw them set. History and downloads are kept by
 * other parts of the library and the host: they hear 'clear-history' and
 * 'clear-downloads' on the store. Every removal is also told to the host as a
 * 'browsing-data-removed' event, for what only the host keeps (form data).
 */
export class BrowsingDataAPI {
  private cookieTimes = new Map<string, number>()
  private trackingSince = Date.now()
  private ready: Promise<void>
  private saveTimer?: ReturnType<typeof setTimeout>

  constructor(private ctx: ExtensionContext) {
    const handle = ctx.router.apiHandler()
    const opts = { permission: 'browsingData' }
    handle('browsingData.settings', this.settings, opts)
    handle('browsingData.remove', this.remove, opts)
    for (const [method, type] of Object.entries(REMOVE_ONE)) {
      handle(`browsingData.${method}`, (event: ExtensionEvent, ...args: any[]) => this.removeOne(event, method, type, args), opts)
    }

    this.ready = Promise.resolve()
      .then(() => ctx.stateStore.whenHydrated())
      .catch(() => {})
      .then(() => {
        const saved = ctx.stateStore.getNamespace<{ since?: number; times?: Record<string, number> }>(COOKIE_TIMES_NS, {})
        if (typeof saved?.since === 'number') this.trackingSince = saved.since
        for (const [key, at] of Object.entries(saved?.times || {})) {
          if (typeof at === 'number' && !this.cookieTimes.has(key)) this.cookieTimes.set(key, at)
        }
      })

    // Electron's cookies carry no creation time, so it is noted here, kept as
    // Chrome keeps it when a cookie is overwritten.
    ctx.session.cookies?.on?.('changed', (_event, cookie, cause, removed) => {
      const key = cookieKey(cookie)
      if (removed) {
        if (cause !== 'overwrite') this.cookieTimes.delete(key)
      } else if (!this.cookieTimes.has(key)) {
        if (this.cookieTimes.size >= MAX_TRACKED_COOKIES) {
          const oldest = this.cookieTimes.keys().next().value
          if (oldest !== undefined) this.cookieTimes.delete(oldest)
        }
        this.cookieTimes.set(key, Date.now())
      } else {
        return
      }
      this.saveCookieTimesSoon()
    })
  }

  private saveCookieTimesSoon() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.ctx.stateStore.setNamespace(COOKIE_TIMES_NS, {
        since: this.trackingSince,
        times: Object.fromEntries(this.cookieTimes),
      })
    }, 5000)
    this.saveTimer.unref?.()
  }

  private settings = async (_event: ExtensionEvent, ...args: any[]) => {
    checkArgs('browsingData.settings', [], args)
    const all = Object.fromEntries(
      ['cache', 'cacheStorage', 'cookies', 'downloads', 'fileSystems', 'formData', 'history', 'indexedDB', 'localStorage', 'passwords', 'pluginData', 'serviceWorkers'].map((t) => [t, true]),
    )
    return {
      // Chrome's own Clear browsing data choices for a new profile.
      options: {
        since: Date.now() - 60 * 60 * 1000,
        originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false },
      },
      dataToRemove: { ...all, formData: false, passwords: false, pluginData: false },
      dataRemovalPermitted: all,
    }
  }

  private remove = async (event: ExtensionEvent, ...args: any[]) => {
    checkArgs(
      'browsingData.remove',
      [
        { name: 'options', spec: REMOVAL_OPTIONS },
        { name: 'dataToRemove', spec: DATA_TYPE_SET },
      ],
      args,
    )
    const types = DATA_TYPES.filter((t) => args[1][t] === true)
    await this.run(event.extension, args[0], types)
  }

  private async removeOne({ extension }: ExtensionEvent, method: string, type: DataType, args: any[]) {
    checkArgs(`browsingData.${method}`, OPTIONS_ONLY, args)
    if (type === 'passwords') throw new Error('Requested data type is deprecated.')
    await this.run(extension, args[0], [type])
  }

  private async run(extension: Electron.Extension, options: chrome.browsingData.RemovalOptions, requested: DataType[]) {
    const types = requested.filter((t) => !IGNORED.has(t))
    const since = typeof options.since === 'number' && options.since > 0 ? options.since : 0
    const mask = options.originTypes
      ? {
          web: options.originTypes.unprotectedWeb === true,
          extension: options.originTypes.extension === true,
        }
      : { web: true, extension: false }

    if (options.origins && options.excludeOrigins) {
      throw new Error("Don't set both 'origins' and 'excludeOrigins' at the same time.")
    }
    const parse = (list: string[]) => {
      if (list.length > MAX_ORIGINS) throw new Error('Invalid invocation')
      return list.map((o) => {
        const origin = parseOrigin(o)
        if (!origin) throw new Error(`'${o}' is not a valid origin.`)
        return origin
      })
    }
    const origins = options.origins ? parse(options.origins) : undefined
    const excludeOrigins = options.excludeOrigins ? parse(options.excludeOrigins) : undefined
    if ((origins || excludeOrigins) && types.some((t) => NOT_BY_ORIGIN.has(t))) {
      throw new Error("At least one data type doesn't support filtering by origin.")
    }
    if (types.length === 0) return

    // An extension may clear its own pages' data, never another extension's
    // or the browser's own pages'.
    const own = `chrome-extension://${extension.id}`
    const protectedOrigins = this.protectedOrigins().filter((o) => !(mask.extension && o === own))
    const allowed = (origin: string) => {
      if (protectedOrigins.includes(origin)) return false
      return origin.startsWith('chrome-extension://') ? mask.extension && origin === own : mask.web
    }

    let filter: { origins?: string[]; excludeOrigins?: string[] } | undefined
    if (origins) {
      const kept = origins.filter(allowed)
      filter = kept.length ? { origins: kept } : undefined
    } else if (!mask.web) {
      filter = mask.extension ? { origins: [own] } : undefined
    } else {
      filter = { excludeOrigins: [...new Set([...(excludeOrigins || []), ...protectedOrigins])] }
    }

    const jobs: Promise<unknown>[] = []
    const storage = types.map((t) => STORAGE_TYPES[t]).filter((t): t is NonNullable<typeof t> => !!t)
    if (filter && storage.length) jobs.push(this.ctx.session.clearData({ dataTypes: storage, ...filter }))
    if (filter && types.includes('cache')) {
      // Electron's "cache" type takes sites' Cache Storage with the HTTP
      // cache. Only a list of origins needs it; otherwise the HTTP cache alone
      // goes, which costs at most a reload of what is left out.
      jobs.push(
        filter.origins
          ? this.ctx.session.clearData({ dataTypes: ['cache'], origins: filter.origins })
          : this.ctx.session.clearCache(),
      )
    }
    if (filter && types.includes('cacheStorage')) jobs.push(this.removeCacheStorage(filter))
    if (types.includes('cookies') && (mask.web || origins)) {
      jobs.push(this.removeCookies(since, origins?.filter(allowed), excludeOrigins))
    }
    if (types.includes('history')) this.ctx.store.emit('clear-history', { since })
    if (types.includes('downloads')) this.ctx.store.emit('clear-downloads', { since })
    await Promise.all(jobs)

    const removal: BrowsingDataRemoval = {
      extensionId: extension.id,
      since,
      dataTypes: types,
      ...(options.origins ? { origins: options.origins } : {}),
      ...(options.excludeOrigins ? { excludeOrigins: options.excludeOrigins } : {}),
    }
    this.ctx.emit('browsing-data-removed', removal)
  }

  /** Extension origins, and what the host names, are never cleared for another extension. */
  private protectedOrigins(): string[] {
    const sessionExtensions: any = this.ctx.session.extensions || this.ctx.session
    const all: Electron.Extension[] = sessionExtensions.getAllExtensions?.() || []
    const fromHost = this.ctx.store.impl.getProtectedOrigins?.() || []
    return [
      ...all.map((e) => `chrome-extension://${e.id}`),
      ...fromHost.map(parseOrigin).filter((o): o is string => !!o),
    ]
  }

  private async removeCacheStorage(filter: { origins?: string[]; excludeOrigins?: string[] }) {
    if (filter.origins) {
      await Promise.all(
        filter.origins.map((origin) => this.ctx.session.clearStorageData({ origin, storages: ['cachestorage'] })),
      )
      return
    }
    // Electron's "cache" type takes Cache Storage with the HTTP cache, and it
    // is the only one that can leave some origins out.
    await this.ctx.session.clearData({ dataTypes: ['cache'], excludeOrigins: filter.excludeOrigins })
  }

  private async removeCookies(since: number, origins?: string[], excludeOrigins?: string[]) {
    if (origins && origins.length === 0) return
    await this.ready
    if (since === 0) {
      // Chromium matches cookies to origins by site itself.
      const filter = origins ? { origins } : excludeOrigins?.length ? { excludeOrigins } : {}
      await this.ctx.session.clearData({ dataTypes: ['cookies'], ...filter })
      return
    }
    const sites = (list?: string[]) => list && new Set(list.map((o) => siteOf(new URL(o).hostname)))
    const only = sites(origins)
    const except = sites(excludeOrigins)
    const cookies = await this.ctx.session.cookies.get({})
    await Promise.all(
      cookies.map(async (cookie) => {
        const site = siteOf(cookie.domain || '')
        if (only && !only.has(site)) return
        if (except && except.has(site)) return
        const at = this.cookieTimes.get(cookieKey(cookie))
        // A cookie set before this library was watching may be from any time
        // after `trackingSince`, so it goes when `since` is earlier than that.
        const inRange = at !== undefined ? at >= since : since <= this.trackingSince
        if (!inRange) return
        const host = (cookie.domain || '').replace(/^\./, '')
        const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`
        await this.ctx.session.cookies.remove(url, cookie.name).catch(() => {})
      }),
    )
  }
}

/** The origin of `value` as Chrome reads one, or undefined when it is not one. */
export function parseOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.origin !== 'null') return url.origin
  // WHATWG gives file: and non-web schemes an opaque origin; Chrome does not.
  if (url.protocol === 'file:') return 'file://'
  if (url.host && !['data:', 'about:', 'blob:', 'javascript:'].includes(url.protocol)) {
    return `${url.protocol}//${url.host}`
  }
  return undefined
}
