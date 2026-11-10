import { dialog } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { KNOWN_PERMISSIONS, readManifestPermissions } from '../permissions'
import { tryParseMatchPattern } from '../match-pattern'
import { getExtensionManifest } from './common'

/** chrome.management.ExtensionInfo, as Chrome 157 gives it. */
export interface ManagementExtensionInfo {
  id: string
  name: string
  shortName: string
  description: string
  version: string
  versionName: string
  enabled: boolean
  disabledReason?: 'unknown' | 'permissions_increase'
  mayDisable: boolean
  mayEnable?: boolean
  isApp: boolean
  type: 'extension' | 'hosted_app' | 'packaged_app' | 'legacy_packaged_app' | 'theme' | 'login_screen_extension'
  installType: string
  optionsUrl: string
  homepageUrl: string
  updateUrl?: string
  offlineEnabled: boolean
  icons?: { size: number; url: string }[]
  permissions: string[]
  hostPermissions: string[]
}

const INSTALL_TYPES = new Set(['admin', 'development', 'normal', 'sideload', 'other'])

/** How the extension was installed: the host says, or 'development' (unpacked). */
export function installTypeOf(ctx: ExtensionContext, extension: Electron.Extension): string {
  try {
    const type = ctx.store.impl.getExtensionInstallType?.(extension)
    if (typeof type === 'string' && INSTALL_TYPES.has(type)) return type
  } catch {}
  return 'development'
}

const notFound = (id: unknown) => new Error(`Failed to find extension with id ${id}.`)
const noSignature = (signature: string) =>
  new Error(`Error in invocation of management.${signature}: No matching signature.`)

// Chrome's ids are 32 letters a-p. Anything else names no extension.
const isExtensionId = (id: unknown): id is string => typeof id === 'string' && id.length <= 256

const extensionType = (manifest: any): ManagementExtensionInfo['type'] => {
  if (manifest.theme) return 'theme'
  if (manifest.app?.background || manifest.app?.launch?.local_path) {
    return manifest.app?.background ? 'packaged_app' : 'legacy_packaged_app'
  }
  if (manifest.app?.launch?.web_url) return 'hosted_app'
  return 'extension'
}

const extensionUrl = (id: string, relative: string) =>
  `chrome-extension://${id}/${String(relative).replace(/^\/+/, '')}`

// ---------------------------------------------------------------- permission warnings
//
// The warnings Chrome shows before installing, in Chrome's order. A rule's
// message shows when one of its permissions is held and no rule that covers it
// shows too.
const FULL_ACCESS = 'Read and change all your data on all websites'
const HISTORY_RW = 'Read and change your browsing history on all your signed-in devices'
const HISTORY_READ = 'Read your browsing history'

interface WarningRule {
  message: string
  any: string[]
  /** Not shown when one of these messages is. */
  coveredBy?: string[]
}

const WARNING_RULES: WarningRule[] = [
  { message: 'Access the page debugger backend', any: ['debugger'] },
  { message: FULL_ACCESS, any: ['<full access>', 'debugger', 'pageCapture', 'proxy', 'tabCapture', 'webAuthenticationProxy'] },
  { message: '<hosts>', any: ['<hosts>'], coveredBy: [FULL_ACCESS] },
  { message: 'Read your accessibility settings', any: ['accessibilityFeatures.read'], coveredBy: ['Read and change your accessibility settings'] },
  { message: 'Change your accessibility settings', any: ['accessibilityFeatures.modify'], coveredBy: ['Read and change your accessibility settings'] },
  { message: 'Detect your physical location', any: ['geolocation'] },
  { message: HISTORY_RW, any: ['history'] },
  {
    message: HISTORY_READ,
    any: ['tabs', 'webNavigation', 'declarativeNetRequestFeedback', 'processes'],
    coveredBy: [HISTORY_RW, FULL_ACCESS],
  },
  {
    message: 'Read a list of your most frequently visited websites',
    any: ['topSites'],
    coveredBy: [HISTORY_RW, HISTORY_READ, FULL_ACCESS],
  },
  {
    message: 'Read the icons of the websites you visit',
    any: ['favicon'],
    coveredBy: [HISTORY_RW, HISTORY_READ, FULL_ACCESS],
  },
  { message: 'Display notifications', any: ['notifications'] },
  { message: 'Read and change your bookmarks', any: ['bookmarks'] },
  { message: 'Read and change entries in the reading list', any: ['readingList'] },
  { message: 'Read and modify data you copy and paste', any: ['<clipboard both>'] },
  { message: 'Read data you copy and paste', any: ['clipboardRead'], coveredBy: ['Read and modify data you copy and paste'] },
  { message: 'Modify data you copy and paste', any: ['clipboardWrite'], coveredBy: ['Read and modify data you copy and paste'] },
  { message: 'Capture content of your screen', any: ['desktopCapture'] },
  { message: 'Manage your downloads', any: ['downloads'] },
  { message: 'Open downloaded files', any: ['downloads.open'] },
  { message: 'Identify and eject storage devices', any: ['system.storage'] },
  {
    message:
      'Change and grant access to features such as geolocation, microphone, camera, cookies, etc., for all your websites and extensions, including this extension.',
    any: ['contentSettings'],
  },
  { message: 'Manage your apps, extensions, and themes', any: ['management'] },
  { message: 'Communicate with cooperating native applications', any: ['nativeMessaging'] },
  { message: 'Change your privacy-related settings', any: ['privacy'] },
  { message: 'View and manage your tab groups', any: ['tabGroups'] },
  { message: 'Block content on any page', any: ['declarativeNetRequest'], coveredBy: [FULL_ACCESS] },
  { message: 'Know your email address', any: ['identity.email'] },
  { message: 'Read all text spoken using synthesized speech', any: ['ttsEngine'] },
]

const ALL_HOSTS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', '*://*/', 'http://*/', 'https://*/'])

/** What a host pattern covers, as Chrome words it, or null for every site. */
const hostLabel = (pattern: string): string | null | undefined => {
  if (ALL_HOSTS.has(pattern)) return null
  const parsed = tryParseMatchPattern(pattern) as any
  if (!parsed) return undefined
  const host: string | undefined = parsed.host
  if (parsed.scheme === 'file' || host === undefined) return undefined
  if (host === '*' || host === '') return null
  if (parsed.matchSubdomains || host.startsWith('*.')) return `all ${host.replace(/^\*\./, '')} sites`
  return host
}

export function permissionWarnings(apis: string[], hostPatterns: string[]): string[] {
  const held = new Set(apis)
  const labels: string[] = []
  for (const pattern of hostPatterns) {
    const label = hostLabel(pattern)
    if (label === null) held.add('<full access>')
    else if (label && !labels.includes(label)) labels.push(label)
  }
  if (labels.length) held.add('<hosts>')
  if (held.has('clipboardRead') && held.has('clipboardWrite')) held.add('<clipboard both>')

  const shown: string[] = []
  for (const rule of WARNING_RULES) {
    if (!rule.any.some((p) => held.has(p))) continue
    if (rule.coveredBy?.some((m) => shown.includes(m))) continue
    let message = rule.message
    if (message === '<hosts>') {
      if (labels.length === 1) message = `Read and change your data on ${labels[0]}`
      else if (labels.length === 2) message = `Read and change your data on ${labels[0]} and ${labels[1]}`
      else if (labels.length === 3)
        message = `Read and change your data on ${labels[0]}, ${labels[1]}, and ${labels[2]}`
      else message = 'Read and change your data on a number of websites'
    }
    if (!shown.includes(message)) shown.push(message)
  }
  return shown
}

/** The kind of error Chrome's JSON reader gives for text that is not JSON. */
const jsonError = (text: string) => {
  let line = 1
  let column = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    column++
    if (c === '\n') {
      line++
      column = 0
      continue
    }
    if (/\s/.test(c)) continue
    for (const word of ['null', 'true', 'false']) {
      if (c === word[0]) {
        for (let j = 1; j < word.length; j++) {
          if (text[i + j] !== word[j]) return `expected ident at line ${line} column ${column + j}`
        }
      }
    }
    return `expected value at line ${line} column ${column}`
  }
  return `EOF while parsing a value at line ${line} column ${column}`
}

// ---------------------------------------------------------------- the API

/** What the shell keeps of an extension it turned off, to report and load it again. */
interface DisabledExtension {
  extension: Electron.Extension
}

export class ManagementAPI {
  /** Extensions turned off with setEnabled in this run, by id. */
  private disabled = new Map<string, DisabledExtension>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    // Every extension may ask about itself, as in Chrome.
    handle('management.getSelf', this.getSelf, { permission: null })
    handle('management.getPermissionWarningsByManifest', this.getPermissionWarningsByManifest, {
      permission: null,
    })
    handle('management.uninstallSelf', this.uninstallSelf, { permission: null })
    handle('management.getAll', this.getAll)
    handle('management.get', this.get)
    handle('management.getPermissionWarningsById', this.getPermissionWarningsById)
    handle('management.setEnabled', this.setEnabled)
    handle('management.uninstall', this.uninstall)
    handle('management.launchApp', this.launchApp)
    handle('management.setLaunchType', this.needsGesture('setLaunchType'))
    handle('management.createAppShortcut', this.needsGesture('createAppShortcut'))
    handle('management.generateAppForLink', this.needsGesture('generateAppForLink'))

    const sessionExtensions = this.getSessionExtensions()
    sessionExtensions.on('extension-loaded', (_event, extension) => {
      // Loaded again by someone else: it is no longer ours to report as off.
      this.disabled.delete(extension.id)
    })
    this.ctx.store.on('extension-installed', (extension: Electron.Extension) => {
      this.notifyOthers(extension.id, 'management.onInstalled', this.toInfo(extension, true))
    })
  }

  private getSessionExtensions() {
    return this.ctx.session.extensions || this.ctx.session
  }

  private getAllExtensions(): Electron.Extension[] {
    const sessionExtensions = this.getSessionExtensions()
    const getAll = (sessionExtensions as any).getAllExtensions
    if (typeof getAll === 'function') {
      return getAll.call(sessionExtensions) || []
    }
    return []
  }

  private find(id: unknown): { extension: Electron.Extension; enabled: boolean } | undefined {
    if (!isExtensionId(id)) return undefined
    const loaded = this.getSessionExtensions().getExtension(id)
    if (loaded) return { extension: loaded, enabled: true }
    const off = this.disabled.get(id)
    return off ? { extension: off.extension, enabled: false } : undefined
  }

  toInfo(extension: Electron.Extension, enabled: boolean): ManagementExtensionInfo {
    const manifest = getExtensionManifest(extension) as any
    const declared = readManifestPermissions(manifest)
    const granted = enabled ? this.ctx.permissions.getAll(extension) : undefined
    const apis = (granted?.permissions ?? declared.apis).filter((p) => KNOWN_PERMISSIONS.has(p))
    const hosts = granted?.origins ?? declared.origins
    const optionsPage = manifest.options_ui?.page || manifest.options_page
    const installType = installTypeOf(this.ctx, extension)
    const type = extensionType(manifest)
    const info: ManagementExtensionInfo = {
      description: typeof manifest.description === 'string' ? manifest.description : '',
      enabled,
      homepageUrl: typeof manifest.homepage_url === 'string' ? manifest.homepage_url : '',
      hostPermissions: [...new Set(hosts)].sort(),
      id: extension.id,
      installType,
      isApp: type !== 'extension' && type !== 'theme' && type !== 'login_screen_extension',
      mayDisable: installType !== 'admin',
      name: extension.name,
      offlineEnabled: manifest.offline_enabled === true,
      optionsUrl: typeof optionsPage === 'string' && optionsPage ? extensionUrl(extension.id, optionsPage) : '',
      permissions: [...new Set(apis)].sort(),
      shortName: typeof manifest.short_name === 'string' ? manifest.short_name : extension.name,
      type,
      version: typeof manifest.version === 'string' ? manifest.version : extension.version,
      versionName: typeof manifest.version_name === 'string' ? manifest.version_name : '',
    }
    if (!enabled) {
      info.disabledReason = 'unknown'
      info.mayEnable = true
    }
    if (manifest.icons && typeof manifest.icons === 'object') {
      const icons = Object.entries(manifest.icons as Record<string, unknown>)
        .map(([size, file]) => ({ size: parseInt(size, 10), file }))
        .filter((i) => Number.isFinite(i.size) && typeof i.file === 'string')
        .sort((a, b) => a.size - b.size)
        .map((i) => ({ size: i.size, url: extensionUrl(extension.id, i.file as string) }))
      if (icons.length) info.icons = icons
    }
    if (typeof manifest.update_url === 'string') info.updateUrl = manifest.update_url
    return info
  }

  /**
   * Sends a management event to every other extension that may see it:
   * only those holding "management" get it, whatever listeners exist.
   */
  private notifyOthers(subjectId: string, eventName: string, ...args: any[]) {
    for (const other of this.getAllExtensions()) {
      if (other.id === subjectId) continue
      if (!this.ctx.permissions.has(other, 'management')) continue
      this.ctx.router.sendEvent(other.id, eventName, ...args)
    }
  }

  private getSelf = ({ extension }: ExtensionEvent) => this.toInfo(extension, true)

  private getAll = () => {
    const loaded = this.getAllExtensions().map((e) => this.toInfo(e, true))
    const off = [...this.disabled.values()].map((d) => this.toInfo(d.extension, false))
    return [...loaded, ...off]
  }

  private get = (_event: ExtensionEvent, id: unknown) => {
    if (typeof id !== 'string') throw noSignature('get(string id, optional function callback)')
    const found = this.find(id)
    if (!found) throw notFound(id)
    return this.toInfo(found.extension, found.enabled)
  }

  private getPermissionWarningsById = (_event: ExtensionEvent, id: unknown) => {
    if (typeof id !== 'string') {
      throw noSignature('getPermissionWarningsById(string id, optional function callback)')
    }
    const found = this.find(id)
    if (!found) throw notFound(id)
    const info = this.toInfo(found.extension, found.enabled)
    const declared = readManifestPermissions(getExtensionManifest(found.extension) as any)
    return permissionWarnings(info.permissions, [...info.hostPermissions, ...declared.contentScriptOrigins])
  }

  private getPermissionWarningsByManifest = (_event: ExtensionEvent, manifestStr: unknown) => {
    if (typeof manifestStr !== 'string') {
      throw noSignature('getPermissionWarningsByManifest(string manifestStr, optional function callback)')
    }
    // A manifest is small; a huge string is refused before it is parsed.
    if (manifestStr.length > 1024 * 1024) throw new Error('Failed to create extension from manifest.')
    let manifest: any
    try {
      manifest = JSON.parse(manifestStr)
    } catch {
      throw new Error(jsonError(manifestStr))
    }
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      typeof manifest.name !== 'string' ||
      typeof manifest.version !== 'string' ||
      !/^\d+(\.\d+){0,3}$/.test(manifest.version) ||
      (manifest.manifest_version !== 2 && manifest.manifest_version !== 3)
    ) {
      throw new Error('Failed to create extension from manifest.')
    }
    const declared = readManifestPermissions(manifest)
    return permissionWarnings(declared.apis, [...declared.origins, ...declared.contentScriptOrigins])
  }

  private launchApp = (_event: ExtensionEvent, id: unknown) => {
    if (typeof id !== 'string') throw noSignature('launchApp(string id, optional function callback)')
    const found = this.find(id)
    if (!found) throw notFound(id)
    // The shell runs extensions only; none of them is an app.
    throw new Error(`Extension ${id} is not an App.`)
  }

  private needsGesture = (method: string) => (event: ExtensionEvent) => {
    if (!event.gesture && !this.ctx.store.hasUserGesture(event.extension.id)) {
      throw new Error(`chrome.management.${method} requires a user gesture.`)
    }
    throw new Error('The launch type is not available for this app.')
  }

  private setEnabled = async (event: ExtensionEvent, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      throw noSignature('setEnabled(string id, boolean enabled, optional function callback)')
    }
    const found = this.find(id)
    if (!found) throw notFound(id)
    if (found.enabled === enabled) return
    const { extension } = found
    if (installTypeOf(this.ctx, extension) === 'admin') {
      throw new Error(`Extension ${id} cannot be modified by user.`)
    }

    const hook = this.ctx.store.impl.setExtensionEnabled
    const sessionExtensions = this.getSessionExtensions()
    if (!enabled) {
      // Taken before it goes, while its grants are still known.
      const info = this.toInfo(extension, false)
      this.disabled.set(id, { extension })
      try {
        if (typeof hook === 'function') await hook({ id, path: extension.path, enabled: false })
        else sessionExtensions.removeExtension(id)
      } catch (error) {
        this.disabled.delete(id)
        throw error
      }
      this.notifyOthers(id, 'management.onDisabled', info)
      return
    }

    if (typeof hook === 'function') await hook({ id, path: extension.path, enabled: true })
    else if (!sessionExtensions.getExtension(id)) await sessionExtensions.loadExtension(extension.path)
    this.disabled.delete(id)
    const loaded = sessionExtensions.getExtension(id) ?? extension
    this.notifyOthers(id, 'management.onEnabled', this.toInfo(loaded, true))
  }

  private async confirm(extension: Electron.Extension, by?: Electron.Extension) {
    const hook = this.ctx.store.impl.confirmUninstall
    if (typeof hook === 'function') return (await hook({ extension, by })) === true
    // The host has no prompt of its own: ask with the system's. Nothing is
    // removed without the person's yes.
    const parent = this.ctx.store.getLastFocusedWindow()
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove "${extension.name}"?`,
      detail: by ? `"${by.name}" would like to remove "${extension.name}".` : undefined,
      noLink: true,
    }
    const { response } =
      parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent as Electron.BaseWindow, options)
        : await dialog.showMessageBox(options)
    return response === 0
  }

  private async remove(extension: Electron.Extension) {
    const hook = this.ctx.store.impl.uninstallExtension
    if (typeof hook === 'function') await hook(extension)
    else this.getSessionExtensions().removeExtension(extension.id)
    this.notifyUninstalled(extension.id)
  }

  /**
   * Tells the shell an extension was removed for good, so it drops what it
   * kept for it (storage, alarms) and fires management.onUninstalled. The
   * host calls this after an uninstall of its own; uninstalls through
   * chrome.management do it already.
   */
  notifyUninstalled(extensionId: string) {
    this.disabled.delete(extensionId)
    this.ctx.store.emit('extension-uninstalled', extensionId)
    this.notifyOthers(extensionId, 'management.onUninstalled', extensionId)
  }

  private uninstall = async (event: ExtensionEvent, id: unknown, options?: unknown) => {
    if (typeof id !== 'string' || (options !== undefined && options !== null && typeof options !== 'object')) {
      throw noSignature('uninstall(string id, optional management.UninstallOptions options, optional function callback)')
    }
    const found = this.find(id)
    if (!found) throw notFound(id)
    if (!event.gesture && !this.ctx.store.hasUserGesture(event.extension.id)) {
      throw new Error('chrome.management.uninstall requires a user gesture.')
    }
    if (installTypeOf(this.ctx, found.extension) === 'admin') {
      throw new Error(`Extension ${id} cannot be modified by user.`)
    }
    const by = found.extension.id === event.extension.id ? undefined : event.extension
    if (!(await this.confirm(found.extension, by))) {
      throw new Error(`Extension ${id} uninstall canceled by user.`)
    }
    await this.remove(found.extension)
  }

  private uninstallSelf = async (event: ExtensionEvent, options?: unknown) => {
    if (options !== undefined && options !== null && typeof options !== 'object') {
      throw noSignature('uninstallSelf(optional management.UninstallOptions options, optional function callback)')
    }
    const { extension } = event
    if ((options as { showConfirmDialog?: unknown } | undefined)?.showConfirmDialog === true) {
      if (!(await this.confirm(extension))) {
        throw new Error(`Extension ${extension.id} uninstall canceled by user.`)
      }
    }
    // Answer first: the caller goes away with the extension.
    setImmediate(() => {
      this.remove(extension).catch((error) => console.error(`Failed to remove ${extension.id}:`, error))
    })
  }
}
