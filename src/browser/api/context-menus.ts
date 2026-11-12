import { Menu, MenuItem } from 'electron'
import { MenuItemConstructorOptions } from 'electron/main'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { globMatch, tryParseMatchPattern } from '../match-pattern'
import { ContextMenuType, getIconImage, matchesPattern } from './common'
import { noteInvocation, tabForExtension } from '../invocation'

/**
 * Chrome reads a menu item's URL patterns with any scheme, and a scheme with no
 * "//" takes the rest as a path, as uBlock Origin's "abp:*" for its "Subscribe
 * to filter list" item on such links. Host access and content scripts keep the
 * strict patterns; this is for menu items only.
 */
const OPAQUE_MENU_PATTERN = /^([a-z][a-z0-9+.-]*):(?!\/\/)(.+)$/i

export function isMenuPattern(pattern: unknown): boolean {
  return typeof pattern === 'string' && (!!tryParseMatchPattern(pattern) || (pattern.length <= 2048 && OPAQUE_MENU_PATTERN.test(pattern)))
}

export function menuPatternMatches(pattern: string, url: string): boolean {
  const opaque = OPAQUE_MENU_PATTERN.exec(pattern)
  if (opaque && !tryParseMatchPattern(pattern)) {
    const scheme = `${opaque[1].toLowerCase()}:`
    if (!url.toLowerCase().startsWith(scheme)) return false
    return globMatch(opaque[2], url.slice(scheme.length))
  }
  return matchesPattern(pattern, url)
}

type ContextItemProps = Omit<chrome.contextMenus.CreateProperties, 'id' | 'parentId'> & {
  id: string | number
  parentId?: string | number
}

/** Chrome keeps string and number ids apart: 5 and '5' are two items. */
const menuKey = (id: unknown) => (typeof id === 'number' ? `n:${id}` : `s:${String(id)}`)

/** Limits that keep one extension from growing menus without end. */
const MAX_ITEMS = 1000
const MAX_PATTERNS = 100
const MAX_TITLE = 1000

/** Chrome's limit on top-level items an action's menu shows. */
const ACTION_MENU_TOP_LEVEL_LIMIT = 6

const PROP_KEYS = [
  'id',
  'type',
  'title',
  'checked',
  'contexts',
  'visible',
  'parentId',
  'documentUrlPatterns',
  'targetUrlPatterns',
  'enabled',
]

/** Only the properties Chrome knows, as plain values. */
function sanitizeProps(input: Record<string, unknown>): Partial<ContextItemProps> {
  const out: Record<string, unknown> = {}
  for (const key of PROP_KEYS) {
    if (!(key in input) || input[key] === undefined || input[key] === null) continue
    let value = input[key]
    if (key === 'title' && typeof value === 'string') value = value.slice(0, MAX_TITLE)
    if (Array.isArray(value)) value = value.slice(0, MAX_PATTERNS + 1)
    out[key] = value
  }
  return out as Partial<ContextItemProps>
}

/** A service worker or an event page: Chrome wants ids and no onclick there. */
const isLazyBackground = (extension: Electron.Extension) => {
  const manifest = extension.manifest as chrome.runtime.Manifest
  if (manifest.manifest_version === 3) return true
  return (manifest as chrome.runtime.ManifestV2).background?.persistent === false
}

type ContextItemConstructorOptions = {
  extension: Electron.Extension
  props: ContextItemProps
  webContents: Electron.WebContents
  params?: Electron.ContextMenuParams
  showIcon?: boolean
}

const DEFAULT_CONTEXTS = ['page']

const getContextTypesFromParams = (params: Electron.ContextMenuParams): Set<ContextMenuType> => {
  const contexts = new Set<ContextMenuType>(['all'])

  switch (params.mediaType) {
    case 'audio':
    case 'video':
    case 'image':
      contexts.add(params.mediaType)
  }

  if (params.pageURL) contexts.add('page')
  if (params.linkURL) contexts.add('link')
  if (params.frameURL) contexts.add('frame')
  if (params.selectionText) contexts.add('selection')
  if (params.isEditable) contexts.add('editable')

  return contexts
}

const formatTitle = (title: string, params: Electron.ContextMenuParams) => {
  if (params.selectionText && title.includes('%s')) {
    title = title.split('%s').join(params.selectionText)
  }
  return title
}

const matchesConditions = (
  props: ContextItemProps,
  conditions: {
    contextTypes: Set<ContextMenuType>
    targetUrl?: string
    documentUrl?: string
  },
) => {
  if (props.visible === false) return false

  const { contextTypes, targetUrl, documentUrl } = conditions

  const contexts = props.contexts
    ? Array.isArray(props.contexts)
      ? props.contexts
      : [props.contexts]
    : DEFAULT_CONTEXTS
  const inContext = contexts.some((context) => contextTypes.has(context as ContextMenuType))
  if (!inContext) return false

  if (props.targetUrlPatterns && props.targetUrlPatterns.length > 0 && targetUrl) {
    if (!props.targetUrlPatterns.some((pattern) => menuPatternMatches(pattern, targetUrl))) {
      return false
    }
  }

  if (props.documentUrlPatterns && props.documentUrlPatterns.length > 0 && documentUrl) {
    if (!props.documentUrlPatterns.some((pattern) => menuPatternMatches(pattern, documentUrl))) {
      return false
    }
  }

  return true
}

export class ContextMenusAPI {
  private menus = new Map<
    /* extensionId */ string,
    Map</* menuItemId */ string, ContextItemProps>
  >()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('contextMenus.create', this.create)
    handle('contextMenus.update', this.update)
    handle('contextMenus.remove', this.remove)
    handle('contextMenus.removeAll', this.removeAll)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      if (this.menus.has(extension.id)) {
        this.menus.delete(extension.id)
      }
    })

    this.ctx.store.buildMenuItems = this.buildMenuItemsForExtension.bind(this)
  }

  private addContextItem(extensionId: string, props: ContextItemProps) {
    let contextItems = this.menus.get(extensionId)
    if (!contextItems) {
      contextItems = new Map()
      this.menus.set(extensionId, contextItems)
    }
    contextItems.set(menuKey(props.id), props)
  }

  private buildMenuItem = (opts: ContextItemConstructorOptions) => {
    const { extension, props, webContents, params } = opts

    // TODO: try to get the appropriately sized image before resizing
    let icon = opts.showIcon ? getIconImage(extension) : undefined
    if (icon) {
      icon = icon.resize({ width: 16, height: 16 })
    }

    const menuItemOptions: MenuItemConstructorOptions = {
      id: String(props.id),
      type: props.type as any,
      label: params ? formatTitle(props.title || '', params) : props.title || '',
      icon,
      enabled: props.enabled !== false,
      checked: props.type === 'checkbox' || props.type === 'radio' ? props.checked === true : undefined,
      click: () => {
        this.onClicked(extension.id, props, webContents, params)
      },
    }

    return menuItemOptions
  }

  private buildMenuItemsFromTemplate = (menuItemTemplates: ContextItemConstructorOptions[]) => {
    const itemMap = new Map<string, MenuItemConstructorOptions>()

    // Group by ID
    for (const item of menuItemTemplates) {
      const menuItem = this.buildMenuItem(item)
      itemMap.set(menuKey(item.props.id), menuItem)
    }

    // Organize in tree
    for (const item of menuItemTemplates) {
      const menuItem = itemMap.get(menuKey(item.props.id))
      if (item.props.parentId !== undefined) {
        const parentMenuItem = itemMap.get(menuKey(item.props.parentId))
        if (parentMenuItem) {
          const submenu = (parentMenuItem.submenu || []) as Electron.MenuItemConstructorOptions[]
          submenu.push(menuItem!)
          parentMenuItem.submenu = submenu
        }
      }
    }

    const menuItems: Electron.MenuItem[] = []

    const buildFromTemplate = (opts: Electron.MenuItemConstructorOptions) => {
      if (Array.isArray(opts.submenu)) {
        const submenu = new Menu()
        opts.submenu.forEach((item) => submenu.append(buildFromTemplate(item)))
        opts.submenu = submenu
      }
      return new MenuItem({
        ...opts,
        // Force submenu type when submenu items are present
        type: opts.type === 'normal' && opts.submenu ? 'submenu' : opts.type,
      })
    }

    // Build all final MenuItems in-order
    for (const item of menuItemTemplates) {
      // Items with parents will be handled recursively
      if (item.props.parentId !== undefined) continue

      const menuItem = itemMap.get(menuKey(item.props.id))!
      menuItems.push(buildFromTemplate(menuItem))
    }

    return menuItems
  }

  buildMenuItemsForParams(
    webContents: Electron.WebContents,
    params: Electron.ContextMenuParams,
  ): Electron.MenuItem[] {
    if (webContents.session !== this.ctx.session) return []

    let menuItemOptions: ContextItemConstructorOptions[] = []

    const conditions = {
      contextTypes: getContextTypesFromParams(params),
      targetUrl: params.srcURL || params.linkURL,
      documentUrl: params.frameURL || params.pageURL,
    }

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session

    for (const [extensionId, propItems] of this.menus) {
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension) continue

      const extensionMenuItemOptions: ContextItemConstructorOptions[] = []

      for (const [, props] of propItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = {
            extension,
            props,
            webContents,
            params,
          }
          extensionMenuItemOptions.push(menuItem)
        }
      }

      const topLevelItems = extensionMenuItemOptions.filter((opt) => opt.props.parentId === undefined)

      if (topLevelItems.length > 1) {
        // Create new top-level item to group children
        const groupId = `group${extension.id}`
        const groupMenuItemOptions: ContextItemConstructorOptions = {
          extension,
          webContents,
          props: {
            id: groupId,
            title: extension.name,
          },
          params,
          showIcon: true,
        }

        // Reassign children to group item
        const children = extensionMenuItemOptions.map((opt) =>
          opt.props.parentId !== undefined
            ? opt
            : {
                ...opt,
                props: {
                  ...opt.props,
                  parentId: groupId,
                },
              },
        )

        menuItemOptions = [...menuItemOptions, groupMenuItemOptions, ...children]
      } else if (extensionMenuItemOptions.length > 0) {
        // Set all top-level children to show icon
        const children = extensionMenuItemOptions.map((opt) => ({
          ...opt,
          showIcon: opt.props.parentId === undefined,
        }))
        menuItemOptions = [...menuItemOptions, ...children]
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private buildMenuItemsForExtension(
    extensionId: string,
    menuType: ContextMenuType,
  ): Electron.MenuItem[] {
    const extensionItems = this.menus.get(extensionId)
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const extension = sessionExtensions.getExtension(extensionId)
    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()

    const menuItemOptions = []

    if (extensionItems && extension && activeTab) {
      const conditions = {
        contextTypes: new Set<ContextMenuType>(['all', menuType]),
      }

      let topLevel = 0
      for (const [, props] of extensionItems) {
        if (!matchesConditions(props, conditions)) continue
        // An action's menu shows only the first few top-level items.
        if (props.parentId === undefined && ++topLevel > ACTION_MENU_TOP_LEVEL_LIMIT) continue
        const menuItem = { extension, props, webContents: activeTab }
        menuItemOptions.push(menuItem)
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private find(extensionId: string, id: unknown) {
    return this.menus.get(extensionId)?.get(menuKey(id))
  }

  private notFound(id: unknown) {
    return new Error(`Cannot find menu item with id ${id}`)
  }

  /** Chrome's checks shared by create and update, on the item as it would be. */
  private check(extension: Electron.Extension, props: ContextItemProps) {
    const type = props.type || 'normal'
    if (type !== 'separator' && typeof props.title !== 'string') {
      throw new Error('All menu items except for separators must have a title')
    }
    const contexts = Array.isArray(props.contexts) ? props.contexts : []
    if (contexts.includes('launcher' as any)) {
      throw new Error("Only packaged apps are allowed to use 'launcher' context")
    }
    for (const key of ['documentUrlPatterns', 'targetUrlPatterns'] as const) {
      const patterns = props[key]
      if (patterns === undefined || patterns === null) continue
      if (!Array.isArray(patterns)) throw new Error(`Invalid url pattern '${patterns}'`)
      if (patterns.length > MAX_PATTERNS) throw new Error(`Invalid url pattern '${patterns[MAX_PATTERNS]}'`)
      for (const pattern of patterns) {
        if (!isMenuPattern(pattern)) {
          throw new Error(`Invalid url pattern '${pattern}'`)
        }
      }
    }
    if (props.parentId !== undefined && props.parentId !== null) {
      const parent = this.find(extension.id, props.parentId)
      if (!parent) throw this.notFound(props.parentId)
      if ((parent.type || 'normal') !== 'normal') throw new Error('Parent items must have type "normal"')
    }
  }

  /** The item and every item under it, deepest first. */
  private descendants(extensionId: string, id: unknown): ContextItemProps[] {
    const items = this.menus.get(extensionId)
    if (!items) return []
    const out: ContextItemProps[] = []
    const walk = (parentKey: string) => {
      for (const item of items.values()) {
        if (item.parentId !== undefined && item.parentId !== null && menuKey(item.parentId) === parentKey) {
          walk(menuKey(item.id))
          out.push(item)
        }
      }
    }
    walk(menuKey(id))
    return out
  }

  private create = ({ extension }: ExtensionEvent, createProperties: unknown) => {
    if (!createProperties || typeof createProperties !== 'object' || Array.isArray(createProperties)) {
      throw new Error(
        'Error in invocation of contextMenus.create(contextMenus.CreateProperties createProperties, optional function callback): No matching signature.',
      )
    }
    const props = sanitizeProps(createProperties as Record<string, unknown>) as ContextItemProps
    if ((createProperties as any).onclick !== undefined && isLazyBackground(extension)) {
      throw new Error(
        'Extensions using event pages or Service Workers cannot pass an onclick parameter to chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.',
      )
    }
    if (props.id === undefined || props.id === null) {
      throw new Error(
        'Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create',
      )
    }
    if (typeof props.id !== 'string' && typeof props.id !== 'number') {
      throw new Error(`Cannot find menu item with id ${props.id}`)
    }
    if (this.find(extension.id, props.id)) {
      throw new Error(`Cannot create item with duplicate id ${props.id}`)
    }
    const items = this.menus.get(extension.id)
    if (items && items.size >= MAX_ITEMS) {
      throw new Error(`An extension cannot have more than ${MAX_ITEMS} menu items.`)
    }
    this.check(extension, props)
    if (props.type === 'radio' && props.checked === undefined) props.checked = false
    if (props.type === 'checkbox' && props.checked === undefined) props.checked = false
    this.addContextItem(extension.id, props)
  }

  private update = (
    { extension }: ExtensionEvent,
    menuItemId: unknown,
    updateProperties: unknown,
  ) => {
    if ((typeof menuItemId !== 'string' && typeof menuItemId !== 'number') || !updateProperties || typeof updateProperties !== 'object') {
      throw new Error(
        'Error in invocation of contextMenus.update([integer|string] id, object updateProperties, optional function callback): No matching signature.',
      )
    }
    const existing = this.find(extension.id, menuItemId)
    if (!existing) throw this.notFound(menuItemId)

    const changes = sanitizeProps(updateProperties as Record<string, unknown>)
    delete changes.id
    const next = { ...existing, ...changes } as ContextItemProps
    if ('parentId' in changes) {
      const parentId = changes.parentId
      // Chrome refuses an item as its own parent, or under one of its own
      // children, with this message.
      if (parentId !== undefined && parentId !== null) {
        if (menuKey(parentId) === menuKey(existing.id)) throw new Error('Unknown error.')
        if (this.descendants(extension.id, existing.id).some((d) => menuKey(d.id) === menuKey(parentId))) {
          throw new Error('Unknown error.')
        }
      }
    }
    this.check(extension, next)
    Object.assign(existing, changes)
  }

  private remove = ({ extension }: ExtensionEvent, menuItemId: unknown) => {
    if (typeof menuItemId !== 'string' && typeof menuItemId !== 'number') {
      throw new Error(
        'Error in invocation of contextMenus.remove([integer|string] menuItemId, optional function callback): No matching signature.',
      )
    }
    const items = this.menus.get(extension.id)
    if (!items || !this.find(extension.id, menuItemId)) throw this.notFound(menuItemId)
    // Removing an item removes the items under it, as in Chrome.
    for (const child of this.descendants(extension.id, menuItemId)) items.delete(menuKey(child.id))
    items.delete(menuKey(menuItemId))
    if (items.size === 0) this.menus.delete(extension.id)
  }

  private removeAll = ({ extension }: ExtensionEvent) => {
    this.menus.delete(extension.id)
  }

  private onClicked(
    extensionId: string,
    props: ContextItemProps,
    webContents: Electron.WebContents,
    params?: Electron.ContextMenuParams,
  ) {
    if (webContents.isDestroyed()) return

    const tab = this.ctx.store.tabDetailsCache.get(webContents.id)
    if (!tab) {
      console.error(`[Extensions] Unable to find tab for id=${webContents.id}`)
      return
    }

    // A checkbox flips; a radio item turns on and its group turns off.
    const wasChecked = props.checked === true
    if (props.type === 'checkbox') props.checked = !wasChecked
    if (props.type === 'radio') {
      const items = [...(this.menus.get(extensionId)?.values() ?? [])]
      const index = items.indexOf(props)
      for (const direction of [-1, 1]) {
        for (let i = index + direction; i >= 0 && i < items.length; i += direction) {
          const other = items[i]
          if (other.type !== 'radio' || menuKey(other.parentId) !== menuKey(props.parentId)) break
          other.checked = false
        }
      }
      props.checked = true
    }

    const data: Record<string, unknown> = {
      menuItemId: props.id,
      editable: params?.isEditable || false,
      pageUrl: params?.pageURL,
      frameId: params?.frameURL ? -1 : 0,
    }
    if (props.parentId !== undefined) data.parentMenuItemId = props.parentId
    if (params?.frameURL) data.frameUrl = params.frameURL
    if (params?.linkURL) data.linkUrl = params.linkURL
    if (params?.srcURL) data.srcUrl = params.srcURL
    if (params?.selectionText) data.selectionText = params.selectionText
    if (params?.mediaType && params.mediaType !== 'none') data.mediaType = params.mediaType
    if (props.type === 'checkbox' || props.type === 'radio') {
      data.wasChecked = wasChecked
      data.checked = props.checked === true
    }

    noteInvocation(this.ctx, extensionId, webContents)
    this.ctx.router.sendEvent(extensionId, 'contextMenus.onClicked', data, tabForExtension(this.ctx, extensionId, tab))
  }
}
