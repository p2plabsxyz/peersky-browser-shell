import { Menu, MenuItem, protocol, nativeImage, app } from 'electron'
import { promises as fs } from 'node:fs'
import { ExtensionContext } from '../context'
import { PopupView } from '../popup'
import { ExtensionEvent } from '../router'
import {
  getExtensionUrl,
  getExtensionManifest,
  getIconPath,
  resolveExtensionPath,
  matchSize,
  ResizeType,
} from './common'
import debug from 'debug'
import { noteInvocation, tabForExtension } from '../invocation'

const d = debug('electron-chrome-extensions:browserAction')

if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([{ scheme: 'crx', privileges: { bypassCSP: true } }])
}

type ColorArray = [number, number, number, number]

interface ExtensionAction {
  /** Badge background, as Chrome's ColorArray. */
  color?: ColorArray
  textColor?: ColorArray
  text?: string
  title?: string
  icon?: chrome.browserAction.TabIconDetails
  /** The popup's full URL, or '' for none. */
  popup?: string
  enabled?: boolean
  /** Last modified date for icon. */
  iconModified?: number
}

type ExtensionActionKey = keyof ExtensionAction

const NO_COLOR: ColorArray = [0, 0, 0, 0]
const MAX_ICON_BYTES = 8 * 1024 * 1024
const MAX_ICON_SIDE = 1024
const MAX_TEXT = 1000

// The named colours CSS knows, which Chrome's colour parser accepts.
const NAMED_COLORS: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
  beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
  blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
  chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
  darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b',
  darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000',
  darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493',
  deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222',
  floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff',
  gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f', grey: '808080',
  honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0',
  khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd',
  lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2',
  lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6',
  magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd',
  mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee',
  mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970',
  mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
  oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500',
  orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee',
  palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb',
  plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000',
  rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460',
  seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb',
  slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f',
  steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347',
  turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5',
  yellow: 'ffff00', yellowgreen: '9acd32',
}

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const hue = (((h % 360) + 360) % 360) / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((c) => Math.round(c * 255)) as [
    number,
    number,
    number,
  ]
}

/**
 * Parses a colour the way Chrome's action API does: #rgb, #rgba, #rrggbb,
 * #rrggbbaa, rgb(), rgba(), hsl(), hsla() and the CSS colour names.
 * Anything else is refused with Chrome's message.
 */
export function parseCssColor(input: string): ColorArray {
  const fail = () => new Error('The color specification could not be parsed.')
  if (input.length > 64) throw fail()
  const named = NAMED_COLORS[input.toLowerCase()]
  const value = named ? `#${named}` : input
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (!/^[0-9a-f]+$/i.test(hex) || ![3, 4, 6, 8].includes(hex.length)) throw fail()
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    const bytes = full.match(/../g)!.map((b) => parseInt(b, 16))
    return [bytes[0], bytes[1], bytes[2], bytes.length === 4 ? bytes[3] : 255]
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/i.exec(value)
  if (!fn) throw fail()
  const kind = fn[1].toLowerCase()
  const args = fn[2].split(',').map((a) => a.trim())
  const hasAlpha = kind.endsWith('a')
  if (args.length !== (hasAlpha ? 4 : 3)) throw fail()
  let alpha = 255
  if (hasAlpha) {
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(args[3])) throw fail()
    const a = parseFloat(args[3])
    if (a < 0 || a > 1) throw fail()
    alpha = Math.floor(a * 255)
  }
  if (kind.startsWith('rgb')) {
    const rgb = args.slice(0, 3).map((a) => (/^\d+$/.test(a) ? parseInt(a, 10) : NaN))
    if (rgb.some((c) => !(c >= 0 && c <= 255))) throw fail()
    return [rgb[0], rgb[1], rgb[2], alpha]
  }
  const h = /^-?\d+(\.\d*)?$/.test(args[0]) ? parseFloat(args[0]) : NaN
  const pct = (a: string) => (/^\d+(\.\d*)?%$/.test(a) ? parseFloat(a) / 100 : NaN)
  const sat = pct(args[1])
  const light = pct(args[2])
  if (!Number.isFinite(h) || !(sat >= 0 && sat <= 1) || !(light >= 0 && light <= 1)) throw fail()
  const [r, g, b] = hslToRgb(h, sat, light)
  return [r, g, b, alpha]
}

const invocationError = (method: string, signature: string, detail: string) =>
  new Error(`Error in invocation of action.${method}(${signature}): ${detail}`)

const typeName = (value: unknown) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/** Reads a colour argument as Chrome's bindings and the API do. */
function readColor(method: string, color: unknown): ColorArray {
  const sig = 'object details, optional function callback'
  if (color === undefined) {
    throw invocationError(method, sig, "Error at parameter 'details': Missing required property 'color'.")
  }
  if (typeof color === 'string') return parseCssColor(color)
  if (Array.isArray(color)) {
    if (color.length === 4 && color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
      return color.slice() as ColorArray
    }
    throw invocationError(method, sig, "Error at parameter 'details': Error at property 'color': Value did not match any choice.")
  }
  throw invocationError(
    method,
    sig,
    `Error at parameter 'details': Error at property 'color': Invalid type: expected [string|extensionTypes.ColorArray], found ${typeName(color)}.`,
  )
}

const cssColor = (color?: ColorArray) =>
  color ? `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(color[3] / 255).toFixed(3)})` : undefined

interface ActivateDetails {
  eventType: string
  extensionId: string
  tabId: number
  anchorRect: { x: number; y: number; width: number; height: number }
  alignment?: string
}

const getBrowserActionDefaults = (extension: Electron.Extension): ExtensionAction | undefined => {
  const manifest = getExtensionManifest(extension)
  const browserAction =
    manifest.manifest_version === 3
      ? manifest.action
      : manifest.manifest_version === 2
        ? manifest.browser_action
        : undefined
  if (typeof browserAction === 'object') {
    const manifestAction: chrome.runtime.ManifestAction = browserAction
    const action: ExtensionAction = {}

    action.title = typeof manifestAction.default_title === 'string' ? manifestAction.default_title : ''

    const iconPath = getIconPath(extension)
    if (iconPath) action.icon = { path: iconPath }

    action.popup = manifestAction.default_popup
      ? resolvePopupUrl(extension.id, manifestAction.default_popup) ?? ''
      : ''

    return action
  }
}

/**
 * A popup is a page of the extension itself. A path resolves against the
 * extension's root; anything that lands elsewhere is refused.
 */
const resolvePopupUrl = (extensionId: string, popup: string): string | undefined => {
  const base = `chrome-extension://${extensionId}/`
  try {
    const url = new URL(popup, base)
    if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId) return undefined
    return url.href
  } catch {
    return undefined
  }
}

interface ExtensionActionStore extends Partial<ExtensionAction> {
  tabs: { [key: string]: ExtensionAction }
}

export class BrowserActionAPI {
  private actionMap = new Map</* extensionId */ string, ExtensionActionStore>()
  private popup?: PopupView

  private observers: Set<Electron.WebContents> = new Set()
  private queuedUpdate: boolean = false

  /** When declarativeContent last changed an action on a tab, so the toolbar refetches its icon. */
  private declarativeChangedAt = new Map<string, number>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    // The action needs no permission, only its manifest key.
    const opts = { permission: null }

    // declarativeContent changed what the action shows on a tab.
    this.ctx.store.on('declarative-action-changed', (extensionId: string, tabId: number) => {
      this.declarativeChangedAt.set(`${extensionId}:${tabId}`, Date.now())
      this.onUpdate()
    })

    const TAB_DETAILS = 'action.TabDetails details, optional function callback'

    /** The tab a call names, which must exist, or undefined for the global value. */
    const tabOf = (details: unknown): number | undefined => {
      const tabId = (details as { tabId?: unknown } | undefined)?.tabId
      if (tabId === undefined || tabId === null) return undefined
      if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) {
        throw new Error(`No tab with id: ${tabId}.`)
      }
      if (!this.ctx.store.getTabById(tabId)) throw new Error(`No tab with id: ${tabId}.`)
      return tabId
    }

    const read = (extensionId: string, tabId: number | undefined, key: ExtensionActionKey) => {
      const action = this.getAction(extensionId)
      const tabValue = tabId !== undefined ? action.tabs[tabId]?.[key] : undefined
      return tabValue !== undefined ? tabValue : action[key]
    }

    const write = (extensionId: string, tabId: number | undefined, values: Partial<ExtensionAction>) => {
      const action = this.getAction(extensionId)
      const target = tabId !== undefined ? action.tabs[tabId] || (action.tabs[tabId] = {}) : action
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete (target as any)[key]
        else (target as any)[key] = value
      }
      this.onUpdate()
    }

    const getter =
      (method: string, key: ExtensionActionKey, fallback: unknown) =>
      ({ extension }: ExtensionEvent, details?: unknown) => {
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
          throw invocationError(method, TAB_DETAILS, 'No matching signature.')
        }
        const value = read(extension.id, tabOf(details), key)
        return value === undefined ? fallback : Array.isArray(value) ? value.slice() : value
      }

    const detailsOf = (method: string, details: unknown) => {
      if (!details || typeof details !== 'object' || Array.isArray(details)) {
        throw invocationError(method, 'object details, optional function callback', 'No matching signature.')
      }
      return details as Record<string, unknown>
    }

    handle('browserAction.getTitle', getter('getTitle', 'title', ''), opts)
    handle(
      'browserAction.setTitle',
      ({ extension }: ExtensionEvent, raw?: unknown) => {
        const details = detailsOf('setTitle', raw)
        if (typeof details.title !== 'string') {
          throw invocationError(
            'setTitle',
            'object details, optional function callback',
            details.title === undefined
              ? "Error at parameter 'details': Missing required property 'title'."
              : `Error at parameter 'details': Error at property 'title': Invalid type: expected string, found ${typeName(details.title)}.`,
          )
        }
        write(extension.id, tabOf(details), { title: details.title.slice(0, MAX_TEXT) })
      },
      opts,
    )

    handle('browserAction.getBadgeText', getter('getBadgeText', 'text', ''), opts)
    handle(
      'browserAction.setBadgeText',
      ({ extension }: ExtensionEvent, raw?: unknown) => {
        const details = detailsOf('setBadgeText', raw)
        const text = details.text
        if (text !== undefined && text !== null && typeof text !== 'string') {
          throw invocationError(
            'setBadgeText',
            'object details, optional function callback',
            `Error at parameter 'details': Error at property 'text': Invalid type: expected string, found ${typeName(text)}.`,
          )
        }
        const tabId = tabOf(details)
        // No text clears a tab's own text, so the global one shows again.
        write(extension.id, tabId, {
          text: typeof text === 'string' ? text.slice(0, MAX_TEXT) : tabId !== undefined ? undefined : '',
        })
      },
      opts,
    )

    handle('browserAction.getBadgeBackgroundColor', getter('getBadgeBackgroundColor', 'color', NO_COLOR), opts)
    handle(
      'browserAction.setBadgeBackgroundColor',
      ({ extension }: ExtensionEvent, raw?: unknown) => {
        const details = detailsOf('setBadgeBackgroundColor', raw)
        const color = readColor('setBadgeBackgroundColor', details.color)
        write(extension.id, tabOf(details), { color })
      },
      opts,
    )

    handle('browserAction.getBadgeTextColor', getter('getBadgeTextColor', 'textColor', NO_COLOR), opts)
    handle(
      'browserAction.setBadgeTextColor',
      ({ extension }: ExtensionEvent, raw?: unknown) => {
        const details = detailsOf('setBadgeTextColor', raw)
        const textColor = readColor('setBadgeTextColor', details.color)
        write(extension.id, tabOf(details), { textColor })
      },
      opts,
    )

    handle('browserAction.getPopup', getter('getPopup', 'popup', ''), opts)
    handle(
      'browserAction.setPopup',
      ({ extension }: ExtensionEvent, raw?: unknown) => {
        const details = detailsOf('setPopup', raw)
        if (typeof details.popup !== 'string') {
          throw invocationError(
            'setPopup',
            'object details, optional function callback',
            details.popup === undefined
              ? "Error at parameter 'details': Missing required property 'popup'."
              : `Error at parameter 'details': Error at property 'popup': Invalid type: expected string, found ${typeName(details.popup)}.`,
          )
        }
        const tabId = tabOf(details)
        let popup = ''
        if (details.popup) {
          const url = resolvePopupUrl(extension.id, details.popup)
          if (!url) {
            throw new Error('The specified popup path is invalid. Ensure it is a path to a file in this extension.')
          }
          popup = url
        }
        write(extension.id, tabId, { popup })
      },
      opts,
    )

    handle(
      'browserAction.isEnabled',
      ({ extension }: ExtensionEvent, tabId?: unknown) => {
        const tab = tabOf(tabId === undefined || tabId === null ? undefined : { tabId })
        return read(extension.id, tab, 'enabled') !== false
      },
      opts,
    )
    for (const [method, enabled] of [
      ['enable', true],
      ['disable', false],
    ] as const) {
      handle(
        `browserAction.${method}`,
        ({ extension }: ExtensionEvent, tabId?: unknown) => {
          const tab = tabOf(tabId === undefined || tabId === null ? undefined : { tabId })
          write(extension.id, tab, { enabled })
        },
        opts,
      )
    }

    handle(
      'browserAction.getUserSettings',
      ({ extension }: ExtensionEvent): chrome.action.UserSettings => ({
        isOnToolbar: this.isOnToolbar(extension),
      }),
      opts,
    )

    handle(
      'browserAction.setIcon',
      async (event: ExtensionEvent, raw?: unknown) => {
        const details = detailsOf('setIcon', raw)
        const tabId = tabOf(details)
        const icon = await this.loadIcon(event, details)
        write(event.extension.id, tabId, { icon, iconModified: Date.now() })
      },
      opts,
    )

    handle('browserAction.openPopup', this.openPopup, opts)

    // browserAction preload API
    const preloadOpts = { allowRemote: true, extensionContext: false }
    handle('browserAction.getState', this.getState.bind(this), preloadOpts)
    handle('browserAction.activate', this.activate.bind(this), preloadOpts)
    handle(
      'browserAction.addObserver',
      (event) => {
        if (event.type != 'frame') return
        const observer = event.sender
        this.observers.add(observer)
        observer.once?.('destroyed', () => {
          this.observers.delete(observer)
        })
      },
      preloadOpts,
    )
    handle(
      'browserAction.removeObserver',
      (event) => {
        if (event.type != 'frame') return
        const { sender: observer } = event
        this.observers.delete(observer)
      },
      preloadOpts,
    )

    this.ctx.store.on('active-tab-changed', () => {
      this.onUpdate()
    })

    // Clear out tab details when removed
    this.ctx.store.on('tab-removed', (tabId: number) => {
      for (const [, actionDetails] of this.actionMap) {
        if (actionDetails.tabs[tabId]) {
          delete actionDetails.tabs[tabId]
        }
      }
      this.onUpdate()
    })

    this.setupSession(this.ctx.session)
  }

  private setupSession(session: Electron.Session) {
    const sessionExtensions = session.extensions || session
    sessionExtensions.on('extension-loaded', (event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.removeActions(extension.id)
      this.ctx.store.clearActivationContext(extension.id)
    })
  }

  handleCRXRequest(request: GlobalRequest): GlobalResponse {
    d('%s', request.url)

    try {
      const url = new URL(request.url)
      const { hostname: requestType } = url

      switch (requestType) {
        case 'extension-icon': {
          const tabId = url.searchParams.get('tabId')

          const fragments = url.pathname.split('/')
          const extensionId = fragments[1]
          const imageSize = parseInt(fragments[2], 10)
          const resizeType = parseInt(fragments[3], 10) || ResizeType.Up

          const sessionExtensions = this.ctx.session.extensions || this.ctx.session
          const extension = sessionExtensions.getExtension(extensionId)

          let iconDetails: chrome.browserAction.TabIconDetails | undefined

          const action = this.actionMap.get(extensionId)
          if (action) {
            // An icon the extension set for the tab wins; then one a
            // declarativeContent SetIcon rule set; then its own default.
            const declared = tabId
              ? this.ctx.store.getDeclarativeAction(extensionId, Number(tabId))?.icon
              : undefined
            iconDetails =
              (tabId && action.tabs[tabId]?.icon) ||
              (declared ? ({ imageData: declared } as unknown as chrome.browserAction.TabIconDetails) : undefined) ||
              action.icon
          }

          let iconImage

          if (extension && iconDetails) {
            if (typeof iconDetails.path === 'string') {
              const iconAbsPath = resolveExtensionPath(extension, iconDetails.path)
              if (iconAbsPath) iconImage = nativeImage.createFromPath(iconAbsPath)
            } else if (typeof iconDetails.path === 'object') {
              const imagePath = matchSize(iconDetails.path, imageSize, resizeType)
              const iconAbsPath = imagePath && resolveExtensionPath(extension, imagePath)
              if (iconAbsPath) iconImage = nativeImage.createFromPath(iconAbsPath)
            } else if (typeof iconDetails.imageData === 'string') {
              iconImage = nativeImage.createFromDataURL(iconDetails.imageData)
            } else if (typeof iconDetails.imageData === 'object') {
              const imageData = matchSize(iconDetails.imageData as any, imageSize, resizeType)
              iconImage = imageData ? nativeImage.createFromDataURL(imageData) : undefined
            }

            if (iconImage?.isEmpty()) {
              d('crx: icon image is empty', iconDetails)
            }
          }

          if (iconImage) {
            return new Response(iconImage.toPNG(), {
              status: 200,
              headers: {
                'Content-Type': 'image/png',
              },
            })
          }

          d('crx: no icon image for %s', extensionId)
          return new Response(null, { status: 400 })
        }
        default: {
          d('crx: invalid request %s', requestType)
          return new Response(null, { status: 400 })
        }
      }
    } catch (e) {
      console.error(e)
      return new Response(null, { status: 500 })
    }
  }

  private getAction(extensionId: string) {
    let action = this.actionMap.get(extensionId)
    if (!action) {
      action = { tabs: {} }
      this.actionMap.set(extensionId, action)
      this.onUpdate()
    }

    return action
  }

  // TODO: Make private for v4 major release.
  removeActions(extensionId: string) {
    if (this.actionMap.has(extensionId)) {
      this.actionMap.delete(extensionId)
    }

    this.onUpdate()
  }

  private getPopupUrl(extensionId: string, tabId: number) {
    const action = this.getAction(extensionId)
    const tabValue = action.tabs[tabId]?.popup
    const popup = tabValue !== undefined ? tabValue : action.popup
    // Stored resolved, and only ever as one of the extension's own pages.
    return popup ? resolvePopupUrl(extensionId, popup) : undefined
  }

  private isEnabledForTab(extensionId: string, tabId: number) {
    const action = this.getAction(extensionId)
    const tabValue = action.tabs[tabId]?.enabled
    if (tabValue !== undefined) return tabValue !== false
    // A declarativeContent ShowAction rule enables it on matching pages, even
    // after action.disable(), as in Chrome.
    if (this.ctx.store.getDeclarativeAction(extensionId, tabId)?.show) return true
    return action.enabled !== false
  }

  private isOnToolbar(extension: Electron.Extension) {
    try {
      const value = this.ctx.store.impl.isActionOnToolbar?.(extension)
      return typeof value === 'boolean' ? value : true
    } catch {
      return true
    }
  }

  /**
   * The host pinned or unpinned an extension's action: tells the extension,
   * as Chrome's action.onUserSettingsChanged does.
   */
  userSettingsChanged(extensionId: string) {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const extension = sessionExtensions.getExtension(extensionId)
    if (!extension) return
    this.ctx.router.sendEvent(extensionId, 'browserAction.onUserSettingsChanged', {
      isOnToolbar: this.isOnToolbar(extension),
    })
  }

  /** Where a relative icon path is resolved from: the calling page or worker script. */
  private callerUrl(event: ExtensionEvent) {
    const root = `chrome-extension://${event.extension.id}/`
    try {
      if (event.type === 'frame') {
        const url = event.sender.getURL()
        if (url.startsWith(root)) return url
      } else {
        const manifest = getExtensionManifest(event.extension) as any
        const script = manifest.background?.service_worker
        if (typeof script === 'string') return new URL(script, root).href
      }
    } catch {}
    return root
  }

  /** Checks one icon file as Chrome's setIcon does, and gives its path from the extension root. */
  private async checkIconFile(event: ExtensionEvent, iconPath: string) {
    const failed = (why: string) => new Error(`Failed to set icon '${iconPath}': ${why}`)
    let url: URL
    try {
      url = new URL(iconPath, this.callerUrl(event))
    } catch {
      throw failed('Failed to fetch')
    }
    if (url.protocol !== 'chrome-extension:' || url.hostname !== event.extension.id) {
      throw failed('Failed to fetch')
    }
    let relative: string
    let buffer: Buffer
    try {
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const file = resolveExtensionPath(event.extension, relative)
      if (!file) throw new Error('outside')
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > MAX_ICON_BYTES) throw new Error('not a file')
      buffer = await fs.readFile(file)
    } catch {
      throw failed('Failed to fetch')
    }
    if (nativeImage.createFromBuffer(buffer).isEmpty()) {
      throw failed('The source image could not be decoded.')
    }
    return relative
  }

  /** ImageData from the page, as { width, height, data }, to a PNG data URL. */
  private imageDataToUrl(value: unknown): string | undefined {
    const v = value as { width?: unknown; height?: unknown; data?: unknown } | null
    if (!v || typeof v !== 'object') return undefined
    const { width, height, data } = v
    if (
      typeof width !== 'number' || typeof height !== 'number' ||
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE ||
      !(data instanceof Uint8Array || data instanceof Uint8ClampedArray || Array.isArray(data)) ||
      (data as ArrayLike<number>).length !== width * height * 4
    ) {
      return undefined
    }
    // ImageData is RGBA; a native bitmap is premultiplied BGRA.
    const rgba = data as ArrayLike<number>
    const bgra = Buffer.alloc(width * height * 4)
    for (let i = 0; i < bgra.length; i += 4) {
      const a = rgba[i + 3] & 255
      const premultiply = (c: number) => Math.round(((c & 255) * a) / 255)
      bgra[i] = premultiply(rgba[i + 2])
      bgra[i + 1] = premultiply(rgba[i + 1])
      bgra[i + 2] = premultiply(rgba[i])
      bgra[i + 3] = a
    }
    const image = nativeImage.createFromBitmap(bgra, { width, height })
    return image.isEmpty() ? undefined : image.toDataURL()
  }

  private async loadIcon(event: ExtensionEvent, details: Record<string, unknown>) {
    const { path: iconPath, imageData } = details
    if (imageData !== undefined && imageData !== null) {
      const bad = () =>
        new Error('The imageData property must contain an ImageData object or dictionary of ImageData objects.')
      if (typeof imageData !== 'object' || Array.isArray(imageData)) {
        throw invocationError(
          'setIcon',
          'object details, optional function callback',
          `Error at parameter 'details': Error at property 'imageData': Invalid type: expected [extensionTypes.ImageDataType|object], found ${typeName(imageData)}.`,
        )
      }
      const single = this.imageDataToUrl(imageData)
      if (single) return { imageData: single } as unknown as chrome.browserAction.TabIconDetails
      const sizes = Object.entries(imageData as Record<string, unknown>).slice(0, 16)
      if (sizes.length === 0) throw bad()
      const out: Record<string, string> = {}
      for (const [size, value] of sizes) {
        const url = this.imageDataToUrl(value)
        if (!url || !/^\d+$/.test(size)) throw bad()
        out[size] = url
      }
      return { imageData: out } as unknown as chrome.browserAction.TabIconDetails
    }
    if (iconPath === undefined || iconPath === null) {
      throw new Error('Either the path or imageData property must be specified.')
    }
    if (typeof iconPath === 'string') {
      return { path: await this.checkIconFile(event, iconPath) }
    }
    if (typeof iconPath === 'object' && !Array.isArray(iconPath)) {
      const entries = Object.entries(iconPath as Record<string, unknown>).slice(0, 16)
      const out: Record<string, string> = {}
      for (const [size, value] of entries) {
        if (typeof value !== 'string' || !/^\d+$/.test(size)) {
          throw invocationError(
            'setIcon',
            'object details, optional function callback',
            "Error at parameter 'details': Error at property 'path': Value did not match any choice.",
          )
        }
        out[size] = await this.checkIconFile(event, value)
      }
      if (entries.length === 0) throw new Error('Either the path or imageData property must be specified.')
      return { path: out } as unknown as chrome.browserAction.TabIconDetails
    }
    throw invocationError(
      'setIcon',
      'object details, optional function callback',
      `Error at parameter 'details': Error at property 'path': Invalid type: expected [string|object], found ${typeName(iconPath)}.`,
    )
  }

  // TODO: Make private for v4 major release.
  processExtension(extension: Electron.Extension) {
    const defaultAction = getBrowserActionDefaults(extension)
    if (defaultAction) {
      const action = this.getAction(extension.id)
      Object.assign(action, defaultAction)
    }
  }

  private getState() {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    // The toolbar shows colours as CSS and falls back to the name for a title.
    const forUi = (values: Partial<ExtensionAction>) => {
      const { icon, color, textColor, ...rest } = values
      const out: Record<string, unknown> = { ...rest }
      if (color) out.color = cssColor(color)
      if (textColor) out.textColor = cssColor(textColor)
      return out
    }
    const actions = Array.from(this.actionMap.entries()).map(([id, details]) => {
      const { tabs, ...rest } = details
      const tabsInfo: { [key: string]: any } = {}
      for (const tabId of Object.keys(tabs)) tabsInfo[tabId] = forUi(tabs[tabId])
      for (const tab of this.ctx.store.tabs) {
        if (tab.isDestroyed() || !this.ctx.store.getDeclarativeAction(id, tab.id)) continue
        const info = (tabsInfo[tab.id] = tabsInfo[tab.id] || {})
        if (info.enabled === undefined) info.enabled = this.isEnabledForTab(id, tab.id)
        const changed = this.declarativeChangedAt.get(`${id}:${tab.id}`)
        if (changed && !(info.iconModified >= changed)) info.iconModified = changed
      }
      const info = forUi(rest)
      if (!info.title) info.title = sessionExtensions.getExtension(id)?.name ?? ''
      return { id, tabs: tabsInfo, ...info }
    })

    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()
    return { activeTabId: activeTab?.id, actions }
  }

  private activate({ type, sender }: ExtensionEvent, details: ActivateDetails) {
    if (type != 'frame') return
    const { eventType, extensionId, tabId } = details

    d(
      `activate [eventType: ${eventType}, extensionId: '${extensionId}', tabId: ${tabId}, senderId: ${sender?.id}]`,
    )

    switch (eventType) {
      case 'click':
        this.activateClick(details)
        break
      case 'contextmenu':
        this.activateContextMenu(details)
        break
      default:
        console.debug(`Ignoring unknown browserAction.activate event '${eventType}'`)
    }
  }

  private activateClick(details: ActivateDetails) {
    const { extensionId, tabId, anchorRect, alignment } = details

    if (this.popup) {
      const toggleExtension = !this.popup.isDestroyed() && this.popup.extensionId === extensionId
      this.popup.destroy()
      this.popup = undefined
      if (toggleExtension) {
        d('skipping activate to close popup')
        return
      }
    }

    const tab =
      tabId >= 0 ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) {
      throw new Error(`Unable to get active tab`)
    }

    // Pin this window/tab as the invocation context for the extension so that
    // subsequent API calls (e.g. tabs.query({ currentWindow: true })) resolve
    // to the correct window regardless of OS focus changes (e.g. popup close).
    const activationWin = this.ctx.store.tabToWindow.get(tab)
    if (activationWin && !activationWin.isDestroyed()) {
      this.ctx.store.setActivationContext(extensionId, activationWin.id, tab.id)
      noteInvocation(this.ctx, extensionId, tab)
      d(`activation context set [extensionId: '${extensionId}', windowId: ${activationWin.id}, tabId: ${tab.id}]`)
    }

    // A disabled action does nothing when clicked, as in Chrome.
    if (!this.isEnabledForTab(extensionId, tab.id)) {
      d('skipping activate: action disabled')
      return
    }

    const popupUrl = this.getPopupUrl(extensionId, tab.id)

    if (popupUrl) {
      const win = this.ctx.store.tabToWindow.get(tab)
      if (!win) {
        throw new Error('Unable to get BrowserWindow from active tab')
      }

      this.popup = new PopupView({
        extensionId,
        session: this.ctx.session,
        parent: win,
        url: popupUrl,
        anchorRect,
        alignment,
      })

      d(`opened popup: ${popupUrl}`)

      this.ctx.emit('browser-action-popup-created', this.popup)
    } else {
      d(`dispatching onClicked for ${extensionId}`)

      const tabDetails = tabForExtension(this.ctx, extensionId, this.ctx.store.tabDetailsCache.get(tab.id))
      this.ctx.router.sendEvent(extensionId, 'browserAction.onClicked', tabDetails)
    }
  }

  private activateContextMenu(details: ActivateDetails) {
    const { extensionId, anchorRect } = details

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const extension = sessionExtensions.getExtension(extensionId)
    if (!extension) {
      throw new Error(`Unregistered extension '${extensionId}'`)
    }

    const manifest = getExtensionManifest(extension)
    const menu = new Menu()
    const append = (opts: Electron.MenuItemConstructorOptions) => menu.append(new MenuItem(opts))
    const appendSeparator = () => menu.append(new MenuItem({ type: 'separator' }))

    append({
      label: extension.name,
      click: () => {
        const homePageUrl =
          manifest.homepage_url || `https://chrome.google.com/webstore/detail/${extension.id}`
        this.ctx.store.createTab({ url: homePageUrl })
      },
    })

    appendSeparator()

    // TODO(mv3): need to build 'action' menu items?
    const contextMenuItems: MenuItem[] = this.ctx.store.buildMenuItems(
      extensionId,
      'browser_action',
    )
    if (contextMenuItems.length > 0) {
      contextMenuItems.forEach((item) => menu.append(item))
      appendSeparator()
    }

    const optionsPage = manifest.options_page || manifest.options_ui?.page
    const optionsPageUrl = optionsPage ? getExtensionUrl(extension, optionsPage) : undefined

    append({
      label: 'Options',
      enabled: typeof optionsPageUrl === 'string',
      click: () => {
        this.ctx.store.createTab({ url: optionsPageUrl })
      },
    })

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG) {
      append({
        label: 'Remove extension',
        click: () => {
          d(`removing extension "${extension.name}" (${extension.id})`)
          sessionExtensions.removeExtension(extension.id)
        },
      })
    }

    menu.popup({
      x: Math.floor(anchorRect.x),
      y: Math.floor(anchorRect.y + anchorRect.height),
    })
  }

  private openPopup = (event: ExtensionEvent, options?: chrome.action.OpenPopupOptions) => {
    const windowId = (options as { windowId?: unknown } | undefined)?.windowId
    let window: Electron.BaseWindow | undefined | null
    if (windowId !== undefined && windowId !== null) {
      window = typeof windowId === 'number' ? this.ctx.store.getWindowById(windowId) : undefined
      if (!window || window.isDestroyed()) throw new Error(`No window with id: ${windowId}.`)
    } else {
      window = this.ctx.store.getCurrentWindow()
    }
    if (!window || window.isDestroyed()) {
      throw new Error('Could not find an active browser window.')
    }

    let activeTab = this.ctx.store.getActiveTabFromWindow(window)
    if (!activeTab) {
      activeTab = Array.from(this.ctx.store.tabs).find(
        (t) => !t.isDestroyed() && this.ctx.store.tabToWindow.get(t) === window,
      )
    }
    if (!activeTab) {
      throw new Error('Could not find an active browser window.')
    }
    if (!this.getPopupUrl(event.extension.id, activeTab.id) || !this.isEnabledForTab(event.extension.id, activeTab.id)) {
      throw new Error('Extension does not have a popup on the active tab.')
    }

    const [width] = (window as Electron.BrowserWindow).getSize()
    const anchorSize = 64

    this.activateClick({
      eventType: 'click',
      extensionId: event.extension.id,
      tabId: activeTab.id,
      anchorRect: { x: width - anchorSize, y: 0, width: anchorSize, height: anchorSize },
    })
  }

  /**
   * Directly send browserAction.onClicked to an extension (for hosts like Peersky that
   * trigger clicks from the UI). Does not depend on the store having a window/tab.
   */
  triggerClicked(extensionId: string, tabDetails?: Partial<chrome.tabs.Tab>) {
    const details = tabDetails ?? { id: 0, windowId: 0, url: '', active: true }
    d(`triggerClicked for ${extensionId}`)
    const tab = typeof details.id === 'number' ? this.ctx.store.getTabById(details.id) : undefined
    noteInvocation(this.ctx, extensionId, tab)
    this.ctx.router.sendEvent(extensionId, 'browserAction.onClicked', tabForExtension(this.ctx, extensionId, details))
  }

  private onUpdate() {
    if (this.queuedUpdate) return
    this.queuedUpdate = true
    queueMicrotask(() => {
      this.queuedUpdate = false
      if (this.observers.size === 0) return
      d(`dispatching update to ${this.observers.size} observer(s)`)
      Array.from(this.observers).forEach((observer) => {
        if (!observer.isDestroyed()) {
          observer.send?.('browserAction.update')
        }
      })
    })
  }
}
