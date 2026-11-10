import { app, nativeImage, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { chromeTypeName } from './alarms'
import { resolveExtensionPath } from './common'

const TEMPLATE_TYPES = ['basic', 'image', 'list', 'progress']

const CREATE_SIGNATURE =
  'notifications.create(optional string notificationId, notifications.NotificationOptions options, optional function callback)'
const UPDATE_SIGNATURE =
  'notifications.update(string notificationId, notifications.NotificationOptions options, optional function callback)'
const CLEAR_SIGNATURE = 'notifications.clear(string notificationId, optional function callback)'

/** Limits that keep one extension from filling the screen or the main process. */
const MAX_NOTIFICATIONS = 100
const MAX_TEXT = 2000
const MAX_ITEMS = 50
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000

type Options = chrome.notifications.NotificationOptions<boolean> & Record<string, unknown>

const invocationError = (signature: string, detail: string) =>
  new Error(`Error in invocation of ${signature}: ${detail}`)

const IMAGES_FAILED = 'Unable to download all specified images.'

const getUrgency = (priority?: unknown): Required<Electron.NotificationConstructorOptions>['urgency'] => {
  if (typeof priority !== 'number') return 'normal'
  if (priority >= 2) return 'critical'
  if (priority < 0) return 'low'
  return 'normal'
}

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined)

/** Checks option types as Chrome's bindings do, with their message. */
function checkOptionTypes(signature: string, options: Options) {
  const fail = (detail: string) =>
    invocationError(signature, `Error at parameter 'options': ${detail}`)
  if (options.type !== undefined && !TEMPLATE_TYPES.includes(options.type as string)) {
    throw fail(`Error at property 'type': Value must be one of ${TEMPLATE_TYPES.join(', ')}.`)
  }
  const strings = ['iconUrl', 'appIconMaskUrl', 'title', 'message', 'contextMessage', 'imageUrl']
  for (const key of strings) {
    const value = options[key]
    if (value !== undefined && typeof value !== 'string') {
      throw fail(`Error at property '${key}': Invalid type: expected string, found ${chromeTypeName(value)}.`)
    }
  }
  for (const key of ['priority', 'progress']) {
    const value = options[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value))) {
      throw fail(`Error at property '${key}': Invalid type: expected integer, found ${chromeTypeName(value)}.`)
    }
  }
  for (const key of ['requireInteraction', 'silent', 'isClickable']) {
    const value = options[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw fail(`Error at property '${key}': Invalid type: expected boolean, found ${chromeTypeName(value)}.`)
    }
  }
  for (const key of ['items', 'buttons']) {
    const value = options[key]
    if (value !== undefined && !Array.isArray(value)) {
      throw fail(`Error at property '${key}': Invalid type: expected array, found ${chromeTypeName(value)}.`)
    }
  }
}

/** Chrome makes the notification only when its template has what it needs. */
function isComplete(options: Options) {
  const { type } = options
  if (!type || typeof options.title !== 'string' || typeof options.message !== 'string') return false
  if (typeof options.iconUrl !== 'string' || !options.iconUrl) return false
  if (type === 'image' && !options.imageUrl) return false
  if (type !== 'image' && options.imageUrl) return false
  if (type === 'list' && !Array.isArray(options.items)) return false
  if (type !== 'list' && Array.isArray(options.items) && options.items.length) return false
  if (type === 'progress') {
    if (typeof options.progress !== 'number' && options.progress !== undefined) return false
    if (typeof options.progress === 'number' && (options.progress < 0 || options.progress > 100)) return false
  } else if (options.progress !== undefined) {
    return false
  }
  return true
}

interface Shown {
  options: Options
  notification?: Notification
}

export class NotificationsAPI {
  private registry = new Map</* extensionId */ string, Map</* id */ string, Shown>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('notifications.clear', this.clear)
    handle('notifications.create', this.create)
    handle('notifications.getAll', this.getAll)
    handle('notifications.getPermissionLevel', this.getPermissionLevel)
    handle('notifications.update', this.update)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      const shown = this.registry.get(extension.id)
      this.registry.delete(extension.id)
      for (const entry of shown?.values() ?? []) this.close(entry)
    })
  }

  private close(entry: Shown) {
    const notification = entry.notification
    entry.notification = undefined
    if (!notification) return
    notification.removeAllListeners()
    notification.close()
  }

  /**
   * Loads an image the notification shows: a file of the extension (resolved
   * as a URL, so it cannot leave the extension's folder), a data: URL, or an
   * http(s) URL fetched without cookies. Fails with Chrome's message.
   */
  private async loadImage(extension: Electron.Extension, url: string): Promise<Electron.NativeImage> {
    let parsed: URL
    try {
      parsed = new URL(url, `chrome-extension://${extension.id}/`)
    } catch {
      throw new Error(IMAGES_FAILED)
    }
    let image: Electron.NativeImage | undefined
    if (parsed.protocol === 'data:') {
      if (url.length > MAX_IMAGE_BYTES * 2) throw new Error(IMAGES_FAILED)
      image = nativeImage.createFromDataURL(parsed.href)
    } else if (parsed.protocol === 'chrome-extension:') {
      if (parsed.hostname !== extension.id) throw new Error(IMAGES_FAILED)
      try {
        const file = resolveExtensionPath(extension, decodeURIComponent(parsed.pathname))
        if (!file) throw new Error(IMAGES_FAILED)
        const stat = await fs.stat(file)
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error(IMAGES_FAILED)
        image = nativeImage.createFromBuffer(await fs.readFile(file))
      } catch {
        throw new Error(IMAGES_FAILED)
      }
    } else if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS)
        try {
          const response = await this.ctx.session.fetch(parsed.href, {
            credentials: 'omit',
            signal: controller.signal,
          } as RequestInit)
          if (!response.ok) throw new Error(IMAGES_FAILED)
          const body = Buffer.from(await response.arrayBuffer())
          if (body.length > MAX_IMAGE_BYTES) throw new Error(IMAGES_FAILED)
          image = nativeImage.createFromBuffer(body)
        } finally {
          clearTimeout(timer)
        }
      } catch {
        throw new Error(IMAGES_FAILED)
      }
    }
    if (!image || image.isEmpty()) throw new Error(IMAGES_FAILED)
    return image
  }

  private body(options: Options) {
    if (options.type === 'list' && Array.isArray(options.items)) {
      return options.items
        .slice(0, MAX_ITEMS)
        .map((item: any) => `${text(item?.title) ?? ''} - ${text(item?.message) ?? ''}`)
        .join('\n')
    }
    const message = text(options.message) ?? ''
    const context = text(options.contextMessage)
    return context ? `${message}\n${context}` : message
  }

  private async show(extension: Electron.Extension, id: string, entry: Shown) {
    const { options } = entry
    const icon = await this.loadImage(extension, options.iconUrl as string)
    if (typeof options.imageUrl === 'string' && options.imageUrl) {
      await this.loadImage(extension, options.imageUrl)
    }
    const buttons = Array.isArray(options.buttons) ? options.buttons.slice(0, 2) : []
    for (const button of buttons) {
      if (button && typeof (button as any).iconUrl === 'string') {
        await this.loadImage(extension, (button as any).iconUrl)
      }
    }
    if (!Notification.isSupported()) return

    const notification = new Notification({
      title: text(options.title) ?? '',
      subtitle: app.name,
      body: this.body(options),
      silent: options.silent === true,
      icon,
      urgency: getUrgency(options.priority),
      timeoutType: options.requireInteraction ? 'never' : 'default',
      actions: buttons.map((b: any) => ({ type: 'button' as const, text: text(b?.title) ?? '' })),
    })
    this.close(entry)
    entry.notification = notification

    notification.on('click', () => {
      this.ctx.store.noteUserGesture(extension.id)
      this.ctx.router.sendEvent(extension.id, 'notifications.onClicked', id)
    })
    notification.on('action', (_event, index) => {
      this.ctx.store.noteUserGesture(extension.id)
      this.ctx.router.sendEvent(extension.id, 'notifications.onButtonClicked', id, index)
    })
    notification.once('close', () => {
      if (entry.notification !== notification) return
      this.registry.get(extension.id)?.delete(id)
      this.ctx.router.sendEvent(extension.id, 'notifications.onClosed', id, true)
    })
    notification.show()
  }

  private create = async ({ extension }: ExtensionEvent, ...args: unknown[]) => {
    let id: unknown
    let options: unknown
    if (args.length >= 2 && args[1] !== undefined) {
      ;[id, options] = args
    } else {
      options = args[0]
    }
    if ((id !== undefined && id !== null && typeof id !== 'string') || !options || typeof options !== 'object' || Array.isArray(options)) {
      throw invocationError(CREATE_SIGNATURE, 'No matching signature.')
    }
    checkOptionTypes(CREATE_SIGNATURE, options as Options)
    const notificationId = typeof id === 'string' && id ? id.slice(0, 500) : randomUUID()

    let shown = this.registry.get(extension.id)
    if (!shown) this.registry.set(extension.id, (shown = new Map()))
    const previous = shown.get(notificationId)
    if (!previous && shown.size >= MAX_NOTIFICATIONS) {
      throw new Error('Too many notifications are open.')
    }

    const entry: Shown = { options: { ...(options as Options) } }
    // Chrome answers with the id even when the template is missing a part,
    // and shows nothing.
    if (!isComplete(entry.options)) return notificationId
    await this.show(extension, notificationId, entry)
    if (previous) this.close(previous)
    shown.set(notificationId, entry)
    return notificationId
  }

  private update = async ({ extension }: ExtensionEvent, id: unknown, options: unknown) => {
    if (typeof id !== 'string' || !options || typeof options !== 'object' || Array.isArray(options)) {
      throw invocationError(UPDATE_SIGNATURE, 'No matching signature.')
    }
    checkOptionTypes(UPDATE_SIGNATURE, options as Options)
    const entry = this.registry.get(extension.id)?.get(id)
    if (!entry) return false
    const next: Shown = { options: { ...entry.options, ...(options as Options) } }
    if (!isComplete(next.options)) return true
    await this.show(extension, id, next)
    this.close(entry)
    this.registry.get(extension.id)?.set(id, next)
    return true
  }

  private clear = ({ extension }: ExtensionEvent, id: unknown) => {
    if (typeof id !== 'string') throw invocationError(CLEAR_SIGNATURE, 'No matching signature.')
    const shown = this.registry.get(extension.id)
    const entry = shown?.get(id)
    if (!shown || !entry) return false
    shown.delete(id)
    this.close(entry)
    this.ctx.router.sendEvent(extension.id, 'notifications.onClosed', id, false)
    return true
  }

  /** Chrome gives an object with each open notification's id set to true. */
  private getAll = ({ extension }: ExtensionEvent) => {
    const out: Record<string, boolean> = {}
    for (const id of this.registry.get(extension.id)?.keys() ?? []) out[id] = true
    return out
  }

  private getPermissionLevel = () => {
    return Notification.isSupported() ? 'granted' : 'denied'
  }

  /**
   * The host's notification settings for an extension changed: tells it, as
   * Chrome's notifications.onPermissionLevelChanged does.
   */
  permissionLevelChanged(extensionId: string, level: 'granted' | 'denied') {
    this.ctx.router.sendEvent(extensionId, 'notifications.onPermissionLevelChanged', level)
  }

  /** The person asked for the extension's notification settings from a notification. */
  showSettings(extensionId: string) {
    this.ctx.router.sendEvent(extensionId, 'notifications.onShowSettings')
  }
}
