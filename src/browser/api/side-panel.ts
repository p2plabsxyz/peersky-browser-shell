import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { chromeTypeName } from './alarms'
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

type StoredOptions = { enabled?: boolean; path?: string }

type PanelState = {
  global: { enabled: boolean; path?: string }
  /** A tab's own options, which do not take the global path, as in Chrome. */
  tabs: Map<number, StoredOptions>
  behavior: SidePanelBehavior
  /** Panels the host reported open: window id, or `tab:<id>` for a tab's own. */
  open: Map<string, { path: string; tabId?: number; windowId: number }>
}

const MAX_PATH = 2048

const invocationError = (signature: string, detail: string) =>
  new Error(`Error in invocation of sidePanel.${signature}: ${detail}`)

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
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const state of this.states.values()) {
        state.tabs.delete(tabId)
        state.open.delete(`tab:${tabId}`)
      }
    })
  }

  /** The options that apply in a tab: its own, or else the global ones. */
  getResolvedOptions(extensionId: string, tabId?: number): SidePanelOptions {
    const state = this.ensure(extensionId)
    const own = typeof tabId === 'number' ? state.tabs.get(tabId) : undefined
    const path = own?.path ?? state.global.path
    const out: SidePanelOptions = { enabled: (own ? own.enabled : state.global.enabled) !== false }
    if (path) out.path = path
    if (own) out.tabId = tabId
    return out
  }

  getResolvedPanelBehavior(extensionId: string): SidePanelBehavior {
    return { ...this.ensure(extensionId).behavior }
  }

  /**
   * The host opened an extension's side panel from its own UI: fires
   * sidePanel.onOpened, as Chrome does. Opens through sidePanel.open fire it
   * already.
   */
  panelOpened(extensionId: string, info: { windowId: number; tabId?: number; path: string }) {
    const state = this.ensure(extensionId)
    const key = typeof info.tabId === 'number' ? `tab:${info.tabId}` : String(info.windowId)
    state.open.set(key, { ...info })
    const event: Record<string, unknown> = { path: info.path, windowId: info.windowId }
    if (typeof info.tabId === 'number') event.tabId = info.tabId
    this.ctx.router.sendEvent(extensionId, 'sidePanel.onOpened', event)
  }

  /** The host closed an extension's side panel: fires sidePanel.onClosed. */
  panelClosed(extensionId: string, info: { windowId: number; tabId?: number; path?: string }) {
    const state = this.ensure(extensionId)
    const key = typeof info.tabId === 'number' ? `tab:${info.tabId}` : String(info.windowId)
    const was = state.open.get(key)
    state.open.delete(key)
    const event: Record<string, unknown> = { path: info.path ?? was?.path ?? '', windowId: info.windowId }
    if (typeof info.tabId === 'number') event.tabId = info.tabId
    this.ctx.router.sendEvent(extensionId, 'sidePanel.onClosed', event)
  }

  private seedFromManifest(extension: Electron.Extension) {
    const state = this.ensure(extension.id)
    const manifest = getExtensionManifest(extension) as chrome.runtime.Manifest & {
      side_panel?: { default_path?: string }
    }
    const defaultPath = manifest.side_panel?.default_path
    if (typeof defaultPath === 'string' && defaultPath && !state.global.path) {
      state.global.path = defaultPath.slice(0, MAX_PATH)
    }
  }

  private ensure(extensionId: string): PanelState {
    let state = this.states.get(extensionId)
    if (!state) {
      state = {
        global: { enabled: true },
        tabs: new Map(),
        behavior: { openPanelOnActionClick: false },
        open: new Map(),
      }
      this.states.set(extensionId, state)
    }
    return state
  }

  /** A path is a page of the extension; anything that resolves elsewhere is refused. */
  private async validatePath(extension: Electron.Extension, path: string) {
    let url: URL
    try {
      url = new URL(path, `chrome-extension://${extension.id}/`)
    } catch {
      throw new Error(`Invalid side panel path: ${path}`)
    }
    if (url.protocol !== 'chrome-extension:' || url.hostname !== extension.id) {
      throw new Error(`Invalid side panel path: ${path}`)
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!relative || !(await validateExtensionResource(extension, relative))) {
      throw new Error(`Invalid side panel path: ${path}`)
    }
    return relative + url.search + url.hash
  }

  private setOptions = async ({ extension }: ExtensionEvent, options?: unknown) => {
    const signature = 'setOptions(sidePanel.PanelOptions options, optional function callback)'
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw invocationError(signature, 'No matching signature.')
    }
    const o = options as Record<string, unknown>
    const typeError = (key: string, expected: string) =>
      invocationError(
        signature,
        `Error at parameter 'options': Error at property '${key}': Invalid type: expected ${expected}, found ${chromeTypeName(o[key])}.`,
      )
    if (o.path !== undefined && typeof o.path !== 'string') throw typeError('path', 'string')
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw typeError('enabled', 'boolean')
    if (o.tabId !== undefined && !Number.isInteger(o.tabId)) throw typeError('tabId', 'integer')

    // Chrome keeps whatever path it is given; it is checked when the panel opens.
    const state = this.ensure(extension.id)
    const path = typeof o.path === 'string' ? o.path.slice(0, MAX_PATH) : undefined
    if (typeof o.tabId === 'number') {
      // Chrome takes options for a tab that does not exist, and ignores them.
      if (!this.ctx.store.getTabById(o.tabId)) return
      const own = state.tabs.get(o.tabId) || {}
      if (path !== undefined) own.path = path
      if (typeof o.enabled === 'boolean') own.enabled = o.enabled
      state.tabs.set(o.tabId, own)
      return
    }
    if (path !== undefined) state.global.path = path
    if (typeof o.enabled === 'boolean') state.global.enabled = o.enabled
  }

  private getOptions = async ({ extension }: ExtensionEvent, options?: unknown) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw invocationError('getOptions(sidePanel.GetPanelOptions options, optional function callback)', 'No matching signature.')
    }
    const tabId = (options as { tabId?: unknown }).tabId
    const state = this.ensure(extension.id)
    const own = typeof tabId === 'number' ? state.tabs.get(tabId) : undefined
    if (own) {
      const out: Record<string, unknown> = {}
      if (own.enabled !== undefined) out.enabled = own.enabled
      if (own.path !== undefined) out.path = own.path
      out.tabId = tabId
      return out
    }
    const out: Record<string, unknown> = { enabled: state.global.enabled }
    if (state.global.path !== undefined) out.path = state.global.path
    return out
  }

  private setPanelBehavior = async ({ extension }: ExtensionEvent, behavior?: unknown) => {
    const signature = 'setPanelBehavior(sidePanel.PanelBehavior behavior, optional function callback)'
    if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) {
      throw invocationError(signature, 'No matching signature.')
    }
    const value = (behavior as { openPanelOnActionClick?: unknown }).openPanelOnActionClick
    if (value !== undefined && typeof value !== 'boolean') {
      throw invocationError(
        signature,
        `Error at parameter 'behavior': Error at property 'openPanelOnActionClick': Invalid type: expected boolean, found ${chromeTypeName(value)}.`,
      )
    }
    // Chrome sets the whole behavior: a missing value turns it off.
    this.ensure(extension.id).behavior.openPanelOnActionClick = value === true
  }

  private getPanelBehavior = async ({ extension }: ExtensionEvent) => {
    return this.getResolvedPanelBehavior(extension.id)
  }

  private getLayout = async () => ({ side: 'right' as const })

  private resolveOpenContext(method: string, options: unknown) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw invocationError(`${method}(sidePanel.${method === 'open' ? 'OpenOptions' : 'CloseOptions'} options, optional function callback)`, 'No matching signature.')
    }
    const o = options as OpenCloseOptions
    const tabId = typeof o.tabId === 'number' ? o.tabId : undefined
    let windowId = typeof o.windowId === 'number' ? o.windowId : undefined

    if (tabId == null && windowId == null) {
      throw new Error('At least one of `tabId` and `windowId` must be provided')
    }

    if (tabId != null) {
      const tab = this.ctx.store.getTabById(tabId)
      if (!tab || tab.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`)
      const win = this.ctx.store.tabToWindow.get(tab)
      if (windowId != null) {
        // Caller supplied both ids — always validate, even if the tab's window
        // mapping is missing or the window is already destroyed.
        if (!win || win.isDestroyed() || windowId !== win.id) {
          throw new Error('tabId does not belong to windowId')
        }
      }
      if (win && !win.isDestroyed()) {
        windowId = win.id
      }
    } else if (windowId != null) {
      const win = this.ctx.store.getWindowById(windowId)
      if (!win || win.isDestroyed()) throw new Error(`No window with id: ${windowId}.`)
    }

    return { tabId, windowId }
  }

  private open = async (event: ExtensionEvent, options?: unknown) => {
    const { extension } = event
    if (!event.gesture && !this.ctx.store.hasUserGesture(extension.id)) {
      throw new Error('`sidePanel.open()` may only be called in response to a user gesture.')
    }

    const { tabId, windowId } = this.resolveOpenContext('open', options)
    const resolved = this.getResolvedOptions(extension.id, tabId)
    if (resolved.enabled === false) {
      throw new Error('Side panel is disabled')
    }
    if (!resolved.path) {
      throw new Error('No side panel path configured')
    }
    const path = await this.validatePath(extension, resolved.path)

    const hook = this.ctx.store.impl.openSidePanel
    if (typeof hook === 'function') {
      await hook({ extension, path, tabId, windowId })
    } else {
      // Without a side panel in the host, the panel opens as a tab, so the
      // person still gets what they asked for.
      await this.ctx.store.createTab({
        url: `chrome-extension://${extension.id}/${path}`,
        active: true,
        windowId,
      })
    }
    this.panelOpened(extension.id, { windowId: windowId ?? -1, tabId, path })
  }

  private close = async ({ extension }: ExtensionEvent, options?: unknown) => {
    const { tabId, windowId } = this.resolveOpenContext('close', options)
    const state = this.ensure(extension.id)
    const hook = this.ctx.store.impl.closeSidePanel
    if (typeof hook === 'function') {
      await hook({ extension, tabId, windowId })
    } else if (typeof tabId === 'number' && !state.open.has(`tab:${tabId}`)) {
      throw new Error(`No active tab-specific side panel for tabId: ${tabId}`)
    }
    const key = typeof tabId === 'number' ? `tab:${tabId}` : String(windowId)
    if (state.open.has(key) || typeof hook === 'function') {
      this.panelClosed(extension.id, { windowId: windowId ?? -1, tabId })
    }
  }
}
