import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { API_CONSTANTS } from '../../renderer/constants'
import { ArgSpec, checkArgs, MAX_STRING, ParamSpec } from './arg-check'
import { ExtensionSettings, sendToEachWithPermission } from './chrome-setting'
import { getInstalledFonts } from './font-list'

const GENERIC_FAMILIES = ['standard', 'sansserif', 'serif', 'fixed', 'cursive', 'fantasy', 'math'] as const
type GenericFamily = (typeof GENERIC_FAMILIES)[number]
const SCRIPT_CODES: string[] = Object.values(API_CONSTANTS.fontSettings?.ScriptCode || {}) as string[]
const COMMON_SCRIPT = 'Zyyy'

/** Chrome's fonts for a new profile in English, per platform. */
const DEFAULT_FONTS: Record<string, Record<GenericFamily, string>> = {
  darwin: {
    standard: 'Times',
    serif: 'Times',
    sansserif: 'Helvetica',
    fixed: 'Menlo',
    cursive: 'Apple Chancery',
    fantasy: 'Papyrus',
    math: 'STIX Two Math',
  },
  win32: {
    standard: 'Times New Roman',
    serif: 'Times New Roman',
    sansserif: 'Arial',
    fixed: 'Consolas',
    cursive: 'Comic Sans MS',
    fantasy: 'Impact',
    math: 'Cambria Math',
  },
  linux: {
    standard: 'Times New Roman',
    serif: 'Times New Roman',
    sansserif: 'Arial',
    fixed: 'Monospace',
    cursive: 'Comic Sans MS',
    fantasy: 'Impact',
    math: 'Latin Modern Math',
  },
}
/** The per-script defaults Chrome has that are known here. */
const DEFAULT_SCRIPT_FONTS: Record<string, Record<string, Partial<Record<GenericFamily, string>>>> = {
  darwin: { Hans: { standard: 'PingFang SC' } },
}

const SIZES = {
  defaultFontSize: { value: 16, event: 'onDefaultFontSizeChanged', name: 'DefaultFontSize' },
  defaultFixedFontSize: { value: 13, event: 'onDefaultFixedFontSizeChanged', name: 'DefaultFixedFontSize' },
  minimumFontSize: { value: 0, event: 'onMinimumFontSizeChanged', name: 'MinimumFontSize' },
} as const
type SizeName = keyof typeof SIZES

const FAMILY: ArgSpec = { type: 'string', enum: GENERIC_FAMILIES, ref: 'fontSettings.GenericFamily' }
const SCRIPT: ArgSpec = { type: 'string', enum: SCRIPT_CODES, ref: 'fontSettings.ScriptCode', optional: true }
const FONT_DETAILS: ParamSpec[] = [
  { name: 'details', spec: { type: 'object', properties: { script: SCRIPT, genericFamily: FAMILY } } },
]
const SET_FONT_DETAILS: ParamSpec[] = [
  {
    name: 'details',
    spec: { type: 'object', properties: { script: SCRIPT, genericFamily: FAMILY, fontId: { type: 'string' } } },
  },
]
const OPTIONAL_EMPTY: ParamSpec[] = [{ name: 'details', spec: { type: 'object', optional: true, properties: {} } }]
const SET_SIZE: ParamSpec[] = [
  { name: 'details', spec: { type: 'object', properties: { pixelSize: { type: 'integer' } } } },
]

const fontKey = (family: string, script: string) => `fontSettings.font.${family}.${script}`
const sizeKey = (size: SizeName) => `fontSettings.${size}`

/** Fonts and sizes as the host can pass them to a new page's webPreferences. */
export interface FontWebPreferences {
  defaultFontFamily: {
    standard: string
    serif: string
    sansSerif: string
    monospace: string
    cursive: string
    fantasy: string
    math: string
  }
  defaultFontSize: number
  defaultMonospaceFontSize: number
  minimumFontSize: number
}

/**
 * chrome.fontSettings: the fonts for each generic family and script and the
 * three font sizes, with Chrome's defaults and levels of control, kept per
 * session.
 *
 * Electron fixes a page's fonts when the page is made, so the library cannot
 * change the fonts of pages already open. The host reads the settings with
 * `ElectronChromeExtensions.getFontWebPreferences()` and passes them to the
 * webPreferences of new tabs, and hears changes on the
 * 'font-settings-changed' event. Fonts for scripts other than the common one
 * are kept and readable, but Electron has no way to apply them.
 */
export class FontSettingsAPI {
  private settings: ExtensionSettings

  constructor(private ctx: ExtensionContext) {
    this.settings = ExtensionSettings.for(ctx)
    const handle = ctx.router.apiHandler()
    const opts = { permission: 'fontSettings' }

    handle('fontSettings.getFont', this.getFont, opts)
    handle('fontSettings.setFont', this.setFont, opts)
    handle('fontSettings.clearFont', this.clearFont, opts)
    handle('fontSettings.getFontList', this.getFontList, opts)
    for (const size of Object.keys(SIZES) as SizeName[]) {
      const { name } = SIZES[size]
      handle(`fontSettings.get${name}`, (event: ExtensionEvent, ...args: any[]) => this.getSize(event, size, args), opts)
      handle(`fontSettings.set${name}`, (event: ExtensionEvent, ...args: any[]) => this.setSize(event, size, args), opts)
      handle(`fontSettings.clear${name}`, (event: ExtensionEvent, ...args: any[]) => this.clearSize(event, size, args), opts)
    }

    this.settings.onChange(({ key }) => {
      if (!key.startsWith('fontSettings.')) return
      const parts = key.split('.')
      if (parts[1] === 'font') {
        const [, , genericFamily, script] = parts
        sendToEachWithPermission(ctx, 'fontSettings', 'fontSettings.onFontChanged', (extensionId) => [
          {
            fontId: this.fontFor(genericFamily as GenericFamily, script),
            genericFamily,
            script,
            levelOfControl: this.settings.levelOfControl(key, extensionId),
          },
        ])
      } else if (parts[1] in SIZES) {
        const size = parts[1] as SizeName
        sendToEachWithPermission(ctx, 'fontSettings', `fontSettings.${SIZES[size].event}`, (extensionId) => [
          { pixelSize: this.sizeFor(size), levelOfControl: this.settings.levelOfControl(key, extensionId) },
        ])
      }
      ctx.emit('font-settings-changed', this.getWebPreferences())
    })
  }

  /** The font that counts for a generic family and script. */
  fontFor(genericFamily: GenericFamily, script = COMMON_SCRIPT): string {
    const current = this.settings.effective(fontKey(genericFamily, script))
    if (current) return current.value as string
    const platform = DEFAULT_FONTS[process.platform] ? process.platform : 'linux'
    if (script === COMMON_SCRIPT) return DEFAULT_FONTS[platform][genericFamily]
    return DEFAULT_SCRIPT_FONTS[platform]?.[script]?.[genericFamily] ?? ''
  }

  /** The font size that counts, in pixels. */
  sizeFor(size: SizeName): number {
    const current = this.settings.effective(sizeKey(size))
    return current ? (current.value as number) : SIZES[size].value
  }

  /** The common script's fonts and the sizes, in Electron's webPreferences names. */
  getWebPreferences(): FontWebPreferences {
    return {
      defaultFontFamily: {
        standard: this.fontFor('standard'),
        serif: this.fontFor('serif'),
        sansSerif: this.fontFor('sansserif'),
        monospace: this.fontFor('fixed'),
        cursive: this.fontFor('cursive'),
        fantasy: this.fontFor('fantasy'),
        math: this.fontFor('math'),
      },
      defaultFontSize: this.sizeFor('defaultFontSize'),
      defaultMonospaceFontSize: this.sizeFor('defaultFixedFontSize'),
      minimumFontSize: this.sizeFor('minimumFontSize'),
    }
  }

  private getFont = async ({ extension }: ExtensionEvent, ...args: any[]) => {
    checkArgs('fontSettings.getFont', FONT_DETAILS, args)
    const { genericFamily, script = COMMON_SCRIPT } = args[0]
    await this.settings.ready
    this.settings.touch(extension.id)
    return {
      fontId: this.fontFor(genericFamily, script),
      levelOfControl: this.settings.levelOfControl(fontKey(genericFamily, script), extension.id),
    }
  }

  private setFont = async ({ extension }: ExtensionEvent, ...args: any[]) => {
    checkArgs('fontSettings.setFont', SET_FONT_DETAILS, args)
    const { genericFamily, script = COMMON_SCRIPT, fontId } = args[0]
    await this.settings.ready
    await this.settings.set(extension.id, fontKey(genericFamily, script), String(fontId).slice(0, MAX_STRING))
  }

  private clearFont = async ({ extension }: ExtensionEvent, ...args: any[]) => {
    checkArgs('fontSettings.clearFont', FONT_DETAILS, args)
    const { genericFamily, script = COMMON_SCRIPT } = args[0]
    await this.settings.ready
    await this.settings.clear(extension.id, fontKey(genericFamily, script))
  }

  private getFontList = async (_event: ExtensionEvent, ...args: any[]) => {
    checkArgs('fontSettings.getFontList', [], args)
    return getInstalledFonts()
  }

  private async getSize({ extension }: ExtensionEvent, size: SizeName, args: any[]) {
    checkArgs(`fontSettings.get${SIZES[size].name}`, OPTIONAL_EMPTY, args)
    await this.settings.ready
    this.settings.touch(extension.id)
    return { pixelSize: this.sizeFor(size), levelOfControl: this.settings.levelOfControl(sizeKey(size), extension.id) }
  }

  private async setSize({ extension }: ExtensionEvent, size: SizeName, args: any[]) {
    checkArgs(`fontSettings.set${SIZES[size].name}`, SET_SIZE, args)
    await this.settings.ready
    // Chrome keeps any whole number and leaves it to the renderer to clamp.
    await this.settings.set(extension.id, sizeKey(size), args[0].pixelSize)
  }

  private async clearSize({ extension }: ExtensionEvent, size: SizeName, args: any[]) {
    checkArgs(`fontSettings.clear${SIZES[size].name}`, OPTIONAL_EMPTY, args)
    await this.settings.ready
    await this.settings.clear(extension.id, sizeKey(size))
  }
}
