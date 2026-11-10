import { patternCovers, matchesAnyPattern, tryParseMatchPattern, urlMatches } from './match-pattern'

/**
 * Chrome's extension API permissions. A name outside this list is refused the
 * way Chrome refuses it: "'x' is not a recognized permission."
 */
export const KNOWN_PERMISSIONS = new Set([
  'accessibilityFeatures.modify', 'accessibilityFeatures.read', 'activeTab', 'alarms', 'audio',
  'background', 'bookmarks', 'browsingData', 'certificateProvider', 'clipboardRead',
  'clipboardWrite', 'contentSettings', 'contextMenus', 'cookies', 'debugger', 'declarativeContent',
  'declarativeNetRequest', 'declarativeNetRequestFeedback', 'declarativeNetRequestWithHostAccess',
  'declarativeWebRequest', 'desktopCapture', 'dns', 'documentScan', 'downloads', 'downloads.open',
  'downloads.ui', 'enterprise.deviceAttributes', 'enterprise.hardwarePlatform',
  'enterprise.networkingAttributes', 'enterprise.platformKeys', 'experimental',
  'fileBrowserHandler', 'fileSystemProvider', 'favicon', 'fontSettings', 'gcm', 'geolocation',
  'history', 'identity', 'identity.email', 'idle', 'loginState', 'management', 'nativeMessaging',
  'notifications', 'offscreen', 'pageCapture', 'platformKeys', 'power', 'printerProvider',
  'printing', 'printingMetrics', 'privacy', 'processes', 'proxy', 'readingList', 'runtime',
  'scripting', 'search', 'sessions', 'sidePanel', 'storage', 'system.cpu', 'system.display',
  'system.memory', 'system.storage', 'tabCapture', 'tabGroups', 'tabs', 'topSites', 'tts',
  'ttsEngine', 'unlimitedStorage', 'userScripts', 'vpnProvider', 'wallpaper',
  'webAuthenticationProxy', 'webNavigation', 'webRequest', 'webRequestAuthProvider',
  'webRequestBlocking',
])

const PERMISSIONS_STATE_NS = 'permissions'

type Manifest = chrome.runtime.Manifest & Record<string, any>

const isHostPattern = (value: string) => value === '<all_urls>' || value.includes('://')

/** What a manifest asks for, split into API permissions and host patterns. */
export function readManifestPermissions(manifest: Manifest) {
  const mv3 = manifest.manifest_version === 3
  const split = (list: unknown) => {
    const apis: string[] = []
    const origins: string[] = []
    for (const value of Array.isArray(list) ? list : []) {
      if (typeof value !== 'string') continue
      if (isHostPattern(value)) origins.push(value)
      else apis.push(value)
    }
    return { apis, origins }
  }
  const required = split(manifest.permissions)
  const optional = split(manifest.optional_permissions)
  if (mv3) {
    required.origins.push(...split(manifest.host_permissions).origins)
    optional.origins.push(...split(manifest.optional_host_permissions).origins)
  }
  const contentScriptOrigins: string[] = []
  for (const script of Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []) {
    for (const match of Array.isArray(script?.matches) ? script.matches : []) {
      if (typeof match === 'string') contentScriptOrigins.push(match)
    }
  }
  return {
    apis: required.apis.filter((p) => KNOWN_PERMISSIONS.has(p)),
    origins: required.origins.filter((p) => !!tryParseMatchPattern(p)),
    optionalApis: optional.apis.filter((p) => KNOWN_PERMISSIONS.has(p)),
    optionalOrigins: optional.origins.filter((p) => !!tryParseMatchPattern(p)),
    contentScriptOrigins: contentScriptOrigins.filter((p) => !!tryParseMatchPattern(p)),
  }
}

interface Granted {
  apis: Set<string>
  origins: string[]
}

interface PersistedGrants {
  [extensionId: string]: { apis: string[]; origins: string[] }
}

export interface PermissionsHost {
  stateStore: {
    whenHydrated(): Promise<void>
    getNamespace<T>(name: string, fallback: T): T
    setNamespace(name: string, value: unknown): void
  }
  sendEvent(extensionId: string, eventName: string, ...args: any[]): void
  /** Asks the person; resolves whether they allowed it. */
  prompt(extension: Electron.Extension, request: { permissions: string[]; origins: string[] }): Promise<boolean>
}

/**
 * The permissions each extension holds: what its manifest requires, plus the
 * optional ones it was granted (kept across restarts), plus activeTab grants
 * for the tab it was invoked on (gone when that tab navigates or closes).
 */
export class ExtensionPermissions {
  private granted = new Map<string, Granted>()
  private manifests = new Map<string, ReturnType<typeof readManifestPermissions>>()
  private activeTabs = new Map<string, Map<number, string>>()

  constructor(private host: PermissionsHost) {}

  private persisted(): PersistedGrants {
    return this.host.stateStore.getNamespace<PersistedGrants>(PERMISSIONS_STATE_NS, {})
  }

  private persist(extensionId: string, apis: string[], origins: string[]) {
    const all = { ...this.persisted() }
    if (apis.length || origins.length) all[extensionId] = { apis, origins }
    else delete all[extensionId]
    this.host.stateStore.setNamespace(PERMISSIONS_STATE_NS, all)
  }

  /** Reads a loaded extension's manifest and any grants it kept from before. */
  async load(extension: Electron.Extension) {
    const declared = readManifestPermissions(extension.manifest)
    this.manifests.set(extension.id, declared)
    this.granted.set(extension.id, { apis: new Set(declared.apis), origins: [...declared.origins] })
    await this.host.stateStore.whenHydrated()
    const saved = this.persisted()[extension.id]
    const current = this.granted.get(extension.id)
    if (!saved || !current) return
    // A grant counts only while the manifest still offers it as optional.
    for (const api of saved.apis) if (declared.optionalApis.includes(api)) current.apis.add(api)
    for (const origin of saved.origins) {
      if (declared.optionalOrigins.some((o) => patternCovers(o, origin))) current.origins.push(origin)
    }
  }

  unload(extensionId: string) {
    this.granted.delete(extensionId)
    this.manifests.delete(extensionId)
    this.activeTabs.delete(extensionId)
  }

  private ensure(extension: Electron.Extension) {
    if (!this.granted.has(extension.id)) {
      const declared = readManifestPermissions(extension.manifest)
      this.manifests.set(extension.id, declared)
      this.granted.set(extension.id, { apis: new Set(declared.apis), origins: [...declared.origins] })
    }
    return this.granted.get(extension.id)!
  }

  /** Whether the extension holds an API permission now. */
  has(extension: Electron.Extension | string, permission: string): boolean {
    const granted =
      typeof extension === 'string' ? this.granted.get(extension) : this.ensure(extension)
    return !!granted?.apis.has(permission)
  }

  /** Host patterns the extension holds now. */
  origins(extension: Electron.Extension): string[] {
    return [...this.ensure(extension).origins]
  }

  /**
   * Whether the extension may read or change `url`. `scriptable` also counts
   * the hosts its content scripts match, as Chrome does for script injection.
   * activeTab counts for the tab the extension was invoked on.
   */
  hasHostAccess(
    extension: Electron.Extension,
    url: string | undefined,
    opts: { tabId?: number; scriptable?: boolean } = {},
  ): boolean {
    if (!url) return false
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    // An extension always reaches its own pages, never another extension's.
    if (parsed.protocol === 'chrome-extension:') return parsed.hostname === extension.id
    const granted = this.ensure(extension)
    if (granted.origins.some((o) => {
      const p = tryParseMatchPattern(o)
      return !!p && urlMatches(p, parsed)
    })) {
      return true
    }
    if (opts.scriptable && matchesAnyPattern(this.manifests.get(extension.id)?.contentScriptOrigins, parsed)) {
      return true
    }
    if (typeof opts.tabId === 'number') {
      const origin = this.activeTabs.get(extension.id)?.get(opts.tabId)
      if (origin && origin === parsed.origin) return true
    }
    return false
  }

  /** activeTab: the person invoked the extension on this tab. */
  grantActiveTab(extension: Electron.Extension, tabId: number, url: string | undefined) {
    if (!this.has(extension, 'activeTab') || !url) return
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return
    }
    let tabs = this.activeTabs.get(extension.id)
    if (!tabs) this.activeTabs.set(extension.id, (tabs = new Map()))
    tabs.set(tabId, origin)
  }

  hasActiveTab(extension: Electron.Extension, tabId: number) {
    return !!this.activeTabs.get(extension.id)?.has(tabId)
  }

  /** A tab navigated to another origin or closed: its activeTab grants end. */
  revokeActiveTab(tabId: number, newUrl?: string) {
    for (const tabs of this.activeTabs.values()) {
      const origin = tabs.get(tabId)
      if (!origin) continue
      let keep = false
      if (newUrl) {
        try {
          keep = new URL(newUrl).origin === origin
        } catch {}
      }
      if (!keep) tabs.delete(tabId)
    }
  }

  private validate(permissions: unknown): string[] {
    const list = Array.isArray(permissions) ? permissions : []
    for (const p of list) {
      if (typeof p !== 'string' || !KNOWN_PERMISSIONS.has(p)) {
        throw new Error(`'${p}' is not a recognized permission.`)
      }
    }
    return list as string[]
  }

  private validateOrigins(origins: unknown): string[] {
    const list = Array.isArray(origins) ? origins : []
    for (const o of list) {
      if (typeof o !== 'string' || !tryParseMatchPattern(o)) {
        throw new Error(`Invalid value for origin pattern ${o}: Missing scheme separator.`)
      }
    }
    return list as string[]
  }

  getAll(extension: Electron.Extension) {
    const granted = this.ensure(extension)
    return { permissions: [...granted.apis], origins: [...granted.origins] }
  }

  contains(extension: Electron.Extension, request: chrome.permissions.Permissions) {
    const apis = this.validate(request?.permissions)
    const origins = this.validateOrigins(request?.origins)
    const granted = this.ensure(extension)
    return (
      apis.every((p) => granted.apis.has(p)) &&
      origins.every((o) => granted.origins.some((g) => patternCovers(g, o)))
    )
  }

  async request(
    extension: Electron.Extension,
    request: chrome.permissions.Permissions,
    gesture: boolean,
  ): Promise<boolean> {
    if (!gesture) throw new Error('This function must be called during a user gesture')
    const apis = this.validate(request?.permissions)
    const origins = this.validateOrigins(request?.origins)
    const declared = this.manifests.get(extension.id) ?? readManifestPermissions(extension.manifest)
    const granted = this.ensure(extension)
    const offered = (p: string) => declared.apis.includes(p) || declared.optionalApis.includes(p)
    const offeredOrigin = (o: string) =>
      [...declared.origins, ...declared.optionalOrigins].some((d) => patternCovers(d, o))
    if (!apis.every(offered) || !origins.every(offeredOrigin)) {
      throw new Error('Only permissions specified in the manifest may be requested.')
    }
    const newApis = apis.filter((p) => !granted.apis.has(p))
    const newOrigins = origins.filter((o) => !granted.origins.some((g) => patternCovers(g, o)))
    if (newApis.length === 0 && newOrigins.length === 0) return true
    const allowed = await this.host.prompt(extension, { permissions: newApis, origins: newOrigins })
    if (!allowed) return false
    for (const p of newApis) granted.apis.add(p)
    granted.origins.push(...newOrigins)
    this.persistOptional(extension.id)
    this.host.sendEvent(extension.id, 'permissions.onAdded', { permissions: newApis, origins: newOrigins })
    return true
  }

  remove(extension: Electron.Extension, request: chrome.permissions.Permissions) {
    const apis = this.validate(request?.permissions)
    const origins = this.validateOrigins(request?.origins)
    const declared = this.manifests.get(extension.id) ?? readManifestPermissions(extension.manifest)
    if (apis.some((p) => declared.apis.includes(p)) || origins.some((o) => declared.origins.includes(o))) {
      throw new Error('You cannot remove required permissions.')
    }
    const granted = this.ensure(extension)
    const removedApis = apis.filter((p) => granted.apis.delete(p))
    const removedOrigins: string[] = []
    for (const o of origins) {
      const i = granted.origins.indexOf(o)
      if (i >= 0) {
        granted.origins.splice(i, 1)
        removedOrigins.push(o)
      }
    }
    if (removedApis.length || removedOrigins.length) {
      this.persistOptional(extension.id)
      this.host.sendEvent(extension.id, 'permissions.onRemoved', {
        permissions: removedApis,
        origins: removedOrigins,
      })
    }
    return true
  }

  private persistOptional(extensionId: string) {
    const declared = this.manifests.get(extensionId)
    const granted = this.granted.get(extensionId)
    if (!declared || !granted) return
    this.persist(
      extensionId,
      [...granted.apis].filter((p) => !declared.apis.includes(p)),
      granted.origins.filter((o) => !declared.origins.includes(o)),
    )
  }
}
