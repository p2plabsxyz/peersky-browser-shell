import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'

/** Chrome management.ExtensionInfo-compatible shape returned to extensions. */
export interface ManagementExtensionInfo {
  id: string
  name: string
  shortName?: string
  description?: string
  version: string
  versionName?: string
  enabled: boolean
  type: 'extension' | 'hosted_app' | 'packaged_app' | 'theme' | 'login_screen_extension'
  installType?: string
  optionsUrl?: string
  homepageUrl?: string
  updateUrl?: string
  offlineEnabled?: boolean
}

function extensionToInfo(extension: Electron.Extension): ManagementExtensionInfo {
  const manifest = getExtensionManifest(extension)
  const optionsPage =
    (manifest as chrome.runtime.ManifestV2).options_page ||
    (manifest as chrome.runtime.ManifestV3).options_ui?.page
  const optionsUrl = optionsPage ? `${extension.url.replace(/\/$/, '')}/${optionsPage.replace(/^\//, '')}` : undefined
  return {
    id: extension.id,
    name: extension.name,
    shortName: (manifest as any).short_name,
    description: manifest.description,
    version: manifest.version || '0.0.0',
    versionName: (manifest as any).version_name,
    enabled: true,
    type: 'extension',
    installType: 'normal',
    optionsUrl,
    homepageUrl: (manifest as any).homepage_url,
    updateUrl: (manifest as any).update_url,
    offlineEnabled: (manifest as any).offline_enabled,
  }
}

export class ManagementAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('management.getSelf', this.getSelf)
    handle('management.getAll', this.getAll)
    handle('management.get', this.get)
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

  private getSelf = ({ extension }: ExtensionEvent): ManagementExtensionInfo | undefined => {
    if (!extension) return undefined
    return extensionToInfo(extension)
  }

  private getAll = (_event: ExtensionEvent): ManagementExtensionInfo[] => {
    return this.getAllExtensions().map(extensionToInfo)
  }

  private get = (_event: ExtensionEvent, id: string): ManagementExtensionInfo | undefined => {
    const sessionExtensions = this.getSessionExtensions()
    const extension = sessionExtensions.getExtension(id)
    if (!extension) return undefined
    return extensionToInfo(extension)
  }
}
