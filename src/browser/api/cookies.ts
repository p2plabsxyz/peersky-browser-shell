import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/** The session has one cookie store, which Chrome calls '0'. */
const DEFAULT_STORE_ID = '0'

const SAME_SITE = ['no_restriction', 'lax', 'strict', 'unspecified'] as const
type SameSite = (typeof SAME_SITE)[number]

// Electron reports the cookie store's own causes; Chrome folds the insert
// variants into 'explicit'.
const CAUSES: Record<string, string> = {
  inserted: 'explicit',
  'inserted-no-change-overwrite': 'explicit',
  'inserted-no-value-change-overwrite': 'explicit',
  explicit: 'explicit',
  overwrite: 'overwrite',
  expired: 'expired',
  evicted: 'evicted',
  'expired-overwrite': 'expired_overwrite',
}

const MAX_STRING = 4096
const MAX_URL = 8192

const isString = (v: unknown): v is string => typeof v === 'string'

function invalidArgument(method: string, message: string): never {
  throw new Error(`Error in invocation of cookies.${method}: ${message}`)
}

function readOptionalString(method: string, details: any, key: string, max = MAX_STRING) {
  const value = details?.[key]
  if (value === undefined || value === null) return undefined
  if (!isString(value)) invalidArgument(method, `Error at property '${key}': Invalid type: expected string, found ${typeof value}.`)
  if (value.length > max) invalidArgument(method, `Error at property '${key}': Value is too long.`)
  return value
}

function readOptionalBoolean(method: string, details: any, key: string) {
  const value = details?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') invalidArgument(method, `Error at property '${key}': Invalid type: expected boolean, found ${typeof value}.`)
  return value
}

/** A URL Chrome accepts for a cookie call, or Chrome's error. */
function parseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new Error(`Invalid url: "${url}".`)
  }
}

/** The URL Chrome checks host permissions against for a stored cookie. */
function cookieUrl(cookie: Electron.Cookie): string {
  const host = (cookie.domain || '').replace(/^\./, '')
  return `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`
}

const toChromeSameSite = (value: string | undefined): SameSite =>
  (SAME_SITE as readonly string[]).includes(value as string) ? (value as SameSite) : 'unspecified'

/** Chrome's Cookie: expirationDate only for persistent cookies, no Electron extras. */
function toChromeCookie(cookie: Electron.Cookie): chrome.cookies.Cookie {
  const out: chrome.cookies.Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '',
    hostOnly: Boolean(cookie.hostOnly),
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: toChromeSameSite(cookie.sameSite),
    session: Boolean(cookie.session),
    storeId: DEFAULT_STORE_ID,
  }
  if (!out.session && typeof cookie.expirationDate === 'number') {
    out.expirationDate = cookie.expirationDate
  }
  return out
}

/**
 * Chrome's order for cookies that match a URL: longest path first, then the
 * oldest. Electron keeps creation order, which stands in for creation time.
 */
function sortCookies(cookies: Electron.Cookie[]): Electron.Cookie[] {
  return cookies
    .map((cookie, index) => ({ cookie, index }))
    .sort((a, b) => {
      const byPath = (b.cookie.path || '').length - (a.cookie.path || '').length
      if (byPath !== 0) return byPath
      const aCreation = Number((a.cookie as any).creation ?? 0)
      const bCreation = Number((b.cookie as any).creation ?? 0)
      if (!Number.isNaN(aCreation) && !Number.isNaN(bCreation) && aCreation !== bCreation) {
        return aCreation - bCreation
      }
      return a.index - b.index
    })
    .map((entry) => entry.cookie)
}

/** Chrome's domain filter: the cookie's domain is the given one or under it. */
function domainMatches(cookieDomain: string, wanted: string) {
  const domain = cookieDomain.replace(/^\./, '').toLowerCase()
  const want = wanted.replace(/^\./, '').toLowerCase()
  return domain === want || domain.endsWith('.' + want)
}

export class CookiesAPI {
  private get cookies() {
    return this.ctx.session.cookies
  }

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('cookies.get', this.get.bind(this))
    handle('cookies.getAll', this.getAll.bind(this))
    handle('cookies.set', this.set.bind(this))
    handle('cookies.remove', this.remove.bind(this))
    handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this))
    handle('cookies.getPartitionKey', this.getPartitionKey.bind(this))

    this.cookies.addListener('changed', this.onChanged)
  }

  private hasAccess(extension: Electron.Extension, url: string) {
    const permissions = this.ctx.permissions
    return permissions ? permissions.hasHostAccess(extension, url) : false
  }

  private checkStore(storeId: unknown) {
    if (storeId === undefined || storeId === null) return
    if (!isString(storeId) || storeId !== DEFAULT_STORE_ID) {
      throw new Error(`No cookie store found with id: ${String(storeId).slice(0, 64)}.`)
    }
  }

  /** Reads url and checks host access, as every call that names a url does. */
  private checkUrl(method: string, extension: Electron.Extension, details: any): string {
    const url = details?.url
    if (!isString(url)) invalidArgument(method, `Error at property 'url': Property is required.`)
    if (url.length > MAX_URL) throw new Error(`Invalid url: "${url.slice(0, 64)}...".`)
    parseUrl(url)
    if (!this.hasAccess(extension, url)) {
      throw new Error(`No host permissions for cookies at url: "${url}".`)
    }
    return url
  }

  private async get(
    { extension }: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    const url = this.checkUrl('get', extension, details)
    const name = readOptionalString('get', details, 'name')
    if (name === undefined) invalidArgument('get', `Error at property 'name': Property is required.`)
    this.checkStore(details.storeId)

    const cookies = await this.cookies.get({ url, name })
    const best = sortCookies(cookies.filter((c) => c.name === name))[0]
    return best ? toChromeCookie(best) : null
  }

  private async getAll(
    { extension }: ExtensionEvent,
    details: chrome.cookies.GetAllDetails = {},
  ): Promise<chrome.cookies.Cookie[]> {
    if (details !== undefined && (details === null || typeof details !== 'object')) {
      invalidArgument('getAll', `Error at parameter 'details': Invalid type: expected object.`)
    }
    const url = readOptionalString('getAll', details, 'url', MAX_URL)
    const name = readOptionalString('getAll', details, 'name')
    const domain = readOptionalString('getAll', details, 'domain')
    const path = readOptionalString('getAll', details, 'path')
    const secure = readOptionalBoolean('getAll', details, 'secure')
    const session = readOptionalBoolean('getAll', details, 'session')
    this.checkStore(details.storeId)
    if (url !== undefined) parseUrl(url)

    const filter: Electron.CookiesGetFilter = {}
    if (url !== undefined) filter.url = url
    if (name !== undefined) filter.name = name
    const cookies = await this.cookies.get(filter)

    // Chrome lists only cookies the extension has host access to.
    const matching = cookies.filter((cookie) => {
      if (name !== undefined && cookie.name !== name) return false
      if (domain !== undefined && !domainMatches(cookie.domain || '', domain)) return false
      if (path !== undefined && cookie.path !== path) return false
      if (secure !== undefined && Boolean(cookie.secure) !== secure) return false
      if (session !== undefined && Boolean(cookie.session) !== session) return false
      return this.hasAccess(extension, cookieUrl(cookie))
    })
    return sortCookies(matching).map(toChromeCookie)
  }

  private async set(
    { extension }: ExtensionEvent,
    details: chrome.cookies.SetDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    const url = this.checkUrl('set', extension, details)
    this.checkStore(details.storeId)
    const name = readOptionalString('set', details, 'name') ?? ''
    const value = readOptionalString('set', details, 'value') ?? ''
    const domain = readOptionalString('set', details, 'domain')
    const path = readOptionalString('set', details, 'path')
    const secure = readOptionalBoolean('set', details, 'secure')
    const httpOnly = readOptionalBoolean('set', details, 'httpOnly')
    let sameSite: SameSite = 'unspecified'
    if (details.sameSite !== undefined && details.sameSite !== null) {
      if (!(SAME_SITE as readonly string[]).includes(details.sameSite as string)) {
        invalidArgument(
          'set',
          `Error at property 'sameSite': Value must be one of no_restriction, lax, strict, unspecified.`,
        )
      }
      sameSite = details.sameSite as SameSite
    }
    let expirationDate: number | undefined
    if (details.expirationDate !== undefined && details.expirationDate !== null) {
      if (typeof details.expirationDate !== 'number' || !Number.isFinite(details.expirationDate)) {
        invalidArgument('set', `Error at property 'expirationDate': Invalid type: expected number.`)
      }
      expirationDate = details.expirationDate
    }

    const setDetails: Electron.CookiesSetDetails = { url, name, value, sameSite }
    if (domain !== undefined) setDetails.domain = domain
    if (path !== undefined) setDetails.path = path
    if (secure !== undefined) setDetails.secure = secure
    if (httpOnly !== undefined) setDetails.httpOnly = httpOnly
    if (expirationDate !== undefined) setDetails.expirationDate = expirationDate

    try {
      await this.cookies.set(setDetails)
    } catch {
      throw new Error(`Failed to parse or set cookie named "${name}".`)
    }

    // The cookie the call made: same name, and the path and domain it asked for.
    const stored = await this.cookies.get({ url, name })
    const wantedPath = path ?? undefined
    const candidates = stored.filter(
      (c) =>
        c.name === name &&
        (wantedPath === undefined || c.path === wantedPath) &&
        (domain === undefined || domainMatches(c.domain || '', domain)),
    )
    const best = sortCookies(candidates)[0]
    // An already expired cookie is deleted at once; Chrome returns nothing then.
    return best ? toChromeCookie(best) : null
  }

  private async remove(
    { extension }: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.CookieDetails | null> {
    const url = this.checkUrl('remove', extension, details)
    const name = readOptionalString('remove', details, 'name')
    if (name === undefined) invalidArgument('remove', `Error at property 'name': Property is required.`)
    this.checkStore(details.storeId)

    try {
      await this.cookies.remove(url, name)
    } catch {
      // Chrome reports the details whether or not a cookie was there.
    }
    return { url, name, storeId: DEFAULT_STORE_ID }
  }

  private getAllCookieStores(_event: ExtensionEvent): chrome.cookies.CookieStore[] {
    const tabIds = Array.from(this.ctx.store.tabs)
      .filter((tab) => !tab.isDestroyed())
      .map((tab) => tab.id)
    return [{ id: DEFAULT_STORE_ID, tabIds }]
  }

  /**
   * The partition key of a frame's cookies: the site of its top-level page,
   * and whether a cross-site frame sits between them.
   */
  private getPartitionKey(
    { extension }: ExtensionEvent,
    details: { tabId?: number; frameId?: number; documentId?: string },
  ) {
    if (!details || typeof details !== 'object') {
      invalidArgument('getPartitionKey', `Error at parameter 'details': Invalid type: expected object.`)
    }
    let tabId = details.tabId
    let frameId = details.frameId
    if (isString(details.documentId)) {
      const resolved = this.ctx.store.resolveByDocumentId(details.documentId)
      if (!resolved) throw new Error(`Invalid documentId: ${details.documentId.slice(0, 64)}.`)
      if (typeof tabId === 'number' && tabId !== resolved.tabId) {
        throw new Error('Provided documentId does not match the given tabId.')
      }
      tabId = resolved.tabId
      frameId = resolved.frameId
    }
    if (typeof tabId !== 'number') throw new Error('Either tabId or documentId must be provided.')
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) throw new Error(`No tab with id: ${tabId}.`)
    const main = tab.mainFrame
    const frame =
      typeof frameId !== 'number' || frameId === 0
        ? main
        : main.framesInSubtree.find((f) => f !== f.top && f.frameTreeNodeId === frameId)
    if (!frame) throw new Error(`No frame with id ${frameId} in tab ${tabId}.`)
    if (!this.hasAccess(extension, frame.url)) {
      throw new Error(`No host permissions for cookies at url: "${frame.url}".`)
    }
    const site = (url: string) => {
      try {
        const u = new URL(url)
        return `${u.protocol}//${u.hostname}`
      } catch {
        return ''
      }
    }
    const topSite = site(main.url)
    let crossSite = false
    for (let f: Electron.WebFrameMain | null = frame; f && f !== main; f = f.parent) {
      if (site(f.url) !== topSite) crossSite = true
    }
    return { partitionKey: { topLevelSite: topSite, hasCrossSiteAncestor: crossSite } }
  }

  private onChanged = (
    _event: Electron.Event,
    cookie: Electron.Cookie,
    cause: string,
    removed: boolean,
  ) => {
    const changeInfo: chrome.cookies.CookieChangeInfo = {
      cause: (CAUSES[cause] || 'explicit') as chrome.cookies.CookieChangeInfo['cause'],
      cookie: toChromeCookie(cookie),
      removed,
    }
    // Only extensions with host access to the cookie hear about it.
    const url = cookieUrl(cookie)
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const all = (sessionExtensions as any).getAllExtensions?.() as Electron.Extension[] | undefined
    for (const extension of all || []) {
      if (!this.ctx.permissions?.has(extension, 'cookies')) continue
      if (!this.hasAccess(extension, url)) continue
      this.ctx.router.sendEvent(extension.id, 'cookies.onChanged', changeInfo)
    }
  }
}
