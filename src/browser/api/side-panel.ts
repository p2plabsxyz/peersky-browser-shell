import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest, validateExtensionResource } from './common'

export type SidePanelOptions = {
  enabled: boolean
  path?: string
  tabId?: number
}

export type SidePanelBehavior = {
  openPanelOnActionClick: boolean
}

type ExtensionSidePanelState = {
  /** Default options used when a tab has no tab-specific override. */
  global: SidePanelOptions
  /** Partial overrides keyed by tab id. */
  tabs: Map<number, Partial<SidePanelOptions>>
  behavior: SidePanelBehavior
}

function normalizePath(path: string): string {
  return String(path || '').replace(/^\//, '')
}

function cloneOptions(options: SidePanelOptions): SidePanelOptions {
  const out: SidePanelOptions = { enabled: options.enabled !== false }
  if (typeof options.path === 'string' && options.path.length > 0) {
    out.path = options.path
  }
  if (typeof options.tabId === 'number') {
    out.tabId = options.tabId
  }
  return out
}

/**
 * chrome.sidePanel — options / behavior state (open/close host wiring comes later).
 *
 * Spec: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
 */
export class SidePanelAPI {
  private stateByExtension = new Map<string, ExtensionSidePanelState>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const sidePanelPerm = { permission: 'sidePanel' as chrome.runtime.ManifestPermissions }

    handle('sidePanel.setOptions', this.setOptions, sidePanelPerm)
    handle('sidePanel.getOptions', this.getOptions, sidePanelPerm)
    handle('sidePanel.setPanelBehavior', this.setPanelBehavior, sidePanelPerm)
    handle('sidePanel.getPanelBehavior', this.getPanelBehavior, sidePanelPerm)
    // Harmless stub until the shell exposes layout controls.
    handle('sidePanel.getLayout', this.getLayout, sidePanelPerm)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions?.().forEach((extension: Electron.Extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-loaded', (_event: Electron.Event, extension: Electron.Extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event: Electron.Event, extension: Electron.Extension) => {
      this.stateByExtension.delete(extension.id)
    })
  }

  /** Resolved options for host/UI consumers (global + optional tab override). */
  getResolvedOptions(extensionId: string, tabId?: number): SidePanelOptions {
    return this.resolveOptions(this.ensureState(extensionId), tabId)
  }

  /** Panel behavior for host/UI consumers (e.g. toolbar openPanelOnActionClick). */
  getResolvedPanelBehavior(extensionId: string): SidePanelBehavior {
    return { ...this.ensureState(extensionId).behavior }
  }

  private processExtension(extension: Electron.Extension) {
    const state = this.ensureState(extension.id)
    const manifest = getExtensionManifest(extension) as chrome.runtime.Manifest & {
      side_panel?: { default_path?: string }
    }
    const defaultPath = manifest.side_panel?.default_path
    if (typeof defaultPath === 'string' && defaultPath.length > 0 && !state.global.path) {
      state.global.path = normalizePath(defaultPath)
    }
  }

  private ensureState(extensionId: string): ExtensionSidePanelState {
    let state = this.stateByExtension.get(extensionId)
    if (!state) {
      state = {
        global: { enabled: true },
        tabs: new Map(),
        behavior: { openPanelOnActionClick: false },
      }
      this.stateByExtension.set(extensionId, state)
    }
    return state
  }

  private resolveOptions(state: ExtensionSidePanelState, tabId?: number): SidePanelOptions {
    if (typeof tabId === 'number' && state.tabs.has(tabId)) {
      const merged = cloneOptions({
        ...state.global,
        ...state.tabs.get(tabId),
        tabId,
      })
      return merged
    }
    return cloneOptions(state.global)
  }

  private async assertValidPath(extension: Electron.Extension, path: string) {
    const normalized = normalizePath(path)
    if (!normalized) {
      throw new Error('Invalid side panel path')
    }
    const validated = await validateExtensionResource(extension, normalized)
    if (!validated) {
      throw new Error(`Invalid side panel path: ${normalized}`)
    }
    return normalized
  }

  private setOptions = async (
    { extension }: ExtensionEvent,
    options: chrome.sidePanel.PanelOptions = {},
  ): Promise<void> => {
    if (!options || typeof options !== 'object') {
      throw new Error('Invalid side panel options')
    }

    const state = this.ensureState(extension.id)
    const tabId = typeof options.tabId === 'number' ? options.tabId : undefined
    const target: Partial<SidePanelOptions> =
      tabId != null ? { ...(state.tabs.get(tabId) || {}) } : { ...state.global }

    if (typeof options.enabled === 'boolean') {
      target.enabled = options.enabled
    }

    if (typeof options.path === 'string') {
      target.path = await this.assertValidPath(extension, options.path)
    }

    if (tabId != null) {
      state.tabs.set(tabId, target)
    } else {
      state.global = {
        enabled: target.enabled !== false,
        path: typeof target.path === 'string' ? target.path : state.global.path,
      }
    }
  }

  private getOptions = async (
    { extension }: ExtensionEvent,
    options: chrome.sidePanel.GetPanelOptions = {},
  ): Promise<SidePanelOptions> => {
    const state = this.ensureState(extension.id)
    const tabId = typeof options?.tabId === 'number' ? options.tabId : undefined
    return this.resolveOptions(state, tabId)
  }

  private setPanelBehavior = async (
    { extension }: ExtensionEvent,
    behavior: chrome.sidePanel.PanelBehavior = {},
  ): Promise<void> => {
    if (!behavior || typeof behavior !== 'object') {
      throw new Error('Invalid side panel behavior')
    }
    const state = this.ensureState(extension.id)
    if (typeof behavior.openPanelOnActionClick === 'boolean') {
      state.behavior.openPanelOnActionClick = behavior.openPanelOnActionClick
    }
  }

  private getPanelBehavior = async ({
    extension,
  }: ExtensionEvent): Promise<SidePanelBehavior> => {
    return this.getResolvedPanelBehavior(extension.id)
  }

  private getLayout = async (): Promise<{ side: 'left' | 'right' }> => {
    // Peersky docks on the right until a layout preference API exists.
    return { side: 'right' }
  }
}
