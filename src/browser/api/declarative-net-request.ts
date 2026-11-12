import { app } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'

import { getDomain } from 'tldts'

import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesAnyPattern } from '../match-pattern'
import { resolveExtensionPath } from './common'
import { execGuarded, mayBacktrackBadly, testEachGuarded } from './lib/guarded-regexp'
import {
  chromeUrlFilterHostKeyForIndex,
  matchDeclarativeNetRequestUrlFilter,
} from './chrome-dnr-url-filter'
import type { WebRequestBlockingResponse, WebRequestDetails } from './web-request'

type DNRRule = chrome.declarativeNetRequest.Rule
type RuleCondition = chrome.declarativeNetRequest.RuleCondition

interface InternalRule {
  extensionId: string
  id: number
  priority: number
  action: chrome.declarativeNetRequest.RuleAction
  hostKey: string | null
  /** Raw Chrome `urlFilter` string (MV3 semantics — not ABP). */
  urlFilter: string | null
  isUrlFilterCaseSensitive: boolean
  regex: RegExp | null
  /**
   * The pattern could backtrack for long (lib/guarded-regexp.ts): it is
   * tested under a time limit, together with the request's other such rules.
   */
  riskyRegex?: boolean
  /** Its pattern took too long once: the rule matches nothing any more. */
  regexHung?: boolean
  condition: RuleCondition
  /** Static ruleset this rule was loaded from, or '_dynamic' / '_session'. */
  rulesetId?: string
}

const originOf = (url: string | undefined) => {
  if (!url) return undefined
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

function getSessionExtensions(session: Electron.Session) {
  return session.extensions || session
}

/** Match resourceTypes / excludedResourceTypes; omit both ⇒ all except main_frame. */
function dnrResourceTypeMatches(
  condition: RuleCondition,
  normalizedType: string | undefined,
): boolean {
  const t = normalizedType || 'other'
  const mapped = t === 'img' ? 'image' : t

  const included = condition.resourceTypes
  if (included?.length) return included.some((ct) => ct === mapped)

  const excluded = (condition as RuleCondition & {
    excludedResourceTypes?: chrome.declarativeNetRequest.ResourceType[]
  }).excludedResourceTypes
  if (excluded?.length) return !excluded.some((ct) => ct === mapped)

  return mapped !== 'main_frame'
}

type UrlTransform = {
  scheme?: string
  host?: string
  port?: string
  path?: string
  query?: string
  queryTransform?: {
    addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[]
    removeParams?: string[]
  }
  fragment?: string
  username?: string
  password?: string
}

/** Apply queryTransform without re-encoding untouched pairs. */
function applyQueryTransform(
  search: string,
  queryTransform: NonNullable<UrlTransform['queryTransform']>,
): string {
  const raw = search.startsWith('?') ? search.slice(1) : search
  let pairs = raw.length > 0 ? raw.split('&') : []
  const keyOf = (pair: string) => {
    const eq = pair.indexOf('=')
    return eq === -1 ? pair : pair.slice(0, eq)
  }

  const removeParams = queryTransform.removeParams
  if (removeParams?.length) {
    const drop = new Set(removeParams)
    pairs = pairs.filter((pair) => !drop.has(keyOf(pair)))
  }

  for (const param of queryTransform.addOrReplaceParams ?? []) {
    if (!param?.key) continue
    const next = `${param.key}=${param.value ?? ''}`
    const at = pairs.findIndex((pair) => keyOf(pair) === param.key)
    if (at !== -1) {
      pairs[at] = next
      pairs = pairs.filter((pair, i) => i === at || keyOf(pair) !== param.key)
    } else if (!param.replaceOnly) {
      pairs.push(next)
    }
  }

  return pairs.length > 0 ? `?${pairs.join('&')}` : ''
}

/** Apply redirect.transform. Returns null if nothing changed. */
function applyUrlTransform(requestUrl: string, transform: UrlTransform): string | null {
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    return null
  }

  if (transform.scheme) u.protocol = `${transform.scheme}:`
  if (transform.username != null) u.username = transform.username
  if (transform.password != null) u.password = transform.password
  if (transform.host) u.hostname = transform.host
  if (transform.port != null) u.port = transform.port
  if (transform.path != null) u.pathname = transform.path

  if (transform.query != null) {
    u.search = transform.query
  } else if (transform.queryTransform) {
    u.search = applyQueryTransform(u.search, transform.queryTransform)
  }

  if (transform.fragment != null) u.hash = transform.fragment

  const next = u.href
  return next === requestUrl ? null : next
}

function hostMatchesDomainList(
  host: string,
  domains: string[] | undefined,
  excluded: string[] | undefined,
): boolean {
  const h = host.toLowerCase()
  if (excluded?.length) {
    for (const d of excluded) {
      const x = d.toLowerCase()
      if (h === x || h.endsWith(`.${x}`)) return false
    }
  }
  if (!domains || domains.length === 0) return true
  return domains.some((d) => {
    const x = d.toLowerCase()
    return h === x || h.endsWith(`.${x}`)
  })
}

function safeHostname(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Same registrable domain (eTLD+1 / schemeful site) using the bundled public suffix list.
 * Matches browser behavior for sibling subdomains (e.g. static.* vs www.* on grammarly.com).
 */
function sameRegistrableDomain(hostnameA: string, hostnameB: string): boolean {
  if (!hostnameA || !hostnameB) return false
  if (hostnameA === hostnameB) return true
  const da = getDomain(hostnameA)
  const db = getDomain(hostnameB)
  return da != null && db != null && da === db
}

/** Chrome `RuleCondition.domainType`: first vs third party by registrable domain of URL vs initiator. */
function domainTypeMatches(
  domainType: string | undefined,
  requestUrl: string,
  initiatorUrl: string | undefined,
): boolean {
  if (domainType == null) return true
  const rh = safeHostname(requestUrl)
  const ih = initiatorUrl ? safeHostname(initiatorUrl) : ''
  if (!rh) return false
  // A request with no initiator (one the person started) is first party.
  const sameSite = !ih || sameRegistrableDomain(rh, ih)
  if (domainType === 'thirdParty') return !sameSite
  if (domainType === 'firstParty') return sameSite
  return true
}

function extensionIdFromInitiatorUrl(initiatorUrl: string | undefined): string | undefined {
  if (!initiatorUrl || !initiatorUrl.startsWith('chrome-extension://')) return undefined
  try {
    return new URL(initiatorUrl).hostname || undefined
  } catch {
    return undefined
  }
}

/** Skip block/redirect when the rule belongs to another extension than the initiator. */
function shouldSkipCrossExtensionDeclarativeAction(
  initiatorUrl: string | undefined,
  ruleExtensionId: string,
): boolean {
  const fromExt = extensionIdFromInitiatorUrl(initiatorUrl)
  if (!fromExt) return false
  return fromExt !== ruleExtensionId
}

function normalizeResourceTypeForDnr(type: string | undefined): string {
  const t = type || 'other'
  if (t === 'img') return 'image'
  if (t === 'fetch') return 'xmlhttprequest'
  return t
}

function conditionMatchesRequest(
  condition: RuleCondition,
  details: {
    url: string
    method: string
    tabId: number
    type: string
    initiator?: string
  },
  urlFilter: string | null,
  isUrlFilterCaseSensitive: boolean,
  regex: Pick<RegExp, 'test'> | null,
): boolean {
  if (!dnrResourceTypeMatches(condition, details.type)) return false

  if (condition.requestMethods?.length) {
    const m = (details.method || 'GET').toLowerCase()
    if (!condition.requestMethods.some((rm) => String(rm).toLowerCase() === m)) return false
  }

  const exMethods = (condition as any).excludedRequestMethods as string[] | undefined
  if (exMethods?.length) {
    const m = (details.method || 'GET').toLowerCase()
    if (exMethods.some((rm) => String(rm).toLowerCase() === m)) return false
  }

  if (condition.tabIds?.length) {
    if (!condition.tabIds.includes(details.tabId)) return false
  }
  const exTabs = (condition as any).excludedTabIds as number[] | undefined
  if (exTabs?.length && exTabs.includes(details.tabId)) return false

  const condDomainType = (condition as RuleCondition & { domainType?: string }).domainType
  if (!domainTypeMatches(condDomainType, details.url, details.initiator)) return false

  const reqHost = safeHostname(details.url)

  const reqDomains = (condition as RuleCondition & { requestDomains?: string[] }).requestDomains
  const exReqDomains = (condition as RuleCondition & { excludedRequestDomains?: string[] })
    .excludedRequestDomains
  if (reqDomains?.length || exReqDomains?.length) {
    if (!hostMatchesDomainList(reqHost, reqDomains, exReqDomains)) return false
  }

  const legacyDomain = (condition as RuleCondition & { domain?: string }).domain
  const legacyEx = (condition as RuleCondition & { excludedDomains?: string[] }).excludedDomains
  if (legacyDomain || legacyEx?.length) {
    const doms = legacyDomain ? [legacyDomain] : undefined
    if (!hostMatchesDomainList(reqHost, doms, legacyEx)) return false
  }

  const initDomains = (condition as RuleCondition & { initiatorDomains?: string[] }).initiatorDomains
  const exInitDomains = (condition as RuleCondition & { excludedInitiatorDomains?: string[] })
    .excludedInitiatorDomains
  if (initDomains?.length || exInitDomains?.length) {
    const ih = details.initiator ? safeHostname(details.initiator) : ''
    if (!ih || !hostMatchesDomainList(ih, initDomains, exInitDomains)) return false
  }

  if (regex) {
    if (!regex.test(details.url)) return false
  } else if (urlFilter) {
    if (
      !matchDeclarativeNetRequestUrlFilter(
        urlFilter,
        details.url,
        isUrlFilterCaseSensitive,
      )
    ) {
      return false
    }
  }

  return true
}

function collectHostSuffixes(hostname: string): string[] {
  const out: string[] = []
  let rest = hostname.toLowerCase()
  while (rest) {
    out.push(rest)
    const i = rest.indexOf('.')
    if (i === -1) break
    rest = rest.slice(i + 1)
  }
  return out
}

// ------------------------------------------------------------ rule checks

const RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
])
const ACTION_TYPES = new Set(['block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests'])
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other'])
const HEADER_OPERATIONS = new Set(['append', 'set', 'remove'])
const TRANSFORM_SCHEMES = new Set(['http', 'https', 'ftp', 'chrome-extension'])

const GUARANTEED_MINIMUM_STATIC_RULES = 30000
const MAX_NUMBER_OF_DYNAMIC_RULES = 30000
const MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 5000
const MAX_NUMBER_OF_SESSION_RULES = 5000
const MAX_NUMBER_OF_UNSAFE_SESSION_RULES = 5000
const MAX_NUMBER_OF_REGEX_RULES = 1000
const MAX_NUMBER_OF_ENABLED_STATIC_RULESETS = 50
const MAX_REGEX_LENGTH = 2000
const MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL = 20
const GETMATCHEDRULES_QUOTA_INTERVAL_MS = 10 * 60 * 1000
/** Chrome keeps matched rules for five minutes. */
const MATCHED_RULE_TTL_MS = 5 * 60 * 1000
const MAX_MATCHED_RULES = 1000

const DYNAMIC_RULESET_ID = '_dynamic'
const SESSION_RULESET_ID = '_session'
const DNR_STATE_NS = 'declarativeNetRequest'

/** Chrome's message for a rule, with its id in place of the first '*'. */
const ruleError = (id: unknown, message: string) => new Error(`Rule with id ${id} ${message}`)

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s)

/** Chrome's RE2 subset: no lookaround and no backreferences. */
function regexSupport(regex: string): { isSupported: boolean; reason?: 'syntaxError' | 'memoryLimitExceeded' } {
  if (typeof regex !== 'string') return { isSupported: false, reason: 'syntaxError' }
  if (regex.length > MAX_REGEX_LENGTH) return { isSupported: false, reason: 'memoryLimitExceeded' }
  if (/\(\?<?[=!]|\\[1-9]|\\k<|\(\?P?<[a-zA-Z]/.test(regex)) return { isSupported: false, reason: 'syntaxError' }
  try {
    new RegExp(regex)
    return { isSupported: true }
  } catch {
    return { isSupported: false, reason: 'syntaxError' }
  }
}

function checkList(id: unknown, condition: any, key: string, valid?: (v: any) => boolean) {
  const value = condition[key]
  if (value === undefined) return
  if (!Array.isArray(value)) throw ruleError(id, `has an invalid value for ${key} key.`)
  if (value.length === 0) throw ruleError(id, `cannot have an empty list as the value for ${key} key.`)
  if (valid && !value.every(valid)) throw ruleError(id, `has an invalid value for ${key} key.`)
}

/** Validates a rule as Chrome does, throwing Chrome's message. */
function validateRule(rule: any): DNRRule {
  if (!rule || typeof rule !== 'object') throw new Error('Invalid rule.')
  const id = rule.id
  if (!Number.isInteger(id) || id < 1) {
    throw ruleError(id, 'has an invalid value for id key. This should be greater than or equal to 1.')
  }
  if (rule.priority !== undefined && (!Number.isInteger(rule.priority) || rule.priority < 1)) {
    throw ruleError(id, 'has an invalid value for priority key. This should be greater than or equal to 1.')
  }
  const action = rule.action
  if (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type)) {
    throw ruleError(id, 'specifies an incorrect value for the "action.type" key.')
  }
  const condition = rule.condition
  if (!condition || typeof condition !== 'object') throw ruleError(id, 'does not specify the value for condition key.')

  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) {
    throw ruleError(id, 'can only specify one of "urlFilter" or "regexFilter" keys.')
  }
  if (condition.urlFilter !== undefined) {
    if (typeof condition.urlFilter !== 'string') throw ruleError(id, 'has an invalid value for urlFilter key.')
    if (condition.urlFilter === '') throw ruleError(id, 'cannot have an empty value for urlFilter key.')
    if (!isAscii(condition.urlFilter)) throw ruleError(id, 'cannot have non-ascii characters as part of "urlFilter" key.')
  }
  if (condition.regexFilter !== undefined) {
    if (typeof condition.regexFilter !== 'string' || condition.regexFilter === '') {
      throw ruleError(id, 'cannot have an empty value for regexFilter key.')
    }
    if (!isAscii(condition.regexFilter)) throw ruleError(id, 'cannot have non-ascii characters as part of "regexFilter" key.')
    const support = regexSupport(condition.regexFilter)
    if (!support.isSupported) {
      throw support.reason === 'memoryLimitExceeded'
        ? ruleError(id, 'specified a more complex regex than allowed as part of the "regexFilter" key.')
        : ruleError(id, 'specifies an incorrect value for the "regexFilter" key.')
    }
  }
  const domain = (v: any) => typeof v === 'string' && v.length > 0 && isAscii(v) && v === v.toLowerCase()
  for (const key of ['domains', 'excludedDomains', 'initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains', 'topDomains', 'excludedTopDomains']) {
    checkList(id, condition, key, domain)
  }
  checkList(id, condition, 'resourceTypes', (t) => RESOURCE_TYPES.has(t))
  if (condition.excludedResourceTypes !== undefined) {
    if (!Array.isArray(condition.excludedResourceTypes) || !condition.excludedResourceTypes.every((t: any) => RESOURCE_TYPES.has(t))) {
      throw ruleError(id, 'has an invalid value for excludedResourceTypes key.')
    }
  }
  if (condition.resourceTypes && condition.excludedResourceTypes?.some((t: string) => condition.resourceTypes.includes(t))) {
    throw ruleError(id, 'includes and excludes the same resource.')
  }
  checkList(id, condition, 'requestMethods', (m) => METHODS.has(m))
  if (condition.excludedRequestMethods !== undefined && !Array.isArray(condition.excludedRequestMethods)) {
    throw ruleError(id, 'has an invalid value for excludedRequestMethods key.')
  }
  checkList(id, condition, 'tabIds', (t) => Number.isInteger(t))
  if (condition.domainType !== undefined && condition.domainType !== 'firstParty' && condition.domainType !== 'thirdParty') {
    throw ruleError(id, 'has an invalid value for domainType key.')
  }

  switch (action.type) {
    case 'redirect': {
      const r = action.redirect
      if (!r || typeof r !== 'object' || (r.url === undefined && r.extensionPath === undefined && r.transform === undefined && r.regexSubstitution === undefined)) {
        throw ruleError(id, 'does not specify the value for "action.redirect" key. This is required for redirect rules.')
      }
      if (r.url !== undefined) {
        let parsed: URL | undefined
        try {
          parsed = new URL(r.url)
        } catch {}
        if (!parsed) throw ruleError(id, 'does not provide a valid URL for "action.redirect.url" key.')
        if (parsed.protocol === 'javascript:') {
          throw ruleError(id, 'specifies an incorrect value for the "action.redirect.url" key. Redirects to javascript urls are not supported.')
        }
      }
      if (r.extensionPath !== undefined && (typeof r.extensionPath !== 'string' || !r.extensionPath.startsWith('/'))) {
        throw ruleError(id, 'has an invalid value for "action.redirect.extensionPath" key. This should start with "/".')
      }
      if (r.regexSubstitution !== undefined && condition.regexFilter === undefined) {
        throw ruleError(id, 'can\'t specify the "action.redirect.regexSubstitution" key without specifying the "condition.regexFilter" key.')
      }
      const t = r.transform
      if (t !== undefined) {
        if (t.scheme !== undefined && !TRANSFORM_SCHEMES.has(t.scheme)) {
          throw ruleError(id, `specifies an invalid value for the "action.redirect.transform.scheme" key. It must be one of: ${[...TRANSFORM_SCHEMES].join(', ')}.`)
        }
        if (t.query !== undefined && t.queryTransform !== undefined) {
          throw ruleError(id, 'cannot specify both "action.redirect.transform.query" and "action.redirect.transform.queryTransform" keys.')
        }
      }
      break
    }
    case 'modifyHeaders': {
      const lists = [action.requestHeaders, action.responseHeaders].filter((l) => l !== undefined)
      if (lists.length === 0) {
        throw ruleError(id, 'does not specify the value for "action.requestHeaders" or "action.responseHeaders" key. This is required for "modifyHeaders" rules.')
      }
      for (const list of lists) {
        if (!Array.isArray(list) || list.length === 0) {
          throw ruleError(id, 'cannot have an empty list as the value for "action.requestHeaders" key.')
        }
        for (const h of list) {
          if (!h || typeof h.header !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.header)) {
            throw ruleError(id, 'must specify a valid header name to be modified.')
          }
          if (!HEADER_OPERATIONS.has(h.operation)) throw ruleError(id, 'specifies an invalid header operation.')
          if (h.operation === 'remove' ? h.value !== undefined : typeof h.value !== 'string') {
            throw ruleError(id, h.operation === 'remove'
              ? 'must not provide a header value for a header to be removed.'
              : 'must provide a value for a header to be appended/set.')
          }
        }
      }
      break
    }
    case 'allowAllRequests':
      if (!Array.isArray(condition.resourceTypes) || !condition.resourceTypes.every((t: string) => t === 'main_frame' || t === 'sub_frame')) {
        throw ruleError(id, 'is an "allowAllRequests" rule and must specify the "resourceTypes" key. It may only include the "main_frame" and "sub_frame" resource types.')
      }
      break
  }
  // A plain copy, so nothing the extension passed is kept by reference.
  return JSON.parse(JSON.stringify(rule))
}

function compileRule(extensionId: string, rule: DNRRule, rulesetId?: string): InternalRule | null {
  const c = rule.condition || {}
  let urlFilter: string | null = null
  let regex: RegExp | null = null
  let riskyRegex = false
  let hostKey: string | null = null
  if (typeof c.regexFilter === 'string' && c.regexFilter) {
    try {
      regex = new RegExp(c.regexFilter, (c as any).isUrlFilterCaseSensitive ? '' : 'i')
      // Chrome's RE2 matches in linear time; JavaScript's engine can take
      // minutes on a pattern like (a+)+$, on every request, in the main process.
      riskyRegex = mayBacktrackBadly(c.regexFilter)
    } catch {
      return null
    }
  } else if (typeof c.urlFilter === 'string' && c.urlFilter) {
    urlFilter = c.urlFilter
    hostKey = chromeUrlFilterHostKeyForIndex(c.urlFilter)
  }
  return {
    extensionId,
    id: rule.id,
    priority: rule.priority ?? 1,
    action: rule.action,
    hostKey,
    urlFilter,
    isUrlFilterCaseSensitive: !!(c as { isUrlFilterCaseSensitive?: boolean }).isUrlFilterCaseSensitive,
    regex,
    riskyRegex,
    condition: c,
    rulesetId,
  }
}

/** Chrome's order between rules of one priority: allow first, redirect last. */
const ACTION_RANK: Record<string, number> = {
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0,
}

const betterRule = (a: InternalRule, b: InternalRule | null) =>
  !b ||
  a.priority > b.priority ||
  (a.priority === b.priority && (ACTION_RANK[a.action.type] ?? 0) > (ACTION_RANK[b.action.type] ?? 0))

/** Whether `extensionPath` of the extension may be loaded by `initiator`. */
function isWebAccessible(extension: Electron.Extension, extensionPath: string, initiator: string | undefined) {
  if (initiator === `chrome-extension://${extension.id}`) return true
  const manifest = extension.manifest as any
  const entries = Array.isArray(manifest?.web_accessible_resources) ? manifest.web_accessible_resources : []
  const pathname = extensionPath.replace(/^\/+/, '').split(/[?#]/)[0]
  const globMatch = (glob: string) =>
    new RegExp(`^${glob.replace(/^\/+/, '').split('*').map((p) => p.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')).join('.*')}$`).test(pathname)
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (globMatch(entry)) return true
      continue
    }
    if (!entry || !Array.isArray(entry.resources) || !entry.resources.some((r: unknown) => typeof r === 'string' && globMatch(r))) continue
    const matches: string[] = Array.isArray(entry.matches) ? entry.matches : []
    if (matches.includes('<all_urls>') || matches.includes('*://*/*')) return true
    if (initiator && matchesAnyPattern(matches, initiator + '/')) return true
    if (!initiator && matches.length > 0) return true
  }
  return false
}

interface ExtensionDNRState {
  staticByRuleset: Map<string, InternalRule[]>
  enabledRulesets: Set<string>
  /** Per-ruleset static rule ids disabled via updateStaticRules. */
  disabledStaticRuleIds: Map<string, Set<number>>
  dynamicRules: Map<number, InternalRule>
  sessionRules: Map<number, InternalRule>
  /** The ruleset ids the manifest declares. */
  rulesetIds: string[]
  matched: { rule: { ruleId: number; rulesetId: string }; tabId: number; timeStamp: number }[]
  getMatchedRulesCalls: number[]
  actionOptions: { displayActionCountAsBadgeText?: boolean }
}

interface PersistedState {
  [extensionId: string]: {
    dynamicRules?: DNRRule[]
    enabledRulesets?: string[]
    disabledStaticRuleIds?: Record<string, number[]>
    displayActionCountAsBadgeText?: boolean
  }
}

/**
 * chrome.declarativeNetRequest
 *
 * Rules are matched here, for the requests the host hands to webRequest.
 * Dynamic rules, enabled rulesets and disabled static rules are kept per
 * session, as Chrome keeps them per profile; session rules last as long as
 * the browser runs.
 */
export class DeclarativeNetRequestAPI {
  private byExtension = new Map<string, ExtensionDNRState>()
  private hostIndex = new Map<string, InternalRule[]>()
  private genericRules: InternalRule[] = []
  private ready: Promise<void>
  private loading = new Map<string, Promise<void>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('declarativeNetRequest.getDynamicRules', this.getDynamicRules)
    handle('declarativeNetRequest.updateDynamicRules', this.updateDynamicRules)
    handle('declarativeNetRequest.getSessionRules', this.getSessionRules)
    handle('declarativeNetRequest.updateSessionRules', this.updateSessionRules)
    handle('declarativeNetRequest.getEnabledRulesets', this.getEnabledRulesets)
    handle('declarativeNetRequest.updateEnabledRulesets', this.updateEnabledRulesets)
    handle('declarativeNetRequest.updateStaticRules', this.updateStaticRules)
    handle('declarativeNetRequest.getDisabledRuleIds', this.getDisabledRuleIds)
    handle('declarativeNetRequest.getAvailableStaticRuleCount', this.getAvailableStaticRuleCount)
    handle('declarativeNetRequest.isRegexSupported', this.isRegexSupported)
    handle('declarativeNetRequest.testMatchOutcome', this.testMatchOutcome)
    handle('declarativeNetRequest.setExtensionActionOptions', this.setExtensionActionOptions)
    // Chrome needs declarativeNetRequestFeedback, or activeTab on the tab asked about.
    handle('declarativeNetRequest.getMatchedRules', this.getMatchedRules, {
      permission: ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'],
    })

    this.ready = this.ctx.stateStore ? this.ctx.stateStore.whenHydrated() : Promise.resolve()

    const sessionExtensions = getSessionExtensions(this.ctx.session)
    const getAll = (sessionExtensions as any).getAllExtensions
    if (typeof getAll === 'function') {
      for (const ext of getAll.call(sessionExtensions) || []) void this.loadExtension(ext)
    }
    sessionExtensions.on('extension-loaded', (_event: unknown, extension: Electron.Extension) => {
      void this.loadExtension(extension)
    })
    sessionExtensions.on('extension-unloaded', (_event: unknown, extension: Electron.Extension) => {
      this.byExtension.delete(extension.id)
      this.loading.delete(extension.id)
      this.rebuildGlobalIndexes()
    })
  }

  // ------------------------------------------------------------ state

  private persisted(): PersistedState {
    return { ...(this.ctx.stateStore?.getNamespace<PersistedState>(DNR_STATE_NS, {}) ?? {}) }
  }

  private persist(extensionId: string) {
    if (!this.ctx.stateStore) return
    const state = this.byExtension.get(extensionId)
    const all = this.persisted()
    if (!state) {
      delete all[extensionId]
    } else {
      const disabled: Record<string, number[]> = {}
      for (const [rulesetId, ids] of state.disabledStaticRuleIds) if (ids.size) disabled[rulesetId] = [...ids]
      all[extensionId] = {
        dynamicRules: [...state.dynamicRules.values()].map((r) => this.internalToApiRule(r)),
        enabledRulesets: [...state.enabledRulesets],
        disabledStaticRuleIds: disabled,
        displayActionCountAsBadgeText: state.actionOptions.displayActionCountAsBadgeText,
      }
    }
    this.ctx.stateStore.setNamespace(DNR_STATE_NS, all)
    void this.ctx.stateStore.flush().catch((error) => {
      console.error('Failed to persist declarativeNetRequest rules', error)
    })
  }

  private ensureState(extensionId: string): ExtensionDNRState {
    let s = this.byExtension.get(extensionId)
    if (!s) {
      s = {
        staticByRuleset: new Map(),
        enabledRulesets: new Set(),
        disabledStaticRuleIds: new Map(),
        dynamicRules: new Map(),
        sessionRules: new Map(),
        rulesetIds: [],
        matched: [],
        getMatchedRulesCalls: [],
        actionOptions: {},
      }
      this.byExtension.set(extensionId, s)
    }
    return s
  }

  private loadExtension(extension: Electron.Extension) {
    const existing = this.loading.get(extension.id)
    if (existing) return existing
    const promise = this.doLoadExtension(extension).catch((error) => {
      console.warn(`[declarativeNetRequest] Failed to load rules for ${extension.id}:`, error?.message || error)
    })
    this.loading.set(extension.id, promise)
    return promise
  }

  /** Waits for the extension's rules, for calls that arrive while they load. */
  private async stateFor(extension: Electron.Extension) {
    await this.ready
    const sessionExtensions = getSessionExtensions(this.ctx.session)
    const loaded = typeof sessionExtensions.getExtension === 'function' ? sessionExtensions.getExtension(extension.id) : null
    await this.loadExtension(loaded || extension)
    return this.ensureState(extension.id)
  }

  private async doLoadExtension(extension: Electron.Extension) {
    await this.ready
    const manifest = extension.manifest as chrome.runtime.ManifestV3
    const resources = Array.isArray(manifest?.declarative_net_request?.rule_resources)
      ? manifest.declarative_net_request!.rule_resources
      : []
    const state = this.ensureState(extension.id)
    const saved = this.persisted()[extension.id]
    state.staticByRuleset.clear()
    state.rulesetIds = resources.map((r) => r?.id).filter((id): id is string => typeof id === 'string')

    const legacy = saved?.enabledRulesets ? undefined : await this.legacyEnabledRulesets(extension.id)
    if (saved?.enabledRulesets || legacy) {
      for (const id of saved?.enabledRulesets ?? legacy ?? []) state.enabledRulesets.add(id)
    } else {
      for (const res of resources) if (res?.enabled) state.enabledRulesets.add(res.id)
    }
    for (const [rulesetId, ids] of Object.entries(saved?.disabledStaticRuleIds || {})) {
      if (Array.isArray(ids)) state.disabledStaticRuleIds.set(rulesetId, new Set(ids.filter(Number.isInteger)))
    }
    for (const rule of saved?.dynamicRules || []) {
      const c = compileRule(extension.id, rule, DYNAMIC_RULESET_ID)
      if (c) state.dynamicRules.set(c.id, c)
    }
    state.actionOptions.displayActionCountAsBadgeText = saved?.displayActionCountAsBadgeText
    // Rulesets the manifest no longer has are not enabled.
    for (const id of [...state.enabledRulesets]) {
      if (!resources.some((r) => r?.id === id)) state.enabledRulesets.delete(id)
    }
    if (legacy) this.persist(extension.id)

    for (const res of resources) {
      if (!res || typeof res.path !== 'string') continue
      const fullPath = resolveExtensionPath(extension, res.path)
      if (!fullPath) continue
      try {
        const data = JSON.parse(await fs.readFile(fullPath, 'utf8'))
        const list: DNRRule[] = Array.isArray(data) ? data : data?.rules
        if (!Array.isArray(list)) continue
        const compiled: InternalRule[] = []
        for (const rule of list) {
          // Chrome skips a static rule it cannot use and loads the rest.
          try {
            const c = compileRule(extension.id, validateRule(rule), res.id)
            if (c) compiled.push(c)
          } catch {}
        }
        state.staticByRuleset.set(res.id, compiled)
      } catch (e) {
        console.warn(
          `[declarativeNetRequest] Failed to load ruleset "${res.id}" for ${extension.id}:`,
          e instanceof Error ? e.message : e,
        )
      }
    }
    this.rebuildGlobalIndexes()
  }

  /** Rulesets an earlier version kept enabled in a file of its own, read once. */
  private async legacyEnabledRulesets(extensionId: string): Promise<string[] | undefined> {
    if (!this.ctx.stateStore || !(this.ctx.session as any)?.storagePath) return undefined
    try {
      const file = path.join(app.getPath('userData'), 'DNR Extension Rules', extensionId, 'enabled_rulesets.json')
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 100) : undefined
    } catch {
      return undefined
    }
  }

  private isStaticRuleDisabled(state: ExtensionDNRState, rule: InternalRule): boolean {
    if (!rule.rulesetId) return false
    return state.disabledStaticRuleIds.get(rule.rulesetId)?.has(rule.id) ?? false
  }

  /** Index a rule for host-bucket lookup (urlFilter host, requestDomains, or generic). */
  private addRuleToHostIndex(r: InternalRule) {
    const reqDomains = (r.condition as RuleCondition & { requestDomains?: string[] }).requestDomains
    if (reqDomains?.length && !r.urlFilter && !r.regex) {
      for (const domain of reqDomains) {
        const key = domain.toLowerCase()
        const list = this.hostIndex.get(key) || []
        list.push(r)
        this.hostIndex.set(key, list)
      }
      return
    }
    if (r.hostKey) {
      const list = this.hostIndex.get(r.hostKey) || []
      list.push(r)
      this.hostIndex.set(r.hostKey, list)
      return
    }
    this.genericRules.push(r)
  }

  private activeRules(state: ExtensionDNRState): InternalRule[] {
    const rules: InternalRule[] = []
    for (const rulesetId of state.enabledRulesets) {
      for (const rule of state.staticByRuleset.get(rulesetId) || []) {
        if (!this.isStaticRuleDisabled(state, rule)) rules.push(rule)
      }
    }
    rules.push(...state.dynamicRules.values(), ...state.sessionRules.values())
    return rules
  }

  private rebuildGlobalIndexes() {
    this.hostIndex.clear()
    this.genericRules = []
    for (const state of this.byExtension.values()) {
      for (const r of this.activeRules(state)) this.addRuleToHostIndex(r)
    }
  }

  private candidateRulesForUrl(requestUrl: string): InternalRule[] {
    const host = safeHostname(requestUrl)
    const out = new Set<InternalRule>()
    if (host) {
      for (const suffix of collectHostSuffixes(host)) {
        for (const r of this.hostIndex.get(suffix) || []) out.add(r)
      }
    }
    for (const r of this.genericRules) out.add(r)
    return [...out]
  }

  // ------------------------------------------------------------ matching

  private extensionById(extensionId: string): Electron.Extension | undefined {
    const sessionExtensions = getSessionExtensions(this.ctx.session) as any
    return typeof sessionExtensions.getExtension === 'function' ? sessionExtensions.getExtension(extensionId) : undefined
  }

  /**
   * Whether the rule's extension may act on the request. Blocking and
   * allowing need no host access with declarativeNetRequest; redirecting and
   * changing headers need it for the URL and the page that asked, and with
   * declarativeNetRequestWithHostAccess alone every action needs it.
   */
  private mayAct(rule: InternalRule, details: { url: string; initiator?: string; tabId: number }) {
    const permissions = this.ctx.permissions
    if (!permissions) return true
    const extension = this.extensionById(rule.extensionId)
    if (!extension) return false
    const type = rule.action.type
    const needsHost =
      type === 'redirect' || type === 'modifyHeaders' || !permissions.has(extension, 'declarativeNetRequest')
    if (!needsHost) return true
    const tabId = details.tabId >= 0 ? details.tabId : undefined
    if (!permissions.hasHostAccess(extension, details.url, { tabId })) return false
    if (details.initiator && details.initiator !== 'null') {
      return permissions.hasHostAccess(extension, details.initiator.replace(/\/?$/, '/'), { tabId })
    }
    return true
  }

  /**
   * The rules among `candidates` whose patterns could backtrack for long and
   * match `url`, tested together under one time limit. A rule whose pattern
   * takes too long by itself stops matching, and says so once; every other
   * rule keeps matching, however busy the page is.
   */
  private testRiskyRegexes(candidates: InternalRule[], url: string): Set<InternalRule> {
    const risky = candidates.filter((r) => r.regex && r.riskyRegex && !r.regexHung)
    const matches = new Set<InternalRule>()
    if (risky.length === 0) return matches
    const results = testEachGuarded(
      risky.map((r) => r.regex!),
      url,
      (index) => this.regexHung(risky[index]),
    )
    results.forEach((matched, index) => {
      if (matched) matches.add(risky[index])
    })
    return matches
  }

  private regexHung(rule: InternalRule) {
    if (rule.regexHung) return
    rule.regexHung = true
    console.warn(
      `declarativeNetRequest: rule ${rule.id} of extension ${rule.extensionId} took too long to match; it is no longer used`,
    )
  }

  /** The best rule of each extension for a request: the one Chrome would apply. */
  private matchRequest(
    details: WebRequestDetails,
    opts: { only?: string; includeHeaders?: boolean } = {},
  ): { best: Map<string, InternalRule>; headers: InternalRule[] } {
    const probe = {
      url: details.url,
      method: details.method,
      tabId: details.tabId,
      type: normalizeResourceTypeForDnr(details.type),
      initiator: details.initiator,
    }
    const best = new Map<string, InternalRule>()
    const headers: InternalRule[] = []
    const candidates = this.candidateRulesForUrl(details.url)
    const riskyMatches = this.testRiskyRegexes(candidates, details.url)
    for (const r of candidates) {
      if (opts.only && r.extensionId !== opts.only) continue
      // Chrome never lets one extension's rules touch another's requests.
      if (shouldSkipCrossExtensionDeclarativeAction(details.initiator, r.extensionId)) continue
      const regex = r.regex && (r.riskyRegex ? { test: () => riskyMatches.has(r) } : r.regex)
      if (!conditionMatchesRequest(r.condition, probe, r.urlFilter, r.isUrlFilterCaseSensitive, regex)) continue
      if (!this.mayAct(r, probe)) continue
      if (r.action.type === 'modifyHeaders') {
        if (opts.includeHeaders) headers.push(r)
        continue
      }
      if (betterRule(r, best.get(r.extensionId) ?? null)) best.set(r.extensionId, r)
    }
    // A modifyHeaders rule counts only above the extension's allow rule.
    const filtered = headers.filter((h) => {
      const top = best.get(h.extensionId)
      return !top || (top.action.type !== 'allow' && top.action.type !== 'allowAllRequests') || h.priority > top.priority
    })
    return { best, headers: filtered.sort((a, b) => b.priority - a.priority) }
  }

  private rulesetIdOf(rule: InternalRule) {
    return rule.rulesetId || DYNAMIC_RULESET_ID
  }

  private recordMatch(rule: InternalRule, tabId: number) {
    const state = this.byExtension.get(rule.extensionId)
    if (!state) return
    const now = Date.now()
    state.matched.push({ rule: { ruleId: rule.id, rulesetId: this.rulesetIdOf(rule) }, tabId, timeStamp: now })
    if (state.matched.length > MAX_MATCHED_RULES) state.matched.splice(0, state.matched.length - MAX_MATCHED_RULES)
  }

  evaluateOnBeforeRequest(details: WebRequestDetails): WebRequestBlockingResponse | null {
    const { best } = this.matchRequest(details)
    if (best.size === 0) return null
    let block: InternalRule | undefined
    let redirect: { rule: InternalRule; response: WebRequestBlockingResponse } | undefined
    for (const rule of best.values()) {
      this.recordMatch(rule, details.tabId)
      if (rule.action.type === 'block') block = block ?? rule
      else if (rule.action.type === 'redirect' || rule.action.type === 'upgradeScheme') {
        const response = this.actionToBlockingResponse(rule, details)
        if (response) redirect = { rule, response }
      }
    }
    if (block) {
      // Main-frame blocks: prefer the extension's redirect-protection page when present.
      if (normalizeResourceTypeForDnr(details.type) === 'main_frame' && block.condition.resourceTypes?.some((t) => String(t) === 'main_frame')) {
        const interstitial = this.mainFrameBlockInterstitialUrl(block.extensionId)
        if (interstitial) return { redirectUrl: interstitial }
      }
      return { cancel: true }
    }
    return redirect ? redirect.response : null
  }

  /** Headers DNR rules change for a request, applied over `headers`. */
  modifyHeaders(
    stage: 'request' | 'response',
    details: WebRequestDetails,
    headers: Record<string, string | string[]>,
  ): Record<string, string | string[]> | null {
    const { headers: rules } = this.matchRequest(details, { includeHeaders: true })
    if (rules.length === 0) return null
    const out: Record<string, string | string[]> = { ...headers }
    const find = (name: string) => Object.keys(out).find((k) => k.toLowerCase() === name.toLowerCase())
    // The first (highest priority) rule to touch a header decides it, as in Chrome.
    const decided = new Set<string>()
    let changed = false
    for (const rule of rules) {
      const list = (rule.action as any)[stage === 'request' ? 'requestHeaders' : 'responseHeaders'] as any[] | undefined
      for (const h of list || []) {
        const lower = String(h.header).toLowerCase()
        const key = find(h.header)
        if (h.operation === 'append') {
          if (decided.has(lower) && key === undefined) continue
          const current = key !== undefined ? out[key] : undefined
          const values = current === undefined ? [] : Array.isArray(current) ? current : [current]
          if (key !== undefined) delete out[key]
          out[key ?? h.header] = stage === 'request' ? [...values, h.value].join(', ') : [...values, h.value]
        } else {
          if (decided.has(lower)) continue
          if (key !== undefined) delete out[key]
          if (h.operation === 'set') out[h.header] = stage === 'request' ? h.value : [h.value]
        }
        decided.add(lower)
        changed = true
      }
      this.recordMatch(rule, details.tabId)
    }
    return changed ? out : null
  }

  private mainFrameBlockInterstitialUrl(extensionId: string): string | null {
    try {
      const extension = this.extensionById(extensionId)
      if (!extension?.path) return null
      const abs = path.join(extension.path, 'pages', 'redirect-protection', 'index.html')
      if (!existsSync(abs)) return null
      return `chrome-extension://${extensionId}/pages/redirect-protection/index.html`
    } catch {
      return null
    }
  }

  private actionToBlockingResponse(rule: InternalRule, details: WebRequestDetails): WebRequestBlockingResponse | null {
    const requestUrl = details.url
    const a = rule.action
    switch (a.type) {
      case 'block':
        return { cancel: true }
      case 'upgradeScheme': {
        try {
          const u = new URL(requestUrl)
          if (u.protocol !== 'http:' && u.protocol !== 'ws:') return null
          u.protocol = u.protocol === 'ws:' ? 'wss:' : 'https:'
          return { redirectUrl: u.href }
        } catch {
          return null
        }
      }
      case 'redirect': {
        const red = a.redirect
        if (!red) return null
        if (red.url) return { redirectUrl: red.url }
        if (red.extensionPath) {
          const extension = this.extensionById(rule.extensionId)
          // A page may only be sent to an extension resource it may load.
          if (extension && !isWebAccessible(extension, red.extensionPath, originOf(details.initiator))) {
            return { cancel: true }
          }
          return { redirectUrl: `chrome-extension://${rule.extensionId}${red.extensionPath}` }
        }
        if ((red as any).regexSubstitution && rule.regex) {
          const m = rule.riskyRegex ? execGuarded(rule.regex, requestUrl) : rule.regex.exec(requestUrl)
          if (m === undefined) {
            this.regexHung(rule)
            return null
          }
          if (m) {
            const target = String((red as any).regexSubstitution).replace(/\\(\d)/g, (_s, n) => m[Number(n)] ?? '')
            try {
              return { redirectUrl: new URL(target).href }
            } catch {
              return null
            }
          }
          return null
        }
        if (red.transform) {
          const transformed = applyUrlTransform(requestUrl, red.transform as UrlTransform)
          if (transformed) return { redirectUrl: transformed }
        }
        return null
      }
      default:
        return null
    }
  }

  private internalToApiRule(r: InternalRule): DNRRule {
    return JSON.parse(JSON.stringify({ id: r.id, priority: r.priority, action: r.action, condition: r.condition }))
  }

  // ------------------------------------------------------------ handlers

  private filterRules(rules: InternalRule[], filter?: { ruleIds?: number[] }) {
    const list = rules.map((r) => this.internalToApiRule(r))
    if (!Array.isArray(filter?.ruleIds)) return list
    const set = new Set(filter.ruleIds)
    return list.filter((r) => set.has(r.id))
  }

  private getDynamicRules = async ({ extension }: ExtensionEvent, filter?: { ruleIds?: number[] }) => {
    const state = await this.stateFor(extension)
    return this.filterRules([...state.dynamicRules.values()], filter)
  }

  private getSessionRules = async ({ extension }: ExtensionEvent, filter?: { ruleIds?: number[] }) => {
    const state = await this.stateFor(extension)
    return this.filterRules([...state.sessionRules.values()], filter)
  }

  /** Checks and applies an update to dynamic or session rules, all or nothing. */
  private updateRules(
    extension: Electron.Extension,
    rules: Map<number, InternalRule>,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
    rulesetId: string,
    limits: { total: number; unsafe: number; countError: string; unsafeError: string; regexError: string },
  ) {
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new Error("Error at parameter 'options': Invalid type: expected object.")
    }
    const removeIds = Array.isArray(options?.removeRuleIds) ? options.removeRuleIds : []
    const addRules = Array.isArray(options?.addRules) ? options.addRules : []
    if (addRules.length > limits.total) throw new Error(limits.countError)
    const next = new Map(rules)
    for (const id of removeIds) next.delete(id)
    const added: InternalRule[] = []
    for (const raw of addRules) {
      const rule = validateRule(raw)
      if (next.has(rule.id)) throw ruleError(rule.id, 'does not have a unique ID.')
      const compiled = compileRule(extension.id, rule, rulesetId)
      if (!compiled) throw ruleError(rule.id, 'specifies an incorrect value for the "regexFilter" key.')
      next.set(rule.id, compiled)
      added.push(compiled)
    }
    const values = [...next.values()]
    if (values.length > limits.total) throw new Error(limits.countError)
    const unsafe = values.filter((r) => r.action.type === 'redirect' || r.action.type === 'modifyHeaders').length
    if (unsafe > limits.unsafe) throw new Error(limits.unsafeError)
    if (values.filter((r) => r.regex).length > MAX_NUMBER_OF_REGEX_RULES) throw new Error(limits.regexError)
    rules.clear()
    for (const [id, rule] of next) rules.set(id, rule)
  }

  private updateDynamicRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ) => {
    const state = await this.stateFor(extension)
    this.updateRules(extension, state.dynamicRules, options, DYNAMIC_RULESET_ID, {
      total: MAX_NUMBER_OF_DYNAMIC_RULES,
      unsafe: MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES,
      countError: 'Dynamic rule count exceeded.',
      unsafeError: 'Dynamic rule count for unsafe rules exceeded.',
      regexError: 'Dynamic rule count for regex rules exceeded.',
    })
    this.persist(extension.id)
    this.rebuildGlobalIndexes()
  }

  private updateSessionRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ) => {
    const state = await this.stateFor(extension)
    this.updateRules(extension, state.sessionRules, options, SESSION_RULESET_ID, {
      total: MAX_NUMBER_OF_SESSION_RULES,
      unsafe: MAX_NUMBER_OF_UNSAFE_SESSION_RULES,
      countError: 'Session rule count exceeded.',
      unsafeError: 'Session rule count for unsafe rules exceeded.',
      regexError: 'Session rule count for regex rules exceeded.',
    })
    this.rebuildGlobalIndexes()
  }

  private getEnabledRulesets = async ({ extension }: ExtensionEvent): Promise<string[]> => {
    const state = await this.stateFor(extension)
    return [...state.enabledRulesets]
  }

  private checkRulesetId(extension: Electron.Extension, id: unknown) {
    const state = this.byExtension.get(extension.id)
    if (typeof id !== 'string' || !state?.rulesetIds.includes(id)) {
      throw new Error(`Invalid ruleset id: ${String(id).slice(0, 256)}.`)
    }
  }

  private updateEnabledRulesets = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRulesetOptions,
  ) => {
    const state = await this.stateFor(extension)
    const disable = Array.isArray(options?.disableRulesetIds) ? options.disableRulesetIds : []
    const enable = Array.isArray(options?.enableRulesetIds) ? options.enableRulesetIds : []
    for (const id of [...disable, ...enable]) this.checkRulesetId(extension, id)
    const next = new Set(state.enabledRulesets)
    for (const id of disable) next.delete(id)
    for (const id of enable) next.add(id)
    if (next.size > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
      throw new Error('The number of enabled static rulesets exceeds the enabled ruleset count limit.')
    }
    let count = 0
    for (const id of next) count += state.staticByRuleset.get(id)?.length ?? 0
    if (count > GUARANTEED_MINIMUM_STATIC_RULES) {
      throw new Error('The set of enabled rulesets exceeds the rule count limit.')
    }
    state.enabledRulesets = next
    this.persist(extension.id)
    this.rebuildGlobalIndexes()
  }

  private updateStaticRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateStaticRulesOptions,
  ) => {
    const state = await this.stateFor(extension)
    this.checkRulesetId(extension, options?.rulesetId)
    const rulesetId = options.rulesetId
    const disabled = new Set(state.disabledStaticRuleIds.get(rulesetId) || [])
    for (const id of Array.isArray(options.disableRuleIds) ? options.disableRuleIds : []) {
      if (Number.isInteger(id)) disabled.add(id)
    }
    for (const id of Array.isArray(options.enableRuleIds) ? options.enableRuleIds : []) disabled.delete(id)
    if (disabled.size > 5000) throw new Error('The number of disabled static rules exceeds the disabled rule count limit.')
    if (disabled.size) state.disabledStaticRuleIds.set(rulesetId, disabled)
    else state.disabledStaticRuleIds.delete(rulesetId)
    this.persist(extension.id)
    this.rebuildGlobalIndexes()
  }

  private getDisabledRuleIds = async (
    { extension }: ExtensionEvent,
    options: { rulesetId: string },
  ) => {
    const state = await this.stateFor(extension)
    this.checkRulesetId(extension, options?.rulesetId)
    return [...(state.disabledStaticRuleIds.get(options.rulesetId) || [])].sort((a, b) => a - b)
  }

  private getAvailableStaticRuleCount = async ({ extension }: ExtensionEvent) => {
    const state = await this.stateFor(extension)
    let used = 0
    for (const id of state.enabledRulesets) used += state.staticByRuleset.get(id)?.length ?? 0
    return Math.max(0, GUARANTEED_MINIMUM_STATIC_RULES - used)
  }

  private isRegexSupported = (
    _event: ExtensionEvent,
    regexOptions: chrome.declarativeNetRequest.RegexOptions,
  ): chrome.declarativeNetRequest.IsRegexSupportedResult => {
    if (!regexOptions || typeof regexOptions.regex !== 'string') {
      throw new Error("Error at parameter 'regexOptions': Missing required property 'regex'.")
    }
    return regexSupport(regexOptions.regex) as chrome.declarativeNetRequest.IsRegexSupportedResult
  }

  /** What the extension's own rules would do to a request, without making it. */
  private testMatchOutcome = async ({ extension }: ExtensionEvent, request: any) => {
    await this.stateFor(extension)
    if (!request || typeof request.url !== 'string') throw new Error('Invalid test request URL.')
    try {
      new URL(request.url)
    } catch {
      throw new Error('Invalid test request URL.')
    }
    if (typeof request.type !== 'string' || !RESOURCE_TYPES.has(request.type)) {
      throw new Error("Error at parameter 'request': Error at property 'type': Invalid enumeration value.")
    }
    let initiator: string | undefined
    if (request.initiator !== undefined) {
      initiator = originOf(request.initiator)
      if (!initiator) throw new Error('Invalid test request initiator.')
    }
    if (request.tabId !== undefined && (!Number.isInteger(request.tabId) || request.tabId < -1)) {
      throw new Error('Invalid test tab ID.')
    }
    const method = request.method ?? 'get'
    if (typeof method !== 'string' || !METHODS.has(method.toLowerCase())) throw new Error('Invalid test request method.')
    const details: WebRequestDetails = {
      url: request.url,
      method: method.toUpperCase(),
      tabId: request.tabId ?? -1,
      type: request.type,
      initiator,
    }
    const { best, headers } = this.matchRequest(details, { only: extension.id, includeHeaders: true })
    const top = best.get(extension.id)
    const matched: InternalRule[] = top ? [top] : []
    // A blocked request has no headers left to change.
    if (top?.action.type !== 'block') matched.push(...headers)
    return { matchedRules: matched.map((r) => ({ ruleId: r.id, rulesetId: this.rulesetIdOf(r) })) }
  }

  private getMatchedRules = async (
    event: ExtensionEvent,
    filter?: chrome.declarativeNetRequest.MatchedRulesFilter,
  ): Promise<chrome.declarativeNetRequest.RulesMatchedDetails> => {
    const { extension } = event
    const state = await this.stateFor(extension)
    const tabId = typeof filter?.tabId === 'number' ? filter.tabId : undefined
    const permissions = this.ctx.permissions
    const feedback = permissions ? permissions.has(extension, 'declarativeNetRequestFeedback') : true
    if (!feedback && !(typeof tabId === 'number' && permissions?.hasActiveTab(extension, tabId))) {
      throw new Error(
        'The extension must have the declarativeNetRequestFeedback permission or have activeTab granted for the specified tab ID in order to call this function.',
      )
    }
    // Chrome limits calls made without a user gesture.
    const gesture = event.gesture === true || !!this.ctx.store?.hasUserGesture?.(extension.id)
    if (!gesture) {
      const now = Date.now()
      state.getMatchedRulesCalls = state.getMatchedRulesCalls.filter((t) => now - t < GETMATCHEDRULES_QUOTA_INTERVAL_MS)
      if (state.getMatchedRulesCalls.length >= MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL) {
        throw new Error('This request exceeds the MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL quota.')
      }
      state.getMatchedRulesCalls.push(now)
    }
    const since = Math.max(typeof filter?.minTimeStamp === 'number' ? filter.minTimeStamp : 0, Date.now() - MATCHED_RULE_TTL_MS)
    const rulesMatchedInfo = state.matched
      .filter((m) => m.timeStamp >= since && (tabId === undefined || m.tabId === tabId))
      .map((m) => ({ rule: { ...m.rule }, tabId: m.tabId, timeStamp: m.timeStamp }))
    return { rulesMatchedInfo }
  }

  private setExtensionActionOptions = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.ExtensionActionOptions,
  ) => {
    const state = await this.stateFor(extension)
    if (!options || typeof options !== 'object') {
      throw new Error("Error at parameter 'options': Invalid type: expected object.")
    }
    if (options.tabUpdate !== undefined) {
      const display = options.displayActionCountAsBadgeText ?? state.actionOptions.displayActionCountAsBadgeText
      if (!display) throw new Error('Cannot increment action count unless displaying action count as badge text.')
      if (!Number.isInteger(options.tabUpdate.tabId) || !this.ctx.store?.getTabById?.(options.tabUpdate.tabId)) {
        throw new Error(`No tab with id: ${options.tabUpdate.tabId}.`)
      }
    }
    if (typeof options.displayActionCountAsBadgeText === 'boolean') {
      state.actionOptions.displayActionCountAsBadgeText = options.displayActionCountAsBadgeText
      this.persist(extension.id)
    }
  }
}
