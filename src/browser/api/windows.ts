import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import {
  checkProps,
  fits,
  noWindowError,
  oneOf,
  prepareNavigationUrl,
  signatureError,
  tabApis,
  TabsAPI,
} from './tabs'
import debug from 'debug'

const d = debug('electron-chrome-extensions:windows')

export type WindowDetails = chrome.windows.Window

type WindowType = 'normal' | 'popup' | 'panel' | 'app' | 'devtools'

const WINDOW_TYPES = ['normal', 'popup', 'panel', 'app', 'devtools', 'custom-tab'] as const
const CREATE_TYPES = ['normal', 'popup', 'panel'] as const
const WINDOW_STATES = ['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen'] as const
const INVALID_STATE = 'Invalid value for state'
const MAX_URLS = 500

const SIG = {
  get: 'windows.get(integer windowId, optional object queryOptions, optional function callback)',
  getCurrent: 'windows.getCurrent(optional object queryOptions, optional function callback)',
  getLastFocused: 'windows.getLastFocused(optional object queryOptions, optional function callback)',
  getAll: 'windows.getAll(optional object queryOptions, optional function callback)',
  create: 'windows.create(optional object createData, optional function callback)',
  update: 'windows.update(integer windowId, object updateInfo, optional function callback)',
  remove: 'windows.remove(integer windowId, optional function callback)',
}

const getWindowState = (win: Electron.BaseWindow): chrome.windows.Window['state'] => {
  if (win.isFullScreen()) return 'fullscreen'
  if (win.isMinimized()) return 'minimized'
  if (win.isMaximized()) return 'maximized'
  return 'normal'
}

const windowTypesRule = (v: unknown) => {
  if (!Array.isArray(v)) return `Invalid type: expected array, found ${v === null ? 'null' : typeof v}.`
  for (let i = 0; i < v.length; i++) {
    if (!WINDOW_TYPES.includes(v[i])) return `Error at index ${i}: ${oneOf(WINDOW_TYPES)}`
  }
  return undefined
}

const QUERY_RULES = { populate: 'boolean', windowTypes: windowTypesRule } as const

export class WindowsAPI {
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  private observed = new Map<number, Electron.BaseWindow>()
  private types = new Map<number, WindowType>()
  private closing = new Set<number>()
  /** The last known details of each window, for after it is gone. */
  private lastDetails = new Map<number, WindowDetails>()
  /** The type windows.create asked for, until the host adds that window. */
  private nextType?: WindowType
  private focusedId = WindowsAPI.WINDOW_ID_NONE
  /** Window ids, most recently focused last. */
  private focusOrder: number[] = []
  private boundsTimers = new Map<number, ReturnType<typeof setTimeout>>()

  constructor(private ctx: ExtensionContext) {
    tabApis(ctx).windows = this
    const handle = this.ctx.router.apiHandler()
    handle('windows.get', this.get.bind(this))
    // windows.getCurrent returns the window associated with the calling context;
    // windows.getLastFocused always returns the OS-focused window.
    handle('windows.getCurrent', this.getCurrent.bind(this))
    handle('windows.getLastFocused', this.getLastFocused.bind(this))
    handle('windows.getAll', this.getAll.bind(this))
    handle('windows.create', this.create.bind(this))
    handle('windows.update', this.update.bind(this))
    handle('windows.remove', this.remove.bind(this))

    this.ctx.store.on('window-added', this.observeWindow.bind(this))
  }

  private tabs(): TabsAPI | undefined {
    return tabApis(this.ctx).tabs
  }

  private observeWindow(win: Electron.BaseWindow) {
    const windowId = win.id
    if (this.observed.has(windowId)) return
    this.observed.set(windowId, win)
    this.closing.delete(windowId)
    if (!this.types.has(windowId)) this.types.set(windowId, this.nextType ?? 'normal')
    this.nextType = undefined

    win.on('focus', () => this.onFocusChanged(windowId))
    win.on('blur', () => {
      // Focus may be moving to another of our windows, which says so itself.
      setTimeout(() => {
        const anyFocused = [...this.observed.values()].some((w) => !w.isDestroyed() && w.isFocused())
        if (!anyFocused) this.onFocusChanged(WindowsAPI.WINDOW_ID_NONE)
      }, 50)
    })
    const boundsChanged = () => {
      clearTimeout(this.boundsTimers.get(windowId))
      this.boundsTimers.set(
        windowId,
        setTimeout(() => {
          this.boundsTimers.delete(windowId)
          this.onBoundsChanged(windowId)
        }, 100),
      )
    }
    win.on('resize', boundsChanged)
    win.on('move', boundsChanged)
    win.on('close', () => this.markClosing(win))
    win.once('closed', () => this.onClosed(windowId, win))

    this.remember(win)
    this.ctx.router.broadcastEvent('windows.onCreated', this.windowFor(undefined, win))
    d(`Observing window[${windowId}]`)
  }

  private remember(win: Electron.BaseWindow) {
    if (win.isDestroyed()) return
    this.lastDetails.set(win.id, this.windowFor(undefined, win))
  }

  private onClosed(windowId: number, win: Electron.BaseWindow) {
    if (!this.observed.delete(windowId)) return
    // Tabs a host removes after the window is gone still count as closing with it.
    this.closing.add(windowId)
    setTimeout(() => this.closing.delete(windowId), 5000)
    clearTimeout(this.boundsTimers.get(windowId))
    this.boundsTimers.delete(windowId)
    // The window is gone: drop it without asking the host to close it again.
    this.ctx.store.windows.delete(win)

    const details = this.lastDetails.get(windowId)
    this.lastDetails.delete(windowId)
    this.types.delete(windowId)
    tabApis(this.ctx).sessions?.windowClosed(windowId, details)
    this.tabs()?.forgetWindow(windowId)

    this.focusOrder = this.focusOrder.filter((id) => id !== windowId)
    if (this.ctx.store.lastFocusedWindowId === windowId) {
      const next = [...this.focusOrder].reverse().find((id) => this.ctx.store.getWindowById(id))
      const fallback = next ?? [...this.ctx.store.windows].find((w) => !w.isDestroyed())?.id
      this.ctx.store.lastFocusedWindowId = fallback
    }
    if (this.focusedId === windowId) this.focusedId = WindowsAPI.WINDOW_ID_NONE

    this.ctx.router.broadcastEvent('windows.onRemoved', windowId)
  }

  /** A close can be called off (a page may ask to stay), so the mark does not last. */
  private markClosing(win: Electron.BaseWindow) {
    this.closing.add(win.id)
    setTimeout(() => {
      if (!win.isDestroyed()) this.closing.delete(win.id)
    }, 2000)
  }

  /** Whether a window is closing, so its tabs close with it. */
  isClosing(windowId: number) {
    if (this.closing.has(windowId)) return true
    const win = this.observed.get(windowId)
    return !!win && win.isDestroyed()
  }

  typeOf(win: Electron.BaseWindow): WindowType {
    return this.types.get(win.id) ?? 'normal'
  }

  /** The normal window focused most recently, where tabs go when asked for elsewhere. */
  lastNormalWindow(): Electron.BaseWindow | undefined {
    const store = this.ctx.store
    const last = store.getLastFocusedWindow()
    if (last && this.typeOf(last) === 'normal') return last
    for (const id of [...this.focusOrder].reverse()) {
      const win = store.getWindowById(id)
      if (win && this.typeOf(win) === 'normal') return win
    }
    return [...store.windows].find((w) => !w.isDestroyed() && this.typeOf(w) === 'normal')
  }

  /** A window as an extension sees it; with populate, its tabs too. */
  windowFor(extension: Electron.Extension | undefined, win: Electron.BaseWindow, opts: { populate?: boolean } = {}) {
    const bounds = win.getBounds()
    const details: WindowDetails = {
      alwaysOnTop: win.isAlwaysOnTop(),
      focused: win.isFocused(),
      height: bounds.height,
      id: win.id,
      incognito: !this.ctx.session.isPersistent(),
      left: bounds.x,
      state: getWindowState(win),
      top: bounds.y,
      type: this.typeOf(win) as chrome.windows.Window['type'],
      width: bounds.width,
    }
    if (opts.populate) details.tabs = this.tabs()?.windowTabsFor(extension, win) ?? []
    return details
  }

  private window(event: ExtensionEvent, windowId: number) {
    if (windowId === WindowsAPI.WINDOW_ID_CURRENT) {
      const win = this.tabs()?.currentWindow(event)
      if (!win) throw new Error('No current window')
      return win
    }
    const win = this.ctx.store.getWindowById(windowId)
    if (!win) throw noWindowError(windowId)
    return win
  }

  private readQuery(signature: string, queryOptions: unknown) {
    return checkProps(signature, 'queryOptions', queryOptions, QUERY_RULES, { optional: true }) as {
      populate?: boolean
      windowTypes?: string[]
    }
  }

  private get(event: ExtensionEvent, windowId: unknown, queryOptions?: unknown) {
    if (!Number.isSafeInteger(windowId)) throw signatureError(SIG.get)
    const opts = this.readQuery(SIG.get, queryOptions)
    const win = this.window(event, windowId as number)
    if (opts.windowTypes && !opts.windowTypes.includes(this.typeOf(win))) throw noWindowError(windowId)
    return this.windowFor(event.extension as Electron.Extension, win, opts)
  }

  // windows.getCurrent: the window that holds the calling code. For code run
  // after a toolbar click, the window that was clicked in.
  private getCurrent(event: ExtensionEvent, queryOptions?: unknown) {
    const opts = this.readQuery(SIG.getCurrent, queryOptions)
    const win = this.tabs()?.currentWindow(event)
    if (!win) throw new Error('No current window')
    return this.windowFor(event.extension as Electron.Extension, win, opts)
  }

  private getLastFocused(event: ExtensionEvent, queryOptions?: unknown) {
    const opts = this.readQuery(SIG.getLastFocused, queryOptions)
    const types = opts.windowTypes ?? ['normal', 'popup']
    const last = this.ctx.store.getLastFocusedWindow()
    let win = last && types.includes(this.typeOf(last)) ? last : undefined
    if (!win) {
      for (const id of [...this.focusOrder].reverse()) {
        const candidate = this.ctx.store.getWindowById(id)
        if (candidate && types.includes(this.typeOf(candidate))) {
          win = candidate
          break
        }
      }
    }
    if (!win) win = [...this.ctx.store.windows].find((w) => !w.isDestroyed() && types.includes(this.typeOf(w)))
    if (!win) throw new Error('No last-focused window')
    return this.windowFor(event.extension as Electron.Extension, win, opts)
  }

  private getAll(event: ExtensionEvent, queryOptions?: unknown) {
    const opts = this.readQuery(SIG.getAll, queryOptions)
    // Chrome leaves out app and devtools windows unless asked for them.
    const types = opts.windowTypes ?? ['normal', 'popup']
    return Array.from(this.ctx.store.windows)
      .filter((win) => !win.isDestroyed() && types.includes(this.typeOf(win)))
      .map((win) => this.windowFor(event.extension as Electron.Extension, win, opts))
  }

  private async create(event: ExtensionEvent, createData?: unknown) {
    const data = checkProps(
      SIG.create,
      'createData',
      createData,
      {
        url: (v) =>
          typeof v === 'string' || (Array.isArray(v) && v.every((u) => typeof u === 'string'))
            ? undefined
            : 'Value did not match any choice.',
        tabId: 'integer',
        left: 'integer',
        top: 'integer',
        width: 'integer',
        height: 'integer',
        focused: 'boolean',
        incognito: 'boolean',
        type: CREATE_TYPES,
        state: WINDOW_STATES,
        setSelfAsOpener: 'boolean',
      },
      { optional: true },
    )
    const extension = event.extension as Electron.Extension
    const rawUrls: string[] = data.url === undefined ? [] : Array.isArray(data.url) ? data.url : [data.url]
    if (rawUrls.length > MAX_URLS) throw signatureError(SIG.create)
    const urls = rawUrls.map((u) => prepareNavigationUrl(u, extension, this.ctx.permissions))

    const hasBounds = ['left', 'top', 'width', 'height'].some((k) => data[k] !== undefined)
    switch (data.state) {
      case 'minimized':
        if (data.focused === true || hasBounds) throw new Error(INVALID_STATE)
        break
      case 'maximized':
      case 'fullscreen':
      case 'locked-fullscreen':
        if (data.focused === false || hasBounds) throw new Error(INVALID_STATE)
        break
    }
    // A private window lives in another session, which this one cannot open.
    if (data.incognito === true && this.ctx.session.isPersistent()) {
      throw new Error('Incognito mode is disabled.')
    }
    if (typeof data.tabId === 'number' && !this.tabs()?.getTab(data.tabId)) {
      throw new Error(`No tab with id: ${data.tabId}.`)
    }

    // Chrome opens a panel as a popup.
    const type: WindowType = data.type === 'popup' || data.type === 'panel' ? 'popup' : 'normal'
    const win = await this.createWindow(event, {
      ...data,
      type,
      url: urls.length ? urls : undefined,
      width: clampSize(data.width),
      height: clampSize(data.height),
    } as chrome.windows.CreateData)
    if (data.state && data.state !== 'normal') this.applyState(win, data.state)

    this.remember(win)
    return this.windowFor(extension, win, { populate: true })
  }

  /** Opens a window through the host; sessions.restore opens closed windows this way too. */
  async createWindow(event: ExtensionEvent, details: chrome.windows.CreateData) {
    const type = (details.type === 'popup' || details.type === 'panel' ? 'popup' : 'normal') as WindowType
    this.nextType = type
    let win: Electron.BaseWindow
    try {
      win = await this.ctx.store.createWindow(event, details)
    } finally {
      this.nextType = undefined
    }
    this.types.set(win.id, type)
    // The host may have started loading before it told us about the tabs.
    const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : []
    const tabs = this.tabs()
    tabs?.windowTabs(win).forEach((tab, i) => {
      const url = urls[i]
      if (url && tab.isLoading() && tab.getURL() !== url) tabs.notePendingUrl(tab, url)
    })
    return win
  }

  private applyState(win: Electron.BaseWindow, state: string) {
    switch (state) {
      case 'minimized':
        win.minimize()
        break
      case 'maximized':
        if (win.isFullScreen()) win.setFullScreen(false)
        win.maximize()
        break
      case 'fullscreen':
      case 'locked-fullscreen':
        win.setFullScreen(true)
        break
      case 'normal':
        if (win.isFullScreen()) win.setFullScreen(false)
        if (win.isMinimized()) win.restore()
        if (win.isMaximized()) win.unmaximize()
        break
    }
  }

  private async update(event: ExtensionEvent, windowId: unknown, updateInfo?: unknown) {
    if (!Number.isSafeInteger(windowId)) throw signatureError(SIG.update)
    const info = checkProps(SIG.update, 'updateInfo', updateInfo, {
      left: 'integer',
      top: 'integer',
      width: 'integer',
      height: 'integer',
      focused: 'boolean',
      drawAttention: 'boolean',
      state: WINDOW_STATES,
    })
    const win = this.window(event, windowId as number)

    const hasBounds = ['left', 'top', 'width', 'height'].some((k) => info[k] !== undefined)
    const state = info.state as string | undefined
    if (state && state !== 'normal' && hasBounds) throw new Error(INVALID_STATE)
    if (info.focused === true && state === 'minimized') throw new Error(INVALID_STATE)
    if (info.focused === false && (state === 'maximized' || state === 'fullscreen' || state === 'locked-fullscreen')) {
      throw new Error(INVALID_STATE)
    }

    if (state) this.applyState(win, state)
    if (hasBounds) {
      const bounds = win.getBounds()
      win.setBounds({
        x: info.left ?? bounds.x,
        y: info.top ?? bounds.y,
        width: clampSize(info.width) ?? bounds.width,
        height: clampSize(info.height) ?? bounds.height,
      })
    }
    if (info.focused === true) {
      win.focus()
      this.onFocusChanged(win.id)
    } else if (info.focused === false) {
      win.blur()
    }
    if (typeof info.drawAttention === 'boolean') win.flashFrame(info.drawAttention)

    this.remember(win)
    return this.windowFor(event.extension as Electron.Extension, win)
  }

  private async remove(event: ExtensionEvent, windowId: unknown) {
    if (!Number.isSafeInteger(windowId)) throw signatureError(SIG.remove)
    const win = this.window(event, windowId as number)
    this.markClosing(win)
    if (this.ctx.store.windows.has(win)) {
      await this.ctx.store.removeWindow(win)
    } else if (typeof this.ctx.store.impl.removeWindow === 'function') {
      await this.ctx.store.impl.removeWindow(win)
    } else if (!win.isDestroyed()) {
      win.destroy()
    }
  }

  onFocusChanged(windowId: number) {
    if (this.focusedId === windowId) return
    this.focusedId = windowId
    if (windowId !== WindowsAPI.WINDOW_ID_NONE) {
      this.ctx.store.lastFocusedWindowId = windowId
      this.focusOrder = [...this.focusOrder.filter((id) => id !== windowId), windowId]
    }
    this.ctx.router.broadcastEvent('windows.onFocusChanged', windowId)
  }

  onBoundsChanged(windowId: number) {
    const win = this.ctx.store.getWindowById(windowId) ?? this.observed.get(windowId)
    if (!win || win.isDestroyed()) return
    this.remember(win)
    this.ctx.router.broadcastEvent('windows.onBoundsChanged', this.windowFor(undefined, win))
  }
}

/** Window sizes an extension asks for, kept to what a screen can hold. */
function clampSize(value: unknown): number | undefined {
  if (!fits(value, 'integer')) return undefined
  return Math.max(1, Math.min(value as number, 100_000))
}
