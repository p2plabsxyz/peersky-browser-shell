import { app } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'

import { getDomain } from 'tldts'

import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
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
  condition: RuleCondition
  /** Static ruleset this rule was loaded from (for updateStaticRules). */
  rulesetId?: string
}

interface ExtensionDNRState {
  staticByRuleset: Map<string, InternalRule[]>
  enabledRulesets: Set<string>
  /** Per-ruleset static rule ids disabled via updateStaticRules. */
  disabledStaticRuleIds: Map<string, Set<number>>
  dynamicRules: Map<number, InternalRule>
  sessionRules: Map<number, InternalRule>
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
  if (!rh || !ih) return false
  const sameSite = sameRegistrableDomain(rh, ih)
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
  regex: RegExp | null,
): boolean {
  if (!dnrResourceTypeMatches(condition, details.type)) return false

  if (condition.requestMethods?.length) {
    const m = (details.method || 'GET').toLowerCase()
    if (!condition.requestMethods.some((rm) => String(rm).toLowerCase() === m)) return false
  }

  if (condition.tabIds?.length) {
    if (!condition.tabIds.includes(details.tabId)) return false
  }

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

function compileRule(extensionId: string, rule: DNRRule): InternalRule | null {
  const priority = rule.priority ?? 1
  const c = rule.condition
  let urlFilter: string | null = null
  let isUrlFilterCaseSensitive = false
  let regex: RegExp | null = null
  let hostKey: string | null = null

  if (c.regexFilter) {
    try {
      regex = new RegExp(c.regexFilter)
    } catch {
      return null
    }
  } else if (c.urlFilter) {
    urlFilter = c.urlFilter
    isUrlFilterCaseSensitive = !!(c as { isUrlFilterCaseSensitive?: boolean }).isUrlFilterCaseSensitive
    hostKey = chromeUrlFilterHostKeyForIndex(c.urlFilter)
  }

  return {
    extensionId,
    id: rule.id,
    priority,
    action: rule.action,
    hostKey,
    urlFilter,
    isUrlFilterCaseSensitive,
    regex,
    condition: c,
  }
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

function isRegexSupportedChromeSubset(regex: string): { isSupported: boolean; reason?: string } {
  if (regex.length > 1000) return { isSupported: false, reason: 'Regex too long' }
  const bad = ['\\1', '\\2', '(?<', '(?P<', '(?!', '(?<!', '(?<=', '(?=', '(?#', '\\k<', '\\g{']
  for (const b of bad) {
    if (regex.includes(b)) return { isSupported: false, reason: `Unsupported construct: ${b}` }
  }
  try {
    new RegExp(regex)
    return { isSupported: true }
  } catch (e) {
    return { isSupported: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function dnrPersistDir(): string {
  return path.join(app.getPath('userData'), 'DNR Extension Rules')
}

export class DeclarativeNetRequestAPI {
  private byExtension = new Map<string, ExtensionDNRState>()
  private hostIndex = new Map<string, InternalRule[]>()
  private genericRules: InternalRule[] = []

  private enabledRulesetsPath(extensionId: string): string {
    return path.join(dnrPersistDir(), extensionId, 'enabled_rulesets.json')
  }

  private async loadPersistedEnabledRulesets(extensionId: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.enabledRulesetsPath(extensionId), 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  private async persistEnabledRulesets(extensionId: string, enabled: Set<string>): Promise<void> {
    const dir = path.join(dnrPersistDir(), extensionId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      this.enabledRulesetsPath(extensionId),
      JSON.stringify([...enabled]),
      'utf8',
    )
  }

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('declarativeNetRequest.getDynamicRules', this.getDynamicRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateDynamicRules', this.updateDynamicRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.getSessionRules', this.getSessionRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateSessionRules', this.updateSessionRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.getEnabledRulesets', this.getEnabledRulesets, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateEnabledRulesets', this.updateEnabledRulesets, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.updateStaticRules', this.updateStaticRules, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.isRegexSupported', this.isRegexSupported, {
      permission: 'declarativeNetRequest',
    })
    handle('declarativeNetRequest.getMatchedRules', this.getMatchedRules, {
      permission: 'declarativeNetRequest',
    })

    const sessionExtensions = getSessionExtensions(this.ctx.session)
    const getAll = (sessionExtensions as any).getAllExtensions
    if (typeof getAll === 'function') {
      const list = getAll.call(sessionExtensions) || []
      for (const ext of list) {
        void this.loadExtensionRules(ext)
      }
    }

    sessionExtensions.on('extension-loaded', (_event, extension: Electron.Extension) => {
      void this.loadExtensionRules(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension: Electron.Extension) => {
      const state = this.byExtension.get(extension.id)
      if (state?.enabledRulesets.size) {
        void this.persistEnabledRulesets(extension.id, state.enabledRulesets)
      }
      this.byExtension.delete(extension.id)
      this.rebuildGlobalIndexes()
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
      }
      this.byExtension.set(extensionId, s)
    }
    return s
  }

  private async loadExtensionRules(extension: Electron.Extension) {
    const manifest = extension.manifest as chrome.runtime.ManifestV3
    const dnr = manifest.declarative_net_request
    if (!dnr?.rule_resources?.length) {
      return
    }

    const state = this.ensureState(extension.id)
    state.staticByRuleset.clear()

    // Restore rulesets enabled via updateEnabledRulesets (survives SW reload / extension reload).
    const persisted = await this.loadPersistedEnabledRulesets(extension.id)
    for (const id of persisted) {
      state.enabledRulesets.add(id)
    }

    // Pre-populate enabled rulesets from manifest defaults (Chrome behavior).
    for (const res of dnr.rule_resources) {
      if (res.enabled) state.enabledRulesets.add(res.id)
    }

    // If no rulesets are enabled yet, and the extension has the
    // declarativeNetRequest permission, auto-enable ALL rulesets.
    // This is necessary because some extensions (like Ghostery)
    // set all rulesets to enabled:false and rely on their background
    // service worker to call updateEnabledRulesets().  In Electron,
    // MV3 service workers may never start, so we enable everything
    // here as a safe default — the extension can still call
    // updateEnabledRulesets() later to disable unwanted ones.
    if (state.enabledRulesets.size === 0) {
      // manifest is already typed as chrome.runtime.ManifestV3 (see above)
      const perms = manifest.permissions
      if (Array.isArray(perms) && (perms.includes('declarativeNetRequest') || perms.includes('declarativeNetRequestWithHostAccess'))) {
        for (const res of dnr.rule_resources) {
          state.enabledRulesets.add(res.id)
        }
      }
    }

    for (const res of dnr.rule_resources) {
      try {
        const fullPath = path.join(extension.path, res.path)
        const raw = await fs.readFile(fullPath, 'utf8')
        const data = JSON.parse(raw)
        const arr: DNRRule[] = Array.isArray(data) ? data : data.rules
        if (!Array.isArray(arr)) continue
        const compiled: InternalRule[] = []
        for (const rule of arr) {
          const c = compileRule(extension.id, rule)
          if (c) {
            c.rulesetId = res.id
            compiled.push(c)
          }
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

  private isStaticRuleDisabled(state: ExtensionDNRState, rule: InternalRule): boolean {
    if (!rule.rulesetId) return false
    return state.disabledStaticRuleIds.get(rule.rulesetId)?.has(rule.id) ?? false
  }

  /** Index a rule for host-bucket lookup (urlFilter host, requestDomains, or generic). */
  private addRuleToHostIndex(r: InternalRule) {
    const reqDomains = (r.condition as RuleCondition & { requestDomains?: string[] })
      .requestDomains

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

  private rebuildGlobalIndexes() {
    this.hostIndex.clear()
    this.genericRules = []

    for (const [, state] of this.byExtension) {
      const rules: InternalRule[] = []
      for (const rulesetId of state.enabledRulesets) {
        const chunk = state.staticByRuleset.get(rulesetId)
        if (chunk) {
          for (const rule of chunk) {
            if (!this.isStaticRuleDisabled(state, rule)) {
              rules.push(rule)
            }
          }
        }
      }
      rules.push(...state.dynamicRules.values())
      rules.push(...state.sessionRules.values())

      for (const r of rules) {
        this.addRuleToHostIndex(r)
      }
    }
  }

  private candidateRulesForUrl(requestUrl: string): InternalRule[] {
    const host = safeHostname(requestUrl)
    if (!host) return [...this.genericRules]
    const seen = new Set<string>()
    const out: InternalRule[] = []
    const key = (r: InternalRule) => `${r.extensionId}:${r.id}`
    for (const suffix of collectHostSuffixes(host)) {
      const bucket = this.hostIndex.get(suffix)
      if (!bucket) continue
      for (const r of bucket) {
        const k = key(r)
        if (!seen.has(k)) {
          seen.add(k)
          out.push(r)
        }
      }
    }
    for (const r of this.genericRules) {
      const k = key(r)
      if (!seen.has(k)) {
        seen.add(k)
        out.push(r)
      }
    }
    return out
  }

  evaluateOnBeforeRequest(details: WebRequestDetails): WebRequestBlockingResponse | null {
    const dnrType = normalizeResourceTypeForDnr(details.type)
    const probe = {
      url: details.url,
      method: details.method,
      tabId: details.tabId,
      type: dnrType,
      initiator: details.initiator,
    }

    const candidates = this.candidateRulesForUrl(details.url)
    let best: InternalRule | null = null

    for (const r of candidates) {
      if (
        !conditionMatchesRequest(
          r.condition,
          probe,
          r.urlFilter,
          r.isUrlFilterCaseSensitive,
          r.regex,
        )
      ) {
        continue
      }
      if (
        !best ||
        r.priority > best.priority ||
        (r.priority === best.priority && r.id > best.id)
      ) {
        best = r
      }
    }

    if (!best) {
      return null
    }
    let response = this.actionToBlockingResponse(best, details.url)
    if (
      response &&
      (response.cancel === true || typeof response.redirectUrl === 'string') &&
      shouldSkipCrossExtensionDeclarativeAction(details.initiator, best.extensionId)
    ) {
      return null
    }

    // Main-frame blocks: prefer the extension's redirect-protection page when present.
    if (
      response?.cancel === true &&
      dnrType === 'main_frame' &&
      best.condition.resourceTypes?.some((t) => String(t) === 'main_frame')
    ) {
      const interstitial = this.mainFrameBlockInterstitialUrl(best.extensionId)
      if (interstitial) {
        response = { redirectUrl: interstitial }
      }
    }

    return response
  }

  private mainFrameBlockInterstitialUrl(extensionId: string): string | null {
    try {
      const sessionExtensions = getSessionExtensions(this.ctx.session)
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension?.path) return null
      const abs = path.join(extension.path, 'pages', 'redirect-protection', 'index.html')
      if (!existsSync(abs)) return null
      return `chrome-extension://${extensionId}/pages/redirect-protection/index.html`
    } catch {
      return null
    }
  }

  private actionToBlockingResponse(
    rule: InternalRule,
    requestUrl: string,
  ): WebRequestBlockingResponse | null {
    const a = rule.action
    switch (a.type) {
      case 'block':
        return { cancel: true }
      case 'allow':
      case 'allowAllRequests':
        return null
      case 'upgradeScheme': {
        try {
          const u = new URL(requestUrl)
          if (u.protocol !== 'http:') return null
          u.protocol = 'https:'
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
          const p = red.extensionPath.startsWith('/')
            ? red.extensionPath
            : `/${red.extensionPath}`
          return { redirectUrl: `chrome-extension://${rule.extensionId}${p}` }
        }
        if (red.transform) {
          const transformed = applyUrlTransform(requestUrl, red.transform as UrlTransform)
          if (transformed) return { redirectUrl: transformed }
        }
        return null
      }
      case 'modifyHeaders': {
        const mod = a as any
        const res: WebRequestBlockingResponse = {}
        if (mod?.requestHeaders?.length) {
          const hdrs: Record<string, string | string[]> = {}
          for (const h of mod.requestHeaders) {
            if (h.operation === 'remove') {
              hdrs[h.header] = ''
            } else if (h.value != null) {
              hdrs[h.header] = h.value
            }
          }
          if (Object.keys(hdrs).length > 0) res.requestHeaders = hdrs
        }
        if (mod?.responseHeaders?.length) {
          const hdrs: Record<string, string | string[]> = {}
          for (const h of mod.responseHeaders) {
            if (h.operation === 'remove') {
              hdrs[h.header] = ''
            } else if (h.value != null) {
              hdrs[h.header] = h.value
            }
          }
          if (Object.keys(hdrs).length > 0) res.responseHeaders = hdrs
        }
        return Object.keys(res).length > 0 ? res : null
      }
    }
  }

  private getDynamicRules = ({ extension }: ExtensionEvent, filter?: { ruleIds?: number[] }) => {
    if (!extension) return []
    const state = this.byExtension.get(extension.id)
    if (!state) return []
    const rules = [...state.dynamicRules.values()].map((r) => this.internalToApiRule(r))
    if (filter?.ruleIds?.length) {
      const set = new Set(filter.ruleIds)
      return rules.filter((r) => set.has(r.id))
    }
    return rules
  }

  private getSessionRules = ({ extension }: ExtensionEvent, filter?: { ruleIds?: number[] }) => {
    if (!extension) return []
    const state = this.byExtension.get(extension.id)
    if (!state) return []
    const rules = [...state.sessionRules.values()].map((r) => this.internalToApiRule(r))
    if (filter?.ruleIds?.length) {
      const set = new Set(filter.ruleIds)
      return rules.filter((r) => set.has(r.id))
    }
    return rules
  }

  private internalToApiRule(r: InternalRule): DNRRule {
    return {
      id: r.id,
      priority: r.priority,
      action: r.action,
      condition: r.condition,
    }
  }

  private updateDynamicRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    const remove = new Set(options.removeRuleIds || [])
    for (const id of remove) {
      state.dynamicRules.delete(id)
    }
    for (const rule of options.addRules || []) {
      const c = compileRule(extension.id, rule)
      if (c) state.dynamicRules.set(rule.id, c)
    }
    this.rebuildGlobalIndexes()
  }

  private updateSessionRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRuleOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    const remove = new Set(options.removeRuleIds || [])
    for (const id of remove) {
      state.sessionRules.delete(id)
    }
    for (const rule of options.addRules || []) {
      const c = compileRule(extension.id, rule)
      if (c) state.sessionRules.set(rule.id, c)
    }
    this.rebuildGlobalIndexes()
  }

  private getEnabledRulesets = ({ extension }: ExtensionEvent): string[] => {
    if (!extension) return []
    const state = this.byExtension.get(extension.id)
    if (!state) return []
    return [...state.enabledRulesets]
  }

  private updateEnabledRulesets = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateRulesetOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    for (const id of options.disableRulesetIds || []) {
      state.enabledRulesets.delete(id)
    }
    for (const id of options.enableRulesetIds || []) {
      state.enabledRulesets.add(id)
    }
    await this.persistEnabledRulesets(extension.id, state.enabledRulesets)
    this.rebuildGlobalIndexes()
  }

  private updateStaticRules = async (
    { extension }: ExtensionEvent,
    options: chrome.declarativeNetRequest.UpdateStaticRulesOptions,
  ) => {
    if (!extension) return
    const state = this.ensureState(extension.id)
    const rulesetId = options.rulesetId
    let disabled = state.disabledStaticRuleIds.get(rulesetId)
    if (!disabled) {
      disabled = new Set()
      state.disabledStaticRuleIds.set(rulesetId, disabled)
    }
    for (const id of options.disableRuleIds || []) {
      disabled.add(id)
    }
    for (const id of options.enableRuleIds || []) {
      disabled.delete(id)
    }
    this.rebuildGlobalIndexes()
  }

  private isRegexSupported = (
    _event: ExtensionEvent,
    regexOptions: chrome.declarativeNetRequest.RegexOptions,
  ): chrome.declarativeNetRequest.IsRegexSupportedResult => {
    const r = isRegexSupportedChromeSubset(regexOptions.regex)
    return r as chrome.declarativeNetRequest.IsRegexSupportedResult
  }

  private getMatchedRules = async (
    _event: ExtensionEvent,
    _filter?: chrome.declarativeNetRequest.MatchedRulesFilter,
  ): Promise<chrome.declarativeNetRequest.RulesMatchedDetails> => {
    return { rulesMatchedInfo: [] }
  }
}
