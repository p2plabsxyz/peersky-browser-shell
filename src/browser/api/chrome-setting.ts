import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ArgSpec, checkArgs, checkValue } from './arg-check'

/**
 * Browser settings that extensions control, as Chrome keeps them: each
 * extension has its own value for a setting, and the one that counts is the
 * value of the most recently installed extension that is enabled and set one.
 * Values are kept per session, so they come back after a restart, and an
 * extension's values stop counting while it is unloaded.
 *
 * chrome.privacy, chrome.proxy and chrome.fontSettings all use one of these per
 * session.
 */

type LevelOfControl = chrome.types.LevelOfControl

/** Chrome keeps 'regular_only' apart from 'regular'; it wins for the regular profile. */
export type SettingLayer = 'regular' | 'regular_only'

interface Layers {
  regular?: unknown
  regular_only?: unknown
}

interface SettingsState {
  /** When each extension was first seen in this session: a later one wins. */
  order: Record<string, number>
  next: number
  /** setting key -> extension id -> its values */
  prefs: Record<string, Record<string, Layers>>
}

export interface SettingChange {
  key: string
  /** The value that counts now; undefined means the default. */
  value: unknown
  controller?: string
  previousController?: string
}

const STATE_NS = 'extensionSettings'
const ID_RE = /^[a-p]{32}$|^[\w.-]{1,64}$/
/** Keys read back from disk that must never become object members. */
const isSafeKey = (key: string) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype'

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function sanitizeState(saved: unknown): SettingsState {
  const state: SettingsState = { order: {}, next: 1, prefs: {} }
  if (!saved || typeof saved !== 'object') return state
  const s = saved as Partial<SettingsState>
  if (s.order && typeof s.order === 'object') {
    for (const [id, n] of Object.entries(s.order)) {
      if (ID_RE.test(id) && isSafeKey(id) && Number.isInteger(n)) state.order[id] = n as number
    }
  }
  const maxOrder = Math.max(0, ...Object.values(state.order))
  state.next = Number.isInteger(s.next) && (s.next as number) > maxOrder ? (s.next as number) : maxOrder + 1
  if (s.prefs && typeof s.prefs === 'object') {
    for (const [key, byExtension] of Object.entries(s.prefs)) {
      if (!isSafeKey(key) || !byExtension || typeof byExtension !== 'object') continue
      for (const [id, layers] of Object.entries(byExtension as Record<string, Layers>)) {
        if (!ID_RE.test(id) || !isSafeKey(id) || !layers || typeof layers !== 'object') continue
        const kept: Layers = {}
        if (hasOwn(layers, 'regular')) kept.regular = layers.regular
        if (hasOwn(layers, 'regular_only')) kept.regular_only = layers.regular_only
        if (!hasOwn(kept, 'regular') && !hasOwn(kept, 'regular_only')) continue
        ;(state.prefs[key] ||= {})[id] = kept
      }
    }
  }
  return state
}

const registries = new WeakMap<object, ExtensionSettings>()

export class ExtensionSettings {
  /** The one registry for this session's extensions. */
  static for(ctx: ExtensionContext): ExtensionSettings {
    let registry = registries.get(ctx)
    if (!registry) {
      registry = new ExtensionSettings(ctx)
      registries.set(ctx, registry)
    }
    return registry
  }

  /** Resolves once the saved values have been read. */
  readonly ready: Promise<void>

  private state: SettingsState = { order: {}, next: 1, prefs: {} }
  private loaded = new Set<string>()
  private listeners: Array<(change: SettingChange) => void | Promise<void>> = []
  private loadListeners: Array<(extensionId: string, loaded: boolean) => void> = []
  private flushing: Promise<void> = Promise.resolve()

  private constructor(private ctx: ExtensionContext) {
    this.ready = Promise.resolve()
      .then(() => ctx.stateStore.whenHydrated())
      .catch(() => {})
      .then(() => {
        this.state = sanitizeState(ctx.stateStore.getNamespace<unknown>(STATE_NS, undefined))
      })

    const sessionExtensions: any = ctx.session?.extensions || ctx.session
    if (sessionExtensions && typeof sessionExtensions.on === 'function') {
      sessionExtensions.on('extension-loaded', (_event: unknown, extension: Electron.Extension) =>
        this.extensionLoaded(extension.id),
      )
      sessionExtensions.on('extension-unloaded', (_event: unknown, extension: Electron.Extension) =>
        this.extensionUnloaded(extension.id),
      )
      const getAll = sessionExtensions.getAllExtensions
      if (typeof getAll === 'function') {
        for (const extension of getAll.call(sessionExtensions) || []) this.extensionLoaded(extension.id)
      }
    }
  }

  /**
   * Calls `listener` whenever the value that counts, or who set it, changes.
   * A set or clear resolves once every listener's promise has.
   */
  onChange(listener: (change: SettingChange) => void | Promise<void>) {
    this.listeners.push(listener)
  }

  /** The value that counts and the extension it comes from, if any. */
  effective(key: string): { value: unknown; controller: string } | undefined {
    const byExtension = this.state.prefs[key]
    if (!byExtension) return undefined
    let best: { value: unknown; controller: string; order: number } | undefined
    for (const [id, layers] of Object.entries(byExtension)) {
      if (!this.loaded.has(id)) continue
      const value = hasOwn(layers, 'regular_only') ? layers.regular_only : layers.regular
      if (value === undefined) continue
      const order = this.state.order[id] ?? 0
      if (!best || order > best.order) best = { value, controller: id, order }
    }
    return best && { value: best.value, controller: best.controller }
  }

  /** Chrome's levelOfControl of `key` for one extension. */
  levelOfControl(key: string, extensionId: string): LevelOfControl {
    const current = this.effective(key)
    if (!current) return 'controllable_by_this_extension'
    if (current.controller === extensionId) return 'controlled_by_this_extension'
    // An extension installed after the one in control could take over.
    const mine = this.state.order[extensionId] ?? Number.MAX_SAFE_INTEGER
    const theirs = this.state.order[current.controller] ?? 0
    return mine > theirs ? 'controllable_by_this_extension' : 'controlled_by_other_extensions'
  }

  /** The keys an extension has a value for. */
  keysOf(extensionId: string): string[] {
    return Object.keys(this.state.prefs).filter((key) => hasOwn(this.state.prefs[key], extensionId))
  }

  /** Every key that has a value from anyone, loaded or not. */
  keys(): string[] {
    return Object.keys(this.state.prefs)
  }

  set(extensionId: string, key: string, value: unknown, layer: SettingLayer = 'regular'): Promise<void> {
    this.touch(extensionId)
    const before = this.effective(key)
    const byExtension = (this.state.prefs[key] ||= {})
    const layers = (byExtension[extensionId] ||= {})
    layers[layer] = value
    this.save()
    return this.notify(key, before)
  }

  clear(extensionId: string, key: string, layer: SettingLayer = 'regular'): Promise<void> {
    const byExtension = this.state.prefs[key]
    const layers = byExtension?.[extensionId]
    if (!layers || !hasOwn(layers, layer)) return Promise.resolve()
    const before = this.effective(key)
    delete layers[layer]
    if (!hasOwn(layers, 'regular') && !hasOwn(layers, 'regular_only')) delete byExtension[extensionId]
    if (Object.keys(byExtension).length === 0) delete this.state.prefs[key]
    this.save()
    return this.notify(key, before)
  }

  /**
   * Drops everything an extension set, as Chrome does when it is uninstalled.
   * Electron does not tell an uninstall from an unload, so the host calls this.
   */
  async forget(extensionId: string) {
    await this.ready
    const keys = this.keysOf(extensionId)
    const befores = keys.map((key) => [key, this.effective(key)] as const)
    for (const key of keys) {
      delete this.state.prefs[key][extensionId]
      if (Object.keys(this.state.prefs[key]).length === 0) delete this.state.prefs[key]
    }
    delete this.state.order[extensionId]
    this.save()
    await Promise.all(befores.map(([key, before]) => this.notify(key, before)))
  }

  /**
   * Counts a calling extension as loaded and installed. Its saved values
   * start counting now if the session had not said it was loaded yet.
   */
  touch(extensionId: string) {
    if (!hasOwn(this.state.order, extensionId)) {
      this.state.order[extensionId] = this.state.next++
      this.save()
    }
    if (this.loaded.has(extensionId)) return
    const befores = this.keysOf(extensionId).map((key) => [key, this.effective(key)] as const)
    this.loaded.add(extensionId)
    for (const [key, before] of befores) void this.notify(key, before)
    this.loadedChanged(extensionId, true)
  }

  isLoaded(extensionId: string) {
    return this.loaded.has(extensionId)
  }

  /** Install order: a higher number is a more recently installed extension. */
  orderOf(extensionId: string): number {
    return this.state.order[extensionId] ?? 0
  }

  /** Loaded extensions, the most recently installed first. */
  loadedByPrecedence(): string[] {
    return [...this.loaded].sort((a, b) => this.orderOf(b) - this.orderOf(a))
  }

  /** Calls `listener` after an extension's values start or stop counting. */
  onLoadedChange(listener: (extensionId: string, loaded: boolean) => void) {
    this.loadListeners.push(listener)
  }

  private loadedChanged(extensionId: string, loaded: boolean) {
    for (const listener of this.loadListeners) {
      try {
        listener(extensionId, loaded)
      } catch (error) {
        console.error('Extension settings load handler failed:', error)
      }
    }
  }

  private extensionLoaded(extensionId: string) {
    void this.ready.then(() => {
      this.touch(extensionId)
    })
  }

  private extensionUnloaded(extensionId: string) {
    void this.ready.then(() => {
      if (!this.loaded.has(extensionId)) return
      const befores = this.keysOf(extensionId).map((key) => [key, this.effective(key)] as const)
      this.loaded.delete(extensionId)
      for (const [key, before] of befores) void this.notify(key, before)
      this.loadedChanged(extensionId, false)
    })
  }

  private async notify(key: string, before: { value: unknown; controller: string } | undefined) {
    const after = this.effective(key)
    if (before?.controller === after?.controller && sameValue(before?.value, after?.value)) return
    const change: SettingChange = {
      key,
      value: after?.value,
      controller: after?.controller,
      previousController: before?.controller,
    }
    await Promise.all(
      this.listeners.map(async (listener) => {
        try {
          await listener(change)
        } catch (error) {
          console.error(`Setting change handler for ${key} failed:`, error)
        }
      }),
    )
  }

  private save() {
    this.ctx.stateStore.setNamespace(STATE_NS, this.state)
    // One write at a time: overlapping writes of the same file can interleave.
    this.flushing = this.flushing
      .then(() => this.ctx.stateStore.flush())
      .catch((error) => console.error('Failed to save extension settings:', error))
  }
}

// ---------------------------------------------------------------- types.ChromeSetting

export const INCOGNITO_ERROR = 'You do not have permission to access incognito preferences.'

const SCOPES = ['regular', 'regular_only', 'incognito_persistent', 'incognito_session_only'] as const

const GET_DETAILS: ArgSpec = {
  type: 'object',
  properties: { incognito: { type: 'boolean', optional: true } },
}
const CLEAR_DETAILS: ArgSpec = {
  type: 'object',
  properties: { scope: { type: 'string', enum: SCOPES, ref: 'types.ChromeSettingScope', optional: true } },
}

export interface ChromeSettingOptions {
  /** API name, such as 'privacy.network.webRTCIPHandlingPolicy': calls are `${name}.get` and so on. */
  name: string
  /** Where the value is kept. Two names may share one, as Chrome's do. */
  key: string
  /** The permission an extension needs to see the setting and its changes. */
  permission: string
  /** Chrome's value when no extension controls the setting. */
  defaultValue: () => unknown
  /** What a value must look like; anything else is "Invalid invocation". */
  valueSpec: ArgSpec
  /**
   * Checks a value that has the right shape and returns what to keep. Throws
   * Chrome's error for a value Chrome refuses after its schema check.
   */
  accept?: (value: any, extension: Electron.Extension) => unknown | Promise<unknown>
}

/** Serves get, set, clear and onChange for one types.ChromeSetting. */
export function serveChromeSetting(ctx: ExtensionContext, settings: ExtensionSettings, opts: ChromeSettingOptions) {
  const handle = ctx.router.apiHandler()
  const { name, key, permission } = opts
  const setDetails: ArgSpec = {
    type: 'object',
    properties: {
      value: opts.valueSpec,
      scope: { type: 'string', enum: SCOPES, optional: true },
    },
  }

  const valueFor = (extensionId: string) => {
    const current = settings.effective(key)
    return {
      levelOfControl: settings.levelOfControl(key, extensionId),
      value: current ? current.value : opts.defaultValue(),
    }
  }

  handle(
    `${name}.get`,
    async ({ extension }: ExtensionEvent, ...args: any[]) => {
      checkArgs('types.ChromeSetting.get', [{ name: 'details', spec: GET_DETAILS }], args)
      if (args[0].incognito === true) throw new Error(INCOGNITO_ERROR)
      await settings.ready
      settings.touch(extension.id)
      return valueFor(extension.id)
    },
    { permission },
  )

  handle(
    `${name}.set`,
    async ({ extension }: ExtensionEvent, ...args: any[]) => {
      checkArgs('types.ChromeSetting.set', [{ name: 'details', spec: { type: 'object', open: true } }], args)
      const details = args[0]
      if (checkValue(setDetails, details)) throw new Error('Invalid invocation')
      const scope = details.scope ?? 'regular'
      if (scope === 'incognito_persistent' || scope === 'incognito_session_only') {
        throw new Error(INCOGNITO_ERROR)
      }
      const value = opts.accept ? await opts.accept(details.value, extension as any) : details.value
      await settings.ready
      await settings.set(extension.id, key, value, scope)
    },
    { permission },
  )

  handle(
    `${name}.clear`,
    async ({ extension }: ExtensionEvent, ...args: any[]) => {
      checkArgs('types.ChromeSetting.clear', [{ name: 'details', spec: CLEAR_DETAILS }], args)
      const scope = args[0].scope ?? 'regular'
      // Chrome takes an incognito clear without complaint and changes nothing.
      if (scope !== 'regular' && scope !== 'regular_only') return
      await settings.ready
      await settings.clear(extension.id, key, scope)
    },
    { permission },
  )

  settings.onChange((change) => {
    if (change.key !== key) return
    sendToEachWithPermission(ctx, permission, `${name}.onChange`, (extensionId) => [valueFor(extensionId)])
  })
}

/**
 * Sends an event to every loaded extension that holds `permission`, each with
 * its own arguments. Extensions without it never hear of the setting.
 */
export function sendToEachWithPermission(
  ctx: ExtensionContext,
  permission: string,
  eventName: string,
  argsFor: (extensionId: string) => any[],
) {
  const sessionExtensions: any = ctx.session?.extensions || ctx.session
  const all: Electron.Extension[] =
    typeof sessionExtensions?.getAllExtensions === 'function' ? sessionExtensions.getAllExtensions() || [] : []
  for (const extension of all) {
    const allowed = ctx.permissions
      ? ctx.permissions.has(extension, permission)
      : !!(extension.manifest as chrome.runtime.Manifest)?.permissions?.includes(permission as any)
    if (!allowed) continue
    ctx.router.sendEvent(extension.id, eventName, ...argsFor(extension.id))
  }
}
