import { nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { BlockList, isIP } from 'node:net'
import debug from 'debug'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { TabContents, validateExtensionResource } from './common'
import { GuardedRegExp, RegexBudget, newRegexBudget } from './lib/guarded-regexp'

export { newRegexBudget }

const d = debug('electron-chrome-extensions:declarativeContent')

const STATE_NS = 'declarativeContent.rules'
const PAGE_STATE_MATCHER = 'declarativeContent.PageStateMatcher'
const SHOW_ACTION = 'declarativeContent.ShowAction'
const SHOW_PAGE_ACTION = 'declarativeContent.ShowPageAction'
const SET_ICON = 'declarativeContent.SetIcon'
const REQUEST_CONTENT_SCRIPT = 'declarativeContent.RequestContentScript'

// Limits on what one extension may store. Chrome has none written down, but
// rules live in memory and on disk and are matched on every page load.
const MAX_RULES = 1000
const MAX_ITEMS = 100
const MAX_STRING = 2048
const MAX_SELECTORS = 1000
const MAX_ICON_SIZE = 256
const MAX_ICON_BYTES = 8 + MAX_ICON_SIZE * MAX_ICON_SIZE * 4
// All of one extension's rules, as stored.
const MAX_RULES_BYTES = 4 * 1024 * 1024

// The world chrome.scripting injects into, so a script a rule injects shares
// its globals with executeScript, as both share one world in Chrome.
const SCRIPT_WORLD = 1000
// Where the CSS selector watcher runs: a world of its own, out of the page's
// reach and out of the extensions'.
const CSS_WATCH_WORLD = 1999
// A watcher answers at least this often, so a page that never changes does
// not keep a call open forever.
const CSS_WATCH_MAX_WAIT_MS = 30_000

// urlMatches runs an extension's regular expression in the main process,
// under a time limit (lib/guarded-regexp.ts).

const INJECTABLE_SCHEMES = new Set(['http:', 'https:', 'file:', 'ftp:'])

export class InvalidInvocation extends Error {
  constructor() {
    super('Invalid invocation')
  }
}

const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const isStringList = (v: unknown, max = MAX_ITEMS): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s.length <= MAX_STRING)

// ---------------------------------------------------------------- UrlFilter

const STRING_CRITERIA = [
  'hostContains', 'hostEquals', 'hostPrefix', 'hostSuffix',
  'pathContains', 'pathEquals', 'pathPrefix', 'pathSuffix',
  'queryContains', 'queryEquals', 'queryPrefix', 'querySuffix',
  'urlContains', 'urlEquals', 'urlMatches', 'originAndPathMatches', 'urlPrefix', 'urlSuffix',
] as const
const HOST_CRITERIA = new Set(['hostContains', 'hostEquals', 'hostPrefix', 'hostSuffix'])
const LIST_CRITERIA = new Set(['schemes', 'ports', 'cidrBlocks'])

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 }

/**
 * Compiles a pattern the way Chrome's RE2 reads it, with RE2's wording for the
 * failures. JavaScript reads most RE2 patterns the same; the few RE2 refuses
 * (lookaround, backreferences) are refused here too.
 */
function compileRegExp(pattern: string, budget: RegexBudget): GuardedRegExp {
  const fail = (what: string) => {
    throw new Error(`Could not parse regular expression '${pattern}': ${what}`)
  }
  const lookaround = pattern.match(/\(\?<?[=!]/)
  if (lookaround) fail(`invalid perl operator: ${lookaround[0]}`)
  const backref = pattern.match(/\\[1-9]/)
  if (backref) fail(`invalid escape sequence: ${backref[0]}`)
  let source = pattern.replace(/\(\?P</g, '(?<')
  let flags = ''
  const inline = source.match(/^\(\?([ims]+)\)/)
  if (inline) {
    flags = [...new Set(inline[1].replace('m', ''))].join('')
    source = source.slice(inline[0].length)
  }
  try {
    return new GuardedRegExp(new RegExp(source, flags), budget, 'declarativeContent')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/Unterminated group/.test(message)) fail(`missing ): ${pattern}`)
    if (/Unmatched '\)'/.test(message)) fail(`unexpected ): ${pattern}`)
    if (/Unterminated character class/.test(message)) fail(`missing ]: ${pattern}`)
    if (/Nothing to repeat/.test(message)) fail(`missing argument to repetition operator: ${pattern}`)
    if (/out of order in character class/.test(message)) fail(`invalid character class range: ${pattern}`)
    fail(`invalid regular expression: ${pattern}`)
    throw e
  }
}

function parseCidr(block: string, list: BlockList) {
  const [address, prefix, extra] = block.split('/')
  const family = isIP(address)
  if (!family || extra !== undefined) throw new Error('Failed parsing CIDR')
  const max = family === 4 ? 32 : 128
  const bits = prefix === undefined ? max : /^\d+$/.test(prefix) ? Number(prefix) : NaN
  if (!(bits >= 0 && bits <= max)) throw new Error('Failed parsing CIDR')
  list.addSubnet(address, bits, family === 4 ? 'ipv4' : 'ipv6')
}

const fullUrl = (url: URL) => {
  const copy = new URL(url.href)
  try {
    copy.username = ''
    copy.password = ''
  } catch {}
  copy.hash = ''
  return copy.href
}

const originAndPath = (url: URL) =>
  url.host ? `${url.protocol}//${url.host}${url.pathname}` : `${url.protocol}${url.pathname}`

/**
 * Compiles a chrome.events.UrlFilter, as declarativeContent's pageUrl and
 * webNavigation's filters use it, into a test. Every given criterion has to
 * hold. Throws with Chrome's message when the filter is not valid. Regular
 * expressions spend from `budget`, which should be one per extension.
 */
export function compileUrlFilter(filter: unknown, budget: RegexBudget = newRegexBudget()): (url: URL) => boolean {
  if (!isObject(filter)) throw new InvalidInvocation()
  const tests: Array<(url: URL) => boolean> = []
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue
    if ((STRING_CRITERIA as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || value.length > MAX_STRING) {
        throw new Error(`UrlFilter attribute '${key}' expected a string value.`)
      }
      if (HOST_CRITERIA.has(key) && value !== value.toLowerCase()) {
        throw new Error('Host values need to be in lower case.')
      }
    } else if (!LIST_CRITERIA.has(key)) {
      throw new Error(`Unknown attribute '${key}' in UrlFilter.`)
    }
    // Chrome compares host criteria with a dot before the host, so that
    // hostContains: '.foo' finds a part of the name that starts with foo.
    const host = (url: URL) => `.${url.hostname}`
    const withDot = (v: string) => (v.startsWith('.') ? v : `.${v}`)
    const query = (url: URL) => url.search.replace(/^\?/, '')
    switch (key) {
      case 'hostContains': tests.push((u) => host(u).includes(value)); break
      case 'hostEquals': tests.push((u) => host(u) === withDot(value)); break
      case 'hostPrefix': tests.push((u) => host(u).startsWith(withDot(value))); break
      case 'hostSuffix': tests.push((u) => host(u).endsWith(value)); break
      case 'pathContains': tests.push((u) => u.pathname.includes(value)); break
      case 'pathEquals': tests.push((u) => u.pathname === value); break
      case 'pathPrefix': tests.push((u) => u.pathname.startsWith(value)); break
      case 'pathSuffix': tests.push((u) => u.pathname.endsWith(value)); break
      case 'queryContains': tests.push((u) => query(u).includes(value)); break
      case 'queryEquals': tests.push((u) => query(u) === value); break
      case 'queryPrefix': tests.push((u) => query(u).startsWith(value)); break
      case 'querySuffix': tests.push((u) => query(u).endsWith(value)); break
      case 'urlContains': tests.push((u) => fullUrl(u).includes(value)); break
      case 'urlEquals': tests.push((u) => fullUrl(u) === value); break
      case 'urlPrefix': tests.push((u) => fullUrl(u).startsWith(value)); break
      case 'urlSuffix': tests.push((u) => fullUrl(u).endsWith(value)); break
      case 'urlMatches': {
        const re = compileRegExp(value, budget)
        tests.push((u) => re.test(fullUrl(u)))
        break
      }
      case 'originAndPathMatches': {
        const re = compileRegExp(value, budget)
        tests.push((u) => re.test(originAndPath(u)))
        break
      }
      case 'schemes': {
        if (!isStringList(value)) {
          throw new Error(`UrlFilter attribute '${key}' expected a vector of strings as parameter.`)
        }
        if (value.some((s) => s !== s.toLowerCase())) throw new Error('Scheme values need to be in lower case.')
        const schemes = new Set(value)
        tests.push((u) => schemes.has(u.protocol.replace(/:$/, '')))
        break
      }
      case 'ports': {
        const ranges: Array<[number, number]> = []
        if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('Invalid port ranges in UrlFilter.')
        for (const item of value) {
          if (Number.isInteger(item)) ranges.push([item, item])
          else if (Array.isArray(item) && item.length === 2 && item.every(Number.isInteger)) ranges.push([item[0], item[1]])
          else throw new Error('Invalid port ranges in UrlFilter.')
        }
        tests.push((u) => {
          const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol] ?? -1
          return ranges.some(([from, to]) => port >= from && port <= to)
        })
        break
      }
      case 'cidrBlocks': {
        if (!isStringList(value)) {
          throw new Error(`UrlFilter attribute '${key}' expected a vector of strings as parameter.`)
        }
        const list = new BlockList()
        for (const block of value) parseCidr(block, list)
        tests.push((u) => {
          const address = u.hostname.replace(/^\[|\]$/g, '')
          const family = isIP(address)
          return !!family && list.check(address, family === 4 ? 'ipv4' : 'ipv6')
        })
        break
      }
    }
  }
  return (url) => tests.every((test) => test(url))
}

// ---------------------------------------------------------------- rules

export interface StoredRule {
  id: string
  priority: number
  tags?: string[]
  conditions: any[]
  actions: any[]
}

interface CompiledCondition {
  url?: (url: URL) => boolean
  css: string[]
  isBookmarked?: boolean
}

type CompiledAction =
  | { type: 'show' }
  | { type: 'icon'; icon: Record<string, string> }
  | { type: 'script'; js: string[]; css: string[] }

interface CompiledRule {
  rule: StoredRule
  conditions: CompiledCondition[]
  actions: CompiledAction[]
}

const hasAction = (extension: Electron.Extension) => {
  const manifest = extension.manifest as chrome.runtime.Manifest & Record<string, any>
  return !!(manifest.action || manifest.browser_action || manifest.page_action)
}

/** The rule the way it is stored and given back, or InvalidInvocation for what Chrome's bindings refuse. */
function normalizeRule(raw: unknown): Omit<StoredRule, 'id' | 'priority'> & { id?: string; priority?: number } {
  if (!isObject(raw)) throw new InvalidInvocation()
  for (const key of Object.keys(raw)) {
    if (!['id', 'tags', 'conditions', 'actions', 'priority'].includes(key)) throw new InvalidInvocation()
  }
  const { id, tags, conditions, actions, priority } = raw
  if (id !== undefined && (typeof id !== 'string' || id.length > MAX_STRING)) throw new InvalidInvocation()
  if (priority !== undefined && !Number.isInteger(priority)) throw new InvalidInvocation()
  if (tags !== undefined && !isStringList(tags)) throw new InvalidInvocation()
  if (!Array.isArray(conditions) || conditions.length > MAX_ITEMS) throw new InvalidInvocation()
  if (!Array.isArray(actions) || actions.length > MAX_ITEMS) throw new InvalidInvocation()
  const rule: any = {
    conditions: conditions.map(normalizeCondition),
    actions: actions.map(normalizeAction),
  }
  if (id !== undefined) rule.id = id
  if (priority !== undefined) rule.priority = priority
  if (tags !== undefined) rule.tags = [...tags]
  return rule
}

function normalizeCondition(raw: unknown) {
  if (!isObject(raw) || raw.instanceType !== PAGE_STATE_MATCHER) throw new InvalidInvocation()
  const out: Record<string, any> = { instanceType: PAGE_STATE_MATCHER }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'instanceType' || value === undefined) continue
    if (key === 'pageUrl') {
      if (!isObject(value)) throw new InvalidInvocation()
      out.pageUrl = JSON.parse(JSON.stringify(value))
    } else if (key === 'css') {
      if (!isStringList(value)) throw new InvalidInvocation()
      out.css = [...value]
    } else if (key === 'isBookmarked') {
      if (typeof value !== 'boolean') throw new InvalidInvocation()
      out.isBookmarked = value
    } else {
      throw new InvalidInvocation()
    }
  }
  return out
}

function normalizeAction(raw: unknown) {
  if (!isObject(raw)) throw new InvalidInvocation()
  const type = raw.instanceType
  const allowed: Record<string, string[]> = {
    [SHOW_ACTION]: [],
    [SHOW_PAGE_ACTION]: [],
    [SET_ICON]: ['imageData'],
    [REQUEST_CONTENT_SCRIPT]: ['css', 'js', 'allFrames', 'matchAboutBlank'],
  }
  if (typeof type !== 'string' || !allowed[type]) throw new InvalidInvocation()
  // Chrome's ShowPageAction is ShowAction under another name.
  const out: Record<string, any> = { instanceType: type === SHOW_PAGE_ACTION ? SHOW_ACTION : type }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'instanceType' || value === undefined) continue
    if (!allowed[type].includes(key)) throw new InvalidInvocation()
    if (key === 'imageData') {
      if (!isObject(value) || Object.keys(value).length > 10) throw new InvalidInvocation()
      for (const v of Object.values(value)) {
        if (typeof v !== 'string' || v.length > (MAX_ICON_BYTES * 4) / 3 + 4) throw new InvalidInvocation()
      }
      out.imageData = { ...value }
    } else if (key === 'css' || key === 'js') {
      if (!isStringList(value)) throw new InvalidInvocation()
      out[key] = [...value]
    } else {
      if (typeof value !== 'boolean') throw new InvalidInvocation()
      out[key] = value
    }
  }
  return out
}

/**
 * An icon as the renderer sends it: base64 of its width and height (32 bits
 * each, little-endian) and then its RGBA pixels, as ImageData has them.
 */
export function decodeIcon(base64: string): Electron.NativeImage | undefined {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 8) return undefined
  const width = bytes.readUInt32LE(0)
  const height = bytes.readUInt32LE(4)
  if (!width || !height || width > MAX_ICON_SIZE || height > MAX_ICON_SIZE) return undefined
  if (bytes.length !== 8 + width * height * 4) return undefined
  // nativeImage takes premultiplied BGRA.
  const bitmap = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height * 4; i += 4) {
    const a = bytes[8 + i + 3]
    bitmap[i] = Math.round((bytes[8 + i + 2] * a) / 255)
    bitmap[i + 1] = Math.round((bytes[8 + i + 1] * a) / 255)
    bitmap[i + 2] = Math.round((bytes[8 + i] * a) / 255)
    bitmap[i + 3] = a
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height })
  return image.isEmpty() ? undefined : image
}

function compileRule(
  extension: Electron.Extension,
  rule: StoredRule,
  hasPermission: (p: string) => boolean,
  budget: RegexBudget,
): CompiledRule {
  const conditions = rule.conditions.map((condition): CompiledCondition => {
    const compiled: CompiledCondition = { css: [] }
    if (condition.pageUrl) compiled.url = compileUrlFilter(condition.pageUrl, budget)
    if (condition.css) compiled.css = condition.css
    if (typeof condition.isBookmarked === 'boolean') {
      if (!hasPermission('bookmarks')) throw new Error("Property 'isBookmarked' requires 'bookmarks' permission")
      compiled.isBookmarked = condition.isBookmarked
    }
    return compiled
  })
  const actions = rule.actions.map((action): CompiledAction => {
    switch (action.instanceType) {
      case SHOW_ACTION:
        if (!hasAction(extension)) throw new Error("Can't use declarativeContent.ShowAction without an action")
        return { type: 'show' }
      case SET_ICON: {
        if (!hasAction(extension)) throw new Error("Can't use declarativeContent.SetIcon without a page or browser action")
        const icon: Record<string, string> = {}
        for (const [size, data] of Object.entries(action.imageData || {})) {
          const image = Number.isInteger(Number(size)) ? decodeIcon(String(data)) : undefined
          if (!image) throw new Error('Icon dictionary must be of the form {"19": ImageData1, "38": ImageData2}')
          icon[size] = image.toDataURL()
        }
        if (Object.keys(icon).length === 0) {
          throw new Error('Icon dictionary must be of the form {"19": ImageData1, "38": ImageData2}')
        }
        return { type: 'icon', icon }
      }
      case REQUEST_CONTENT_SCRIPT:
        if (!action.css && !action.js) throw new Error('Missing parameter is required: css or js')
        return { type: 'script', css: action.css || [], js: action.js || [] }
      default:
        throw new InvalidInvocation()
    }
  })
  return { rule, conditions, actions }
}

const sortRules = (rules: StoredRule[]) =>
  [...rules].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const copyRule = (rule: StoredRule): StoredRule => JSON.parse(JSON.stringify(rule))

/**
 * The code that tells which CSS selectors match a visible element in the page.
 * It answers at once when the matches differ from `known`, else when they
 * change (watched with a MutationObserver), or after a while regardless.
 */
const cssWatcherCode = (selectors: string[], known: string[] | null, gen: number) => `(() => {
  const selectors = ${JSON.stringify(selectors)}
  const known = ${JSON.stringify(known)}
  const gen = ${gen}
  const self = (window.__crxDeclarativeContent = window.__crxDeclarativeContent || {})
  self.gen = gen
  const visible = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0)
  const compute = () => selectors.filter((s) => {
    try {
      for (const el of document.querySelectorAll(s)) if (visible(el)) return true
    } catch {}
    return false
  })
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])
  return new Promise((resolve) => {
    const now = compute()
    if (!same(now, known)) return resolve(now)
    let timer = 0
    const finish = (value) => {
      observer.disconnect()
      clearTimeout(timer)
      clearTimeout(limit)
      resolve(value)
    }
    const observer = new MutationObserver(() => {
      if (self.gen !== gen) return finish(null)
      if (timer) return
      timer = setTimeout(() => {
        timer = 0
        if (self.gen !== gen) return finish(null)
        const next = compute()
        if (!same(next, known)) finish(next)
      }, 150)
    })
    const limit = setTimeout(() => finish(self.gen === gen ? compute() : null), ${CSS_WATCH_MAX_WAIT_MS})
    observer.observe(document, { subtree: true, childList: true, attributes: true })
  })
})()`

interface TabState {
  url?: URL
  /** Bumped for each new document in the tab. */
  doc: number
  ready: boolean
  css: Set<string>
  watcherGen: number
  watching?: string
  /** `${extensionId} ${ruleId}`: scripts already injected into this document. */
  injected: Set<string>
  /** Extensions whose rules showed or set the action here. */
  touched: Set<string>
}

/**
 * chrome.declarativeContent: rules on onPageChanged that show the action or
 * set its icon on pages that match, and inject content scripts into them.
 * Rules are kept per session across restarts, as Chrome keeps them.
 */
export class DeclarativeContentAPI {
  private rules = new Map<string, StoredRule[]>()
  private compiled = new Map<string, CompiledRule[]>()
  private nextId = new Map<string, number>()
  /** Kept per extension for the session, so compiling rules again does not refill it. */
  private budgets = new Map<string, RegexBudget>()
  private tabs = new Map<TabContents, TabState>()
  private ready: Promise<void>

  /** Whether a page is bookmarked, for isBookmarked. Without bookmarks known, none is. */
  isBookmarked: (url: string) => boolean = () => false

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('declarativeContent.addRules', this.addRules)
    handle('declarativeContent.getRules', this.getRules)
    handle('declarativeContent.removeRules', this.removeRules)

    this.ready = this.load()

    this.ctx.store.on('tab-added', (tab: TabContents) => this.observeTab(tab))
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const [tab, state] of this.tabs) if (tab.id === tabId) this.forgetTab(tab, state)
    })
    for (const tab of this.ctx.store.tabs) this.observeTab(tab)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.compiled.delete(extension.id)
      void this.ready.then(() => this.evaluateAll())
    })
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      // The rules stay for the next load, as Chrome keeps them; what they did
      // to pages ends with the extension.
      this.compiled.delete(extension.id)
      for (const [tab, state] of this.tabs) {
        this.ctx.store.setDeclarativeAction(extension.id, tab.id, undefined)
        state.touched.delete(extension.id)
      }
    })
  }

  private async load() {
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<Record<string, StoredRule[]>>(STATE_NS, {})
    for (const [extensionId, rules] of Object.entries(saved || {})) {
      if (Array.isArray(rules) && rules.length) this.rules.set(extensionId, rules.slice(0, MAX_RULES))
    }
    this.evaluateAll()
  }

  private persist(extensionId: string) {
    const all = { ...this.ctx.stateStore.getNamespace<Record<string, StoredRule[]>>(STATE_NS, {}) }
    const rules = this.rules.get(extensionId)
    if (rules && rules.length) all[extensionId] = rules
    else delete all[extensionId]
    this.ctx.stateStore.setNamespace(STATE_NS, all)
    void this.ctx.stateStore.flush().catch((error) => {
      console.error('Failed to save declarativeContent rules', error)
    })
  }

  private budget(extensionId: string) {
    let budget = this.budgets.get(extensionId)
    if (!budget) this.budgets.set(extensionId, (budget = newRegexBudget()))
    return budget
  }

  private extension(extensionId: string) {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    return sessionExtensions.getExtension(extensionId) || undefined
  }

  private compiledFor(extensionId: string): CompiledRule[] {
    let compiled = this.compiled.get(extensionId)
    if (compiled) return compiled
    const extension = this.extension(extensionId)
    compiled = []
    if (extension && this.ctx.permissions.has(extension, 'declarativeContent')) {
      const has = (p: string) => this.ctx.permissions.has(extension, p)
      for (const rule of this.rules.get(extensionId) || []) {
        try {
          compiled.push(compileRule(extension, rule, has, this.budget(extensionId)))
        } catch (error) {
          d('rule %s of %s no longer compiles: %o', rule.id, extensionId, error)
        }
      }
    }
    this.compiled.set(extensionId, compiled)
    return compiled
  }

  private addRules = async ({ extension }: ExtensionEvent, rules: unknown) => {
    if (!Array.isArray(rules)) throw new InvalidInvocation()
    const normalized = rules.map(normalizeRule)
    await this.ready
    const current = this.rules.get(extension.id) || []
    if (current.length + normalized.length > MAX_RULES) {
      throw new Error(`An extension may keep at most ${MAX_RULES} rules.`)
    }
    const ids = new Set(current.map((r) => r.id))
    const batch = new Set<string>()
    for (const rule of normalized) {
      if (rule.id === undefined) continue
      if (ids.has(rule.id) || batch.has(rule.id)) throw new Error(`Id ${rule.id} was used multiple times.`)
      batch.add(rule.id)
    }
    const added: StoredRule[] = []
    for (const rule of normalized) {
      let id = rule.id
      if (id === undefined) {
        let n = this.nextId.get(extension.id) ?? 0
        do id = `_${n++}_`
        while (ids.has(id) || batch.has(id))
        this.nextId.set(extension.id, n)
        batch.add(id)
      }
      added.push({ ...rule, id, priority: rule.priority ?? 100 })
    }
    // Check every rule before keeping any, so a bad one leaves none behind.
    const selectorCount = (list: StoredRule[]) =>
      list.reduce((n, r) => n + r.conditions.reduce((m, c) => m + (c.css?.length || 0), 0), 0)
    if (selectorCount(current) + selectorCount(added) > MAX_SELECTORS) {
      throw new Error(`An extension may watch at most ${MAX_SELECTORS} CSS selectors.`)
    }
    if (JSON.stringify([...current, ...added]).length > MAX_RULES_BYTES) {
      throw new Error('The rules are too large to keep.')
    }
    const has = (p: string) => this.ctx.permissions.has(extension, p)
    for (const rule of added) compileRule(extension, rule, has, this.budget(extension.id))

    this.rules.set(extension.id, [...current, ...added])
    this.compiled.delete(extension.id)
    this.persist(extension.id)
    this.evaluateAll()
    return added.map(copyRule)
  }

  private getRules = async ({ extension }: ExtensionEvent, ids?: unknown) => {
    if (ids != null && !isStringList(ids, MAX_RULES)) throw new InvalidInvocation()
    await this.ready
    const rules = this.rules.get(extension.id) || []
    const wanted = Array.isArray(ids) ? new Set(ids) : undefined
    return sortRules(rules.filter((r) => !wanted || wanted.has(r.id))).map(copyRule)
  }

  private removeRules = async ({ extension }: ExtensionEvent, ids?: unknown) => {
    if (ids != null && !isStringList(ids, MAX_RULES)) throw new InvalidInvocation()
    await this.ready
    const rules = this.rules.get(extension.id) || []
    const remove = Array.isArray(ids) ? new Set(ids) : undefined
    const kept = remove ? rules.filter((r) => !remove.has(r.id)) : []
    if (kept.length === rules.length) return
    if (kept.length) this.rules.set(extension.id, kept)
    else this.rules.delete(extension.id)
    this.compiled.delete(extension.id)
    this.persist(extension.id)
    this.evaluateAll()
  }

  // ---------------------------------------------------------------- pages

  private observeTab(tab: TabContents) {
    if (!tab || tab.isDestroyed() || this.tabs.has(tab)) return
    const state: TabState = {
      doc: 0,
      ready: !tab.isLoading(),
      css: new Set(),
      watcherGen: 0,
      injected: new Set(),
      touched: new Set(),
    }
    try {
      const url = tab.getURL()
      if (url) state.url = new URL(url)
    } catch {}
    this.tabs.set(tab, state)

    tab.on('did-navigate', (_event, url) => {
      state.doc++
      state.ready = false
      state.css = new Set()
      state.watcherGen++
      state.watching = undefined
      state.injected = new Set()
      try {
        state.url = new URL(url)
      } catch {
        state.url = undefined
      }
      this.evaluate(tab, state)
    })
    tab.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      try {
        state.url = new URL(url)
      } catch {
        state.url = undefined
      }
      this.evaluate(tab, state)
    })
    const onReady = () => {
      if (state.ready) return
      state.ready = true
      this.evaluate(tab, state)
    }
    tab.on('dom-ready', onReady)
    tab.on('did-finish-load', onReady)
    tab.once('destroyed', () => this.forgetTab(tab, state))
    void this.ready.then(() => this.evaluate(tab, state))
  }

  private forgetTab(tab: TabContents, state: TabState) {
    if (this.tabs.get(tab) !== state) return
    this.tabs.delete(tab)
    state.watcherGen++
    for (const extensionId of state.touched) this.ctx.store.setDeclarativeAction(extensionId, tab.id, undefined)
  }

  private evaluateAll() {
    for (const [tab, state] of this.tabs) this.evaluate(tab, state)
  }

  private conditionMatches(condition: CompiledCondition, state: TabState) {
    if (condition.url && !(state.url && condition.url(state.url))) return false
    if (condition.css.length && !condition.css.every((s) => state.css.has(s))) return false
    if (condition.isBookmarked !== undefined) {
      if (!state.url || condition.isBookmarked !== this.isBookmarked(state.url.href)) return false
    }
    return true
  }

  private evaluate(tab: TabContents, state: TabState) {
    if (tab.isDestroyed() || this.tabs.get(tab) !== state) return
    const selectors = new Set<string>()
    const extensionIds = new Set([...this.rules.keys(), ...state.touched])
    for (const extensionId of extensionIds) {
      const rules = this.compiledFor(extensionId)
      const extension = this.extension(extensionId)
      let show = false
      let icon: { priority: number; icon: Record<string, string> } | undefined
      for (const compiled of rules) {
        for (const condition of compiled.conditions) for (const s of condition.css) selectors.add(s)
        if (!compiled.conditions.some((c) => this.conditionMatches(c, state))) continue
        for (const action of compiled.actions) {
          if (action.type === 'show') show = true
          else if (action.type === 'icon') {
            if (!icon || compiled.rule.priority > icon.priority) icon = { priority: compiled.rule.priority, icon: action.icon }
          } else if (extension && state.ready) {
            const key = `${extensionId} ${compiled.rule.id}`
            if (!state.injected.has(key)) {
              state.injected.add(key)
              void this.inject(tab, state, extension, action).catch((error) => {
                d('injecting for %s failed: %o', extensionId, error)
              })
            }
          }
        }
      }
      if (show || icon) {
        const before = this.ctx.store.getDeclarativeAction(extensionId, tab.id)
        const same = before && before.show === show && before.icon === icon?.icon
        if (!same) this.ctx.store.setDeclarativeAction(extensionId, tab.id, { show, icon: icon?.icon })
        state.touched.add(extensionId)
      } else if (state.touched.has(extensionId)) {
        this.ctx.store.setDeclarativeAction(extensionId, tab.id, undefined)
        state.touched.delete(extensionId)
      }
    }
    this.watchCss(tab, state, [...selectors].sort())
  }

  /**
   * Injects a RequestContentScript's files into the page's main frame, in the
   * world chrome.scripting uses. Frames below it get none: Electron runs
   * isolated-world code only in the main frame, and an extension's script
   * must never run in a page's own world.
   */
  private async inject(
    tab: TabContents,
    state: TabState,
    extension: Electron.Extension,
    action: { js: string[]; css: string[] },
  ) {
    const doc = state.doc
    const url = state.url
    // Only where the extension may run scripts, and never in the browser's
    // own pages or another extension's.
    if (!url || !INJECTABLE_SCHEMES.has(url.protocol)) return
    if (!this.ctx.permissions.hasHostAccess(extension, url.href, { tabId: tab.id, scriptable: true })) return
    const stillThere = () => !tab.isDestroyed() && state.doc === doc && this.tabs.get(tab) === state
    for (const file of action.css) {
      const filePath = await validateExtensionResource(extension, file)
      if (!filePath) continue
      const css = await fs.readFile(filePath, 'utf8')
      if (!stillThere()) return
      await tab.insertCSS(css)
    }
    for (const file of action.js) {
      const filePath = await validateExtensionResource(extension, file)
      if (!filePath) continue
      const code = await fs.readFile(filePath, 'utf8')
      if (!stillThere()) return
      await tab.executeJavaScriptInIsolatedWorld(SCRIPT_WORLD, [{ code, url: new URL(file, extension.url).href }], false)
    }
  }

  /** Keeps state.css up to date with the selectors that match in the page. */
  private watchCss(tab: TabContents, state: TabState, selectors: string[]) {
    // Web pages only: no code of ours runs in the browser's own pages or in
    // other extensions' pages, as Chrome watches none there.
    if (!state.url || !INJECTABLE_SCHEMES.has(state.url.protocol)) selectors = []
    const key = selectors.join('\n')
    if (!state.ready || state.watching === key) return
    state.watching = key
    const gen = ++state.watcherGen
    if (selectors.length === 0) {
      state.css = new Set()
      return
    }
    void (async () => {
      let known: string[] | null = null
      while (!tab.isDestroyed() && state.watcherGen === gen) {
        let matched: unknown
        try {
          matched = await tab.executeJavaScriptInIsolatedWorld(
            CSS_WATCH_WORLD,
            [{ code: cssWatcherCode(selectors, known, gen) }],
            false,
          )
        } catch (error) {
          d('css watcher stopped: %o', error)
          return
        }
        if (tab.isDestroyed() || state.watcherGen !== gen || !Array.isArray(matched)) return
        const allowed = new Set(selectors)
        known = matched.filter((s): s is string => typeof s === 'string' && allowed.has(s))
        const changed = known.length !== state.css.size || known.some((s) => !state.css.has(s))
        state.css = new Set(known)
        if (changed) this.evaluate(tab, state)
      }
    })()
  }
}
