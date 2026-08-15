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

type OpenCloseOptions = {
  tabId?: number
  windowId?: number
}

type PanelState = {
  global: SidePanelOptions
  tabs: Map<number, Partial<SidePanelOptions>>
  behavior: SidePanelBehavior
}

function normalizePath(p: string) {
  return String(p || '').replace(/^\//, '')
}

export class SidePanelAPI {
  private states = new Map<string, PanelState>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const perm = { permission: 'sidePanel' as chrome.runtime.ManifestPermissions }

    handle('sidePanel.setOptions', this.setOptions, perm)
    handle('sidePanel.getOptions', this.getOptions, perm)
    handle('sidePanel.setPanelBehavior', this.setPanelBehavior, perm)
    handle('sidePanel.getPanelBehavior', this.getPanelBehavior, perm)
    handle('sidePanel.getLayout', this.getLayout, perm)
    handle('sidePanel.open', this.open, perm)
    handle('sidePanel.close', this.close, perm)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions?.().forEach((ext: Electron.Extension) => {
      this.seedFromManifest(ext)
    })
    sessionExtensions.on('extension-loaded', (_e: Electron.Event, ext: Electron.Extension) => {
      this.seedFromManifest(ext)
    })
    sessionExtensions.on('extension-unloaded', (_e: Electron.Event, ext: Electron.Extension) => {
      this.states.delete(ext.id)
    })
  }

  getResolvedOptions(extensionId: string, tabId?: number): SidePanelOptions {
    return this.resolve(this.ensure(extensionId), tabId)
  }

  getResolvedPanelBehavior(extensionId: string): SidePanelBehavior {
    return { ...this.ensure(extensionId).behavior }
  }

  private seedFromManifest(extension: Electron.Extension) {
    const state = this.ensure(extension.id)
    const manifest = getExtensionManifest(extension) as chrome.runtime.Manifest & {
      side_panel?: { default_path?: string }
    }
    const defaultPath = manifest.side_panel?.default_path
    if (typeof defaultPath === 'string' && defaultPath && !state.global.path) {
      state.global.path = normalizePath(defaultPath)
    }
  }

  private ensure(extensionId: string): PanelState {
    let state = this.states.get(extensionId)
    if (!state) {
      state = {
        global: { enabled: true },
        tabs: new Map(),
        behavior: { openPanelOnActionClick: false },
      }
      this.states.set(extensionId, state)
    }
    return state
  }

  private resolve(state: PanelState, tabId?: number): SidePanelOptions {
    const base =
      typeof tabId === 'number' && state.tabs.has(tabId)
        ? { ...state.global, ...state.tabs.get(tabId), tabId }
        : { ...state.global }
    const out: SidePanelOptions = { enabled: base.enabled !== false }
    if (typeof base.path === 'string' && base.path) out.path = base.path
    if (typeof base.tabId === 'number') out.tabId = base.tabId
    return out
  }

  private async validatePath(extension: Electron.Extension, path: string) {
    const normalized = normalizePath(path)
    if (!normalized) throw new Error('Invalid side panel path')
    if (!(await validateExtensionResource(extension, normalized))) {
      throw new Error(`Invalid side panel path: ${normalized}`)
    }
    return normalized
  }

  private setOptions = async (
    { extension }: ExtensionEvent,
    options: chrome.sidePanel.PanelOptions = {},
  ) => {
    if (!options || typeof options !== 'object') {
      throw new Error('Invalid side panel options')
    }

    const state = this.ensure(extension.id)
    const tabId = typeof options.tabId === 'number' ? options.tabId : undefined
    const target: Partial<SidePanelOptions> =
      tabId != null ? { ...(state.tabs.get(tabId) || {}) } : { ...state.global }

    if (typeof options.enabled === 'boolean') target.enabled = options.enabled
    if (typeof options.path === 'string') {
      target.path = await this.validatePath(extension, options.path)
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
  ) => {
    const tabId = typeof options?.tabId === 'number' ? options.tabId : undefined
    return this.resolve(this.ensure(extension.id), tabId)
  }

  private setPanelBehavior = async (
    { extension }: ExtensionEvent,
    behavior: chrome.sidePanel.PanelBehavior = {},
  ) => {
    if (!behavior || typeof behavior !== 'object') {
      throw new Error('Invalid side panel behavior')
    }
    if (typeof behavior.openPanelOnActionClick === 'boolean') {
      this.ensure(extension.id).behavior.openPanelOnActionClick = behavior.openPanelOnActionClick
    }
  }

  private getPanelBehavior = async ({ extension }: ExtensionEvent) => {
    return this.getResolvedPanelBehavior(extension.id)
  }

  private getLayout = async () => ({ side: 'right' as const })

  private resolveOpenContext(options: OpenCloseOptions) {
    const tabId = typeof options.tabId === 'number' ? options.tabId : undefined
    let windowId = typeof options.windowId === 'number' ? options.windowId : undefined

    if (tabId == null && windowId == null) {
      throw new Error('Either tabId or windowId must be provided')
    }

    if (tabId != null) {
      const tab = this.ctx.store.getTabById(tabId)
      if (!tab || tab.isDestroyed()) throw new Error(`No tab with id: ${tabId}`)
      const win = this.ctx.store.tabToWindow.get(tab)
      if (win && !win.isDestroyed()) {
        if (windowId != null && windowId !== win.id) {
          throw new Error('tabId does not belong to windowId')
        }
        windowId = win.id
      }
    } else if (windowId != null) {
      const win = this.ctx.store.getWindowById(windowId)
      if (!win || win.isDestroyed()) throw new Error(`No window with id: ${windowId}`)
    }

    return { tabId, windowId }
  }

  private open = async ({ extension }: ExtensionEvent, options?: OpenCloseOptions) => {
    if (typeof this.ctx.store.impl.openSidePanel !== 'function') {
      throw new Error('sidePanel.open is not implemented')
    }

    const { tabId, windowId } = this.resolveOpenContext(options || {})
    const resolved = this.resolve(this.ensure(extension.id), tabId)
    if (resolved.enabled === false) {
      throw new Error('Side panel is disabled')
    }
    if (!resolved.path) {
      throw new Error('No side panel path configured')
    }
    await this.validatePath(extension, resolved.path)

    await this.ctx.store.impl.openSidePanel({
      extension,
      path: resolved.path,
      tabId,
      windowId,
    })
  }

  private close = async ({ extension }: ExtensionEvent, options?: OpenCloseOptions) => {
    if (typeof this.ctx.store.impl.closeSidePanel !== 'function') {
      throw new Error('sidePanel.close is not implemented')
    }

    const tabId = typeof options?.tabId === 'number' ? options.tabId : undefined
    const windowId = typeof options?.windowId === 'number' ? options.windowId : undefined
    if (tabId == null && windowId == null) {
      throw new Error('Either tabId or windowId must be provided')
    }

    await this.ctx.store.impl.closeSidePanel({
      extension,
      tabId,
      windowId,
    })
  }
}
