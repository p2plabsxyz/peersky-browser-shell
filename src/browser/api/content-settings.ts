import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ArgSpec, checkArgs, checkValue, MAX_STRING, ParamSpec } from './arg-check'
import { ExtensionSettings, INCOGNITO_ERROR } from './chrome-setting'

interface ContentType {
  /** The values set() takes, in Chrome's schema order. */
  values: readonly string[]
  /** Chrome's setting when nothing else decides. */
  defaultValue: string
  ref: string
  /** Rules may name the embedding page (cookies only, as in Chrome). */
  secondary?: boolean
  /** Values a rule for every site may have, when that is fewer than `values`. */
  defaultValues?: readonly string[]
  /** Only a rule for every site is allowed. */
  noSiteRules?: boolean
}

/** The content settings Chrome 157 still has, with its defaults for a new profile. */
export const CONTENT_TYPES: Record<string, ContentType> = {
  automaticDownloads: {
    values: ['allow', 'block', 'ask'],
    defaultValue: 'ask',
    ref: 'contentSettings.MultipleAutomaticDownloadsContentSetting',
  },
  autoVerify: {
    values: ['allow', 'block'],
    defaultValue: 'allow',
    ref: 'contentSettings.AutoVerifyContentSetting',
    noSiteRules: true,
  },
  camera: {
    values: ['allow', 'block', 'ask'],
    defaultValue: 'ask',
    ref: 'contentSettings.CameraContentSetting',
    defaultValues: ['block', 'ask'],
  },
  clipboard: { values: ['allow', 'block', 'ask'], defaultValue: 'ask', ref: 'contentSettings.ClipboardContentSetting' },
  cookies: {
    values: ['allow', 'block', 'session_only'],
    defaultValue: 'allow',
    ref: 'contentSettings.CookiesContentSetting',
    secondary: true,
  },
  images: { values: ['allow', 'block'], defaultValue: 'allow', ref: 'contentSettings.ImagesContentSetting' },
  javascript: { values: ['allow', 'block'], defaultValue: 'allow', ref: 'contentSettings.JavascriptContentSetting' },
  location: { values: ['allow', 'block', 'ask'], defaultValue: 'ask', ref: 'contentSettings.LocationContentSetting' },
  microphone: {
    values: ['allow', 'block', 'ask'],
    defaultValue: 'ask',
    ref: 'contentSettings.MicrophoneContentSetting',
    defaultValues: ['block', 'ask'],
  },
  notifications: {
    values: ['allow', 'block', 'ask'],
    defaultValue: 'ask',
    ref: 'contentSettings.NotificationsContentSetting',
  },
  popups: { values: ['allow', 'block'], defaultValue: 'block', ref: 'contentSettings.PopupsContentSetting' },
  sound: { values: ['allow', 'block'], defaultValue: 'allow', ref: 'contentSettings.SoundContentSetting' },
}

export type ContentSettingType = keyof typeof CONTENT_TYPES

/**
 * Pages whose content Chrome never lets a setting block (its
 * ShouldAllowAllContent): browser pages, including the host's own, and an
 * extension's pages for the types an extension needs to run.
 */
const BROWSER_SCHEMES = new Set(['chrome', 'chrome-untrusted', 'devtools', 'peersky'])
const ALLOWED_ON_BROWSER_PAGES = new Set([
  'javascript',
  'images',
  'cookies',
  'popups',
  'automaticDownloads',
  'camera',
  'microphone',
  'clipboard',
])
const ALLOWED_ON_EXTENSION_PAGES = new Set(['javascript', 'images', 'cookies', 'popups', 'automaticDownloads'])

const MAX_RULES_PER_EXTENSION = 5000
const STATE_NS = 'contentSettings'

// ---------------------------------------------------------------- patterns

/** A content settings pattern, as Chrome's ContentSettingsPattern keeps one. */
export interface ContentPattern {
  /** '' for any scheme. */
  scheme: string
  /** With domainWildcard, '' is any host. */
  host: string
  domainWildcard: boolean
  /** '' for any port. */
  port: string
  /** file: URLs only; undefined is any path. */
  path?: string
  key: string
}

const WILDCARD: ContentPattern = { scheme: '', host: '', domainWildcard: true, port: '', key: '*://[*.]:*/*' }

const INVALID_PATTERN = 'The pattern "*" is invalid.'
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

const canonicalHost = (host: string) => {
  try {
    return new URL(`http://${host}/`).hostname
  } catch {
    return ''
  }
}

/**
 * Parses a pattern the way chrome.contentSettings does: a match pattern for
 * http, https or file, with no path but /* (file: needs an exact path).
 * Throws Chrome's message for what is wrong.
 */
export function parseContentPattern(source: string): ContentPattern {
  if (source === '<all_urls>') return WILDCARD
  let sep = source.indexOf('://')
  let standardSeparator = true
  if (sep < 0) {
    sep = source.indexOf(':')
    standardSeparator = false
  }
  if (sep < 0) throw new Error('Missing scheme separator.')
  const scheme = source.slice(0, sep).toLowerCase()
  if (scheme !== '*' && scheme !== 'http' && scheme !== 'https' && scheme !== 'file') {
    throw new Error('Invalid scheme.')
  }
  if (!standardSeparator) throw new Error('Wrong scheme type.')

  const hostStart = sep + 3
  let host = ''
  let domainWildcard = false
  let port = ''
  let pathStart: number
  if (scheme === 'file') {
    const hostEnd = source.indexOf('/', hostStart)
    pathStart = hostEnd < 0 ? hostStart - 1 : hostEnd
  } else {
    const hostEnd = source.indexOf('/', hostStart)
    if (hostEnd === hostStart) throw new Error('Host can not be empty.')
    if (hostEnd < 0) throw new Error('Empty path.')
    let hostAndPort = source.slice(hostStart, hostEnd)
    let portSep = -1
    if (hostAndPort[0] !== '[') {
      portSep = hostAndPort.indexOf(':')
    } else {
      const close = hostAndPort.indexOf(']')
      if (close < 0) throw new Error('Invalid host.')
      if (close === 1) throw new Error('Host can not be empty.')
      if (close < hostAndPort.length - 1) {
        if (hostAndPort[close + 1] !== ':') throw new Error('Invalid host.')
        portSep = close + 1
      }
    }
    if (portSep >= 0) {
      const p = hostAndPort.slice(portSep + 1)
      if (p !== '*' && !(/^\d{1,5}$/.test(p) && Number(p) <= 65535)) throw new Error('Invalid port.')
      port = p === '*' ? '' : String(Number(p))
      hostAndPort = hostAndPort.slice(0, portSep)
    }
    const parts = hostAndPort.split('.')
    if (parts.length === 1 && parts[0] === '') throw new Error('Host can not be empty.')
    if (parts[0] === '*') {
      domainWildcard = true
      parts.shift()
    }
    host = parts.join('.')
    if (host.includes('*')) throw new Error('Invalid host wildcard.')
    if (host) {
      host = canonicalHost(host)
      if (!host) throw new Error('Invalid host.')
    }
    pathStart = hostEnd
  }
  const path = source.slice(pathStart)

  let filePath: string | undefined
  if (scheme === 'file') {
    if (/[*?]/.test(path)) throw new Error('Path wildcards in file URL patterns are not allowed.')
    if (path === '/' || path === '') throw new Error(INVALID_PATTERN)
    filePath = path
  } else if (path !== '/*') {
    throw new Error('Specific paths are not allowed.')
  }
  const isIp = IPV4.test(host) || host.startsWith('[')
  if (domainWildcard && host && isIp) throw new Error(INVALID_PATTERN)

  const out: ContentPattern = {
    scheme: scheme === '*' ? '' : scheme,
    host: scheme === 'file' ? '' : host,
    domainWildcard: scheme === 'file' ? false : domainWildcard,
    port: scheme === 'file' ? '' : port,
    path: filePath,
    key: '',
  }
  out.key = `${out.scheme || '*'}://${out.domainWildcard ? '[*.]' : ''}${out.host}:${out.port || '*'}${out.path ?? '/*'}`
  return out
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443', ftp: '21' }

/** Whether a URL is one the pattern covers, as ContentSettingsPattern::Matches. */
export function contentPatternMatches(pattern: ContentPattern, url: URL): boolean {
  const scheme = url.protocol.replace(/:$/, '')
  if (pattern.scheme && pattern.scheme !== scheme) return false
  if (pattern.scheme === 'file') return pattern.path === undefined || pattern.path === url.pathname
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!pattern.domainWildcard) {
    if (pattern.host !== host) return false
  } else if (pattern.host && host !== pattern.host && !host.endsWith('.' + pattern.host)) {
    return false
  }
  if (pattern.port) {
    const port = url.port || DEFAULT_PORTS[scheme] || '-1'
    if (port !== pattern.port) return false
  }
  return true
}

/** How specific a pattern is, compared host first, then port, scheme and path. */
const specificity = (p: ContentPattern): number[] => [
  !p.domainWildcard ? 1e6 : p.host ? 1000 + p.host.split('.').length : 0,
  p.port ? 1 : 0,
  p.scheme ? 1 : 0,
  p.path !== undefined ? 1 : 0,
]

const compareSpecificity = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

const isWildcard = (p: ContentPattern) => !p.scheme && p.domainWildcard && !p.host && !p.port

// ---------------------------------------------------------------- rules

interface StoredRule {
  t: string
  p: string
  s?: string
  v: string
}

interface Rule extends StoredRule {
  primary: ContentPattern
  secondary: ContentPattern
}

const SCOPE: ArgSpec = { type: 'string', enum: ['regular', 'incognito_session_only'], ref: 'contentSettings.Scope', optional: true }
const RESOURCE_ID: ArgSpec = {
  type: 'object',
  ref: 'contentSettings.ResourceIdentifier',
  optional: true,
  properties: { id: { type: 'string' }, description: { type: 'string', optional: true } },
}
const GET_PARAMS: ParamSpec[] = [
  {
    name: 'details',
    spec: {
      type: 'object',
      properties: {
        primaryUrl: { type: 'string' },
        secondaryUrl: { type: 'string', optional: true },
        resourceIdentifier: RESOURCE_ID,
        incognito: { type: 'boolean', optional: true },
      },
    },
  },
]
const SET_PARAMS: ParamSpec[] = [
  {
    name: 'details',
    spec: {
      type: 'object',
      properties: {
        primaryPattern: { type: 'string' },
        secondaryPattern: { type: 'string', optional: true },
        resourceIdentifier: RESOURCE_ID,
        setting: { type: 'any' },
        scope: SCOPE,
      },
    },
  },
]
const CLEAR_PARAMS: ParamSpec[] = [{ name: 'details', spec: { type: 'object', properties: { scope: SCOPE } } }]

/** What the host is asked for when no extension rule decides. */
export interface ContentSettingQuery {
  type: ContentSettingType
  primaryUrl: string
  secondaryUrl: string
}

const parseUrl = (url: string | undefined) => {
  if (typeof url !== 'string') return undefined
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

const DOCUMENT_TYPES = new Set(['mainFrame', 'subFrame'])
// Everything a sandboxed page may still do, with scripts left out.
const NO_SCRIPT_SANDBOX =
  'sandbox allow-downloads allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups ' +
  'allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-top-navigation ' +
  'allow-top-navigation-by-user-activation'

type Headers = Record<string, string | string[]>

const headerKeys = (headers: Headers, name: string) => Object.keys(headers).filter((k) => k.toLowerCase() === name)

/**
 * chrome.contentSettings: rules per extension for every content type Chrome
 * still has, with Chrome's patterns, precedence, defaults and errors, kept
 * per session.
 *
 * The library applies what it can without taking over the host's own
 * handlers: JavaScript and images (a Content-Security-Policy on the pages it
 * blocks) and cookies (Cookie and Set-Cookie) on what passes through the
 * host's webRequest bridge, and sound by muting tabs. For the rest (popups,
 * notifications, location, camera, microphone, clipboard, automatic
 * downloads) the host asks `ElectronChromeExtensions.getContentSetting()` from
 * its own permission and window-open handlers.
 */
export class ContentSettingsAPI {
  private settings: ExtensionSettings
  private rules = new Map<string, Map<string, Rule>>()
  private ready: Promise<void>
  /** Types that some loaded extension has a rule for. */
  private activeTypes = new Set<string>()
  private mutedBySettings = new WeakSet<Electron.WebContents>()

  constructor(private ctx: ExtensionContext) {
    this.settings = ExtensionSettings.for(ctx)
    this.ready = this.settings.ready.then(() => this.load())

    const handle = ctx.router.apiHandler()
    const opts = { permission: 'contentSettings' }
    handle('contentSettings.get', this.get, opts)
    handle('contentSettings.set', this.set, opts)
    handle('contentSettings.clear', this.clear, opts)
    handle('contentSettings.getResourceIdentifiers', this.getResourceIdentifiers, opts)

    this.settings.onLoadedChange((extensionId) => {
      if (this.rules.has(extensionId)) this.rulesChanged()
    })

    ctx.store?.on?.('tab-added', (tab: Electron.WebContents) => {
      this.applySound(tab)
      tab.on('did-navigate', () => this.applySound(tab))
    })
  }

  /**
   * The setting that counts for a page, as chrome.contentSettings.<type>.get
   * returns it: an extension's rule, then the host's own answer from its
   * `getContentSetting` hook, then Chrome's default.
   */
  getContentSetting(type: string, primaryUrl: string, secondaryUrl?: string): string | undefined {
    const info = CONTENT_TYPES[type]
    const primary = parseUrl(primaryUrl)
    if (!info || !primary) return undefined
    const secondary = (secondaryUrl !== undefined ? parseUrl(secondaryUrl) : primary) || primary
    const scheme = primary.protocol.replace(/:$/, '')
    if (BROWSER_SCHEMES.has(scheme) && ALLOWED_ON_BROWSER_PAGES.has(type)) return 'allow'
    if (scheme === 'chrome-extension' && ALLOWED_ON_EXTENSION_PAGES.has(type)) return 'allow'

    for (const extensionId of this.settings.loadedByPrecedence()) {
      const rules = this.rules.get(extensionId)
      if (!rules) continue
      let best: { rule: Rule; score: number[][] } | undefined
      for (const rule of rules.values()) {
        if (rule.t !== type) continue
        if (!contentPatternMatches(rule.primary, primary) || !contentPatternMatches(rule.secondary, secondary)) continue
        const score = [specificity(rule.primary), specificity(rule.secondary)]
        if (
          !best ||
          compareSpecificity(score[0], best.score[0]) > 0 ||
          (compareSpecificity(score[0], best.score[0]) === 0 && compareSpecificity(score[1], best.score[1]) > 0)
        ) {
          best = { rule, score }
        }
      }
      if (best) return best.rule.v
    }

    const hook = this.ctx.store?.impl?.getContentSetting
    if (typeof hook === 'function') {
      try {
        const answer = hook({ type: type as ContentSettingType, primaryUrl: primary.href, secondaryUrl: secondary.href })
        if (typeof answer === 'string' && info.values.includes(answer)) return answer
      } catch (error) {
        console.error('getContentSetting hook failed:', error)
      }
    }
    return info.defaultValue
  }

  /**
   * Headers to send instead of a request's, for the cookie rules; undefined
   * when nothing changes. Called from the webRequest bridge.
   */
  requestHeadersFor(details: Electron.OnBeforeSendHeadersListenerDetails, headers: Headers): Headers | undefined {
    if (!this.activeTypes.has('cookies')) return undefined
    const keys = headerKeys(headers, 'cookie')
    if (keys.length === 0) return undefined
    if (this.getContentSetting('cookies', details.url, this.topUrlOf(details)) !== 'block') return undefined
    const out = { ...headers }
    for (const k of keys) delete out[k]
    return out
  }

  /**
   * Headers to use instead of a response's: a Content-Security-Policy that
   * stops scripts or images on a page they are blocked for, and cookies kept
   * out or made to end with the session. Undefined when nothing changes.
   */
  responseHeadersFor(details: Electron.OnHeadersReceivedListenerDetails, headers: Headers | undefined): Headers | undefined {
    if (this.activeTypes.size === 0 || !headers) return undefined
    let out: Headers | undefined
    const edit = () => (out ||= { ...headers })

    if (this.activeTypes.has('cookies')) {
      const keys = headerKeys(headers, 'set-cookie')
      if (keys.length > 0) {
        const setting = this.getContentSetting('cookies', details.url, this.topUrlOf(details))
        if (setting === 'block') {
          for (const k of keys) delete edit()[k]
        } else if (setting === 'session_only') {
          for (const k of keys) {
            const values = ([] as string[]).concat(headers[k])
            edit()[k] = values.map((v) => v.replace(/;\s*(expires|max-age)=[^;]*/gi, ''))
          }
        }
      }
    }

    const isDocument = DOCUMENT_TYPES.has(details.resourceType)
    if (isDocument && (this.activeTypes.has('javascript') || this.activeTypes.has('images'))) {
      // Both are decided by the page in the tab, as in Chrome.
      const topUrl = details.resourceType === 'mainFrame' ? details.url : this.topUrlOf(details)
      const policies: string[] = []
      if (this.getContentSetting('javascript', topUrl) === 'block' && this.isMarkup(headers)) policies.push(NO_SCRIPT_SANDBOX)
      if (this.getContentSetting('images', topUrl) === 'block') policies.push("img-src 'none'")
      if (policies.length > 0) {
        const target = edit()
        const key = headerKeys(target, 'content-security-policy')[0] || 'Content-Security-Policy'
        // A second policy only narrows what the page's own policy allows.
        target[key] = [...([] as string[]).concat(target[key] || []), policies.join('; ')]
      }
    }
    return out
  }

  /** Drops every rule an extension set, as when Chrome uninstalls it. */
  async forget(extensionId: string) {
    await this.ready
    if (!this.rules.delete(extensionId)) return
    this.save()
    this.rulesChanged()
  }

  private isMarkup(headers: Headers) {
    const key = headerKeys(headers, 'content-type')[0]
    if (!key) return true
    const type = String(([] as string[]).concat(headers[key])[0] || '').toLowerCase()
    return !type || /html|xml|svg/.test(type)
  }

  private topUrlOf(details: { url: string; frame?: Electron.WebFrameMain | null; webContents?: Electron.WebContents }) {
    try {
      const top = details.frame?.top?.url
      if (top) return top
    } catch {}
    try {
      const url = details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : ''
      if (url) return url
    } catch {}
    return details.url
  }

  private applySound(tab: Electron.WebContents) {
    if (tab.isDestroyed()) return
    const url = tab.getURL()
    const blocked = !!url && this.activeTypes.has('sound') && this.getContentSetting('sound', url) === 'block'
    if (blocked && !tab.isAudioMuted()) {
      tab.setAudioMuted(true)
      this.mutedBySettings.add(tab)
    } else if (!blocked && this.mutedBySettings.has(tab)) {
      this.mutedBySettings.delete(tab)
      tab.setAudioMuted(false)
    }
  }

  private load() {
    const saved = this.ctx.stateStore.getNamespace<Record<string, StoredRule[]>>(STATE_NS, {})
    for (const [extensionId, list] of Object.entries(saved || {})) {
      if (!Array.isArray(list)) continue
      const map = new Map<string, Rule>()
      for (const stored of list.slice(0, MAX_RULES_PER_EXTENSION)) {
        try {
          const info = CONTENT_TYPES[stored.t]
          if (!info || !info.values.includes(stored.v)) continue
          const primary = parseContentPattern(stored.p)
          const secondary = stored.s ? parseContentPattern(stored.s) : WILDCARD
          map.set(`${stored.t}|${primary.key}|${secondary.key}`, { ...stored, primary, secondary })
        } catch {
          // A rule this version cannot read is dropped.
        }
      }
      if (map.size) this.rules.set(extensionId, map)
    }
    this.rulesChanged()
  }

  private save() {
    const out: Record<string, StoredRule[]> = {}
    for (const [extensionId, map] of this.rules) {
      out[extensionId] = [...map.values()].map(({ t, p, s, v }) => (s ? { t, p, s, v } : { t, p, v }))
    }
    this.ctx.stateStore.setNamespace(STATE_NS, out)
    void this.ctx.stateStore.flush().catch((error) => console.error('Failed to save content settings:', error))
  }

  private rulesChanged() {
    this.activeTypes.clear()
    for (const [extensionId, map] of this.rules) {
      if (!this.settings.isLoaded(extensionId)) continue
      for (const rule of map.values()) this.activeTypes.add(rule.t)
    }
    for (const tab of this.ctx.store?.tabs || []) this.applySound(tab)
    this.ctx.emit?.('content-settings-changed')
  }

  private typeOf(args: any[]): ContentType & { name: string } {
    const name = args.shift()
    const info = typeof name === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_TYPES, name) ? CONTENT_TYPES[name] : undefined
    if (!info) throw new Error('Invalid invocation')
    return { ...info, name }
  }

  private get = async ({ extension }: ExtensionEvent, ...args: any[]) => {
    const type = this.typeOf(args)
    checkArgs('contentSettings.ContentSetting.get', GET_PARAMS, args)
    const details = args[0]
    if (!parseUrl(details.primaryUrl)) throw new Error(`The URL "${details.primaryUrl}" is invalid.`)
    if (details.secondaryUrl !== undefined && details.secondaryUrl !== null && !parseUrl(details.secondaryUrl)) {
      throw new Error(`The URL "${details.secondaryUrl}" is invalid.`)
    }
    if (details.incognito === true) throw new Error(INCOGNITO_ERROR)
    await this.ready
    this.settings.touch(extension.id)
    return { setting: this.getContentSetting(type.name, details.primaryUrl, details.secondaryUrl ?? undefined) }
  }

  private set = async ({ extension }: ExtensionEvent, ...args: any[]) => {
    const type = this.typeOf(args)
    checkArgs('contentSettings.ContentSetting.set', SET_PARAMS, args)
    const details = args[0]
    const settingError = checkValue({ type: 'string', enum: type.values, ref: type.ref }, details.setting)
    if (settingError) throw new Error(`Invalid invocation: Error at property 'setting': ${settingError}`)
    if (details.primaryPattern.length > MAX_STRING) throw new Error('Invalid invocation')
    const primary = parseContentPattern(details.primaryPattern)
    let secondary = WILDCARD
    if (typeof details.secondaryPattern === 'string') {
      if (details.secondaryPattern.length > MAX_STRING) throw new Error('Invalid invocation')
      secondary = parseContentPattern(details.secondaryPattern)
    }
    const everySite = isWildcard(primary) && isWildcard(secondary)
    if (everySite && type.defaultValues && !type.defaultValues.includes(details.setting)) {
      throw new Error(`'${details.setting}' is not supported as the default setting of ${type.name}.`)
    }
    if (!everySite && type.noSiteRules) {
      throw new Error("Site-specific settings are not allowed for this type. The URL pattern must be '<all_urls>'.")
    }
    if (primary.key !== secondary.key && !isWildcard(secondary) && !type.secondary) {
      throw new Error('Embedded patterns are not supported for this setting.')
    }
    if (details.scope === 'incognito_session_only') throw new Error(INCOGNITO_ERROR)

    await this.ready
    this.settings.touch(extension.id)
    let map = this.rules.get(extension.id)
    if (!map) this.rules.set(extension.id, (map = new Map()))
    const key = `${type.name}|${primary.key}|${secondary.key}`
    if (!map.has(key) && map.size >= MAX_RULES_PER_EXTENSION) throw new Error('Too many content setting rules.')
    map.set(key, {
      t: type.name,
      p: details.primaryPattern,
      s: isWildcard(secondary) ? undefined : details.secondaryPattern,
      v: details.setting,
      primary,
      secondary,
    })
    this.save()
    this.rulesChanged()
  }

  private clear = async ({ extension }: ExtensionEvent, ...args: any[]) => {
    const type = this.typeOf(args)
    checkArgs('contentSettings.ContentSetting.clear', CLEAR_PARAMS, args)
    // Chrome takes an incognito clear without complaint and changes nothing.
    if (args[0].scope === 'incognito_session_only') return
    await this.ready
    const map = this.rules.get(extension.id)
    if (!map) return
    let changed = false
    for (const [key, rule] of map) {
      if (rule.t !== type.name) continue
      map.delete(key)
      changed = true
    }
    if (map.size === 0) this.rules.delete(extension.id)
    if (!changed) return
    this.save()
    this.rulesChanged()
  }

  private getResourceIdentifiers = async (_event: ExtensionEvent, ...args: any[]) => {
    this.typeOf(args)
    checkArgs('contentSettings.ContentSetting.getResourceIdentifiers', [], args)
    // Chrome has had no resource identifiers since plugins went.
    return undefined
  }
}
