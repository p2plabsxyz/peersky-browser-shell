import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import {
  checkProps,
  globMatch,
  intAtLeast,
  noTabError,
  readIdList,
  signatureError,
  tabApis,
  TabGroupsLink,
  TabsAPI,
} from './tabs'
import type { TabContents } from './common'

/** The order Chrome hands out colors to new groups. */
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const
type Color = (typeof COLORS)[number]

const MAX_TITLE = 1024

const SIG = {
  group: 'tabs.group(object options, optional function callback)',
  ungroup: 'tabs.ungroup([integer|array] tabIds, optional function callback)',
  get: 'tabGroups.get(integer groupId, optional function callback)',
  query: 'tabGroups.query(object queryInfo, optional function callback)',
  update: 'tabGroups.update(integer groupId, object updateProperties, optional function callback)',
  move: 'tabGroups.move(integer groupId, object moveProperties, optional function callback)',
}

const MOVE_BETWEEN_WINDOWS = 'Tabs can only be moved within their window in this browser.'

interface Group {
  id: number
  title: string
  color: Color
  collapsed: boolean
  windowId: number
}

export type TabGroupChange = 'created' | 'updated' | 'moved' | 'removed'

/**
 * Tab groups, kept by the library as Chrome keeps them: each group sits in
 * one window, its tabs side by side, never pinned. The host shows them
 * through the optional `updateTabGroup` hook, or by following the
 * 'tab-group-created', 'tab-group-updated', 'tab-group-moved' and
 * 'tab-group-removed' events on the ElectronChromeExtensions instance, and
 * changes them from its own UI with the public methods here.
 */
export class TabGroupsAPI implements TabGroupsLink {
  private groups = new Map<number, Group>()
  private tabGroup = new Map<number, number>()
  private nextId = 1

  constructor(private ctx: ExtensionContext) {
    tabApis(ctx).groups = this
    const handle = this.ctx.router.apiHandler()
    // tabs.group and tabs.ungroup need no permission, as in Chrome.
    handle('tabs.group', this.handleGroup.bind(this))
    handle('tabs.ungroup', this.handleUngroup.bind(this))
    handle('tabGroups.get', this.get.bind(this))
    handle('tabGroups.query', this.query.bind(this))
    handle('tabGroups.update', this.update.bind(this))
    handle('tabGroups.move', this.move.bind(this))

    // A tab shown from a collapsed group opens the group, as in Chrome.
    this.ctx.store.on('active-tab-changed', (tab: Electron.WebContents) => {
      const group = this.groups.get(this.groupIdOf(tab.id))
      if (group?.collapsed) {
        group.collapsed = false
        this.notify('updated', group)
      }
    })
  }

  private tabs(): TabsAPI {
    const tabs = tabApis(this.ctx).tabs
    if (!tabs) throw new Error('Tabs are not available.')
    return tabs
  }

  // ---------------------------------------------------------- model

  groupIdOf(tabId: number) {
    return this.tabGroup.get(tabId) ?? -1
  }

  private info(group: Group): chrome.tabGroups.TabGroup {
    return {
      collapsed: group.collapsed,
      color: group.color as chrome.tabGroups.ColorEnum,
      id: group.id,
      shared: false,
      title: group.title,
      windowId: group.windowId,
    } as chrome.tabGroups.TabGroup
  }

  private requireGroup(groupId: unknown) {
    const group = typeof groupId === 'number' ? this.groups.get(groupId) : undefined
    if (!group) throw new Error(`No group with id: ${groupId}.`)
    return group
  }

  private windowOfGroup(group: Group) {
    return this.ctx.store.getWindowById(group.windowId)
  }

  /** The group's tabs, in their order in the window. */
  private tabsOf(group: Group): TabContents[] {
    const win = this.windowOfGroup(group)
    return this.tabs()
      .windowTabs(win)
      .filter((tab) => this.tabGroup.get(tab.id) === group.id)
  }

  private notify(change: TabGroupChange, group: Group, opts: { toExtensions?: boolean } = {}) {
    const info = this.info(group)
    const tabIds = change === 'removed' ? [] : this.tabsOf(group).map((t) => t.id)
    const win = this.windowOfGroup(group)
    if (typeof this.ctx.store.impl.updateTabGroup === 'function') {
      try {
        this.ctx.store.impl.updateTabGroup({ group: info, tabIds, window: win, removed: change === 'removed' })
      } catch (error) {
        console.error('updateTabGroup failed:', error)
      }
    }
    this.ctx.emit(`tab-group-${change}`, info, tabIds)
    if (opts.toExtensions !== false) {
      const name = { created: 'onCreated', updated: 'onUpdated', moved: 'onMoved', removed: 'onRemoved' }[change]
      this.ctx.router.broadcastEvent(`tabGroups.${name}`, info)
    }
  }

  /** The tabs of a group changed; extensions hear of it through tabs.onUpdated. */
  private membershipChanged(group: Group) {
    if (this.groups.has(group.id)) this.notify('updated', group, { toExtensions: false })
  }

  private dropIfEmpty(groupId: number) {
    const group = this.groups.get(groupId)
    if (!group) return
    if ([...this.tabGroup.values()].includes(groupId)) {
      this.membershipChanged(group)
      return
    }
    this.groups.delete(groupId)
    this.notify('removed', group)
  }

  private pickColor(windowId: number): Color {
    const used = new Map<Color, number>(COLORS.map((c) => [c, 0]))
    for (const group of this.groups.values()) {
      if (group.windowId === windowId) used.set(group.color, (used.get(group.color) || 0) + 1)
    }
    let best: Color = COLORS[0]
    for (const color of COLORS) if (used.get(color)! < used.get(best)!) best = color
    return best
  }

  /** Puts a window's tabs in this order, one move at a time, as the host keeps them. */
  private async arrange(win: Electron.BaseWindow, order: number[]) {
    const tabs = this.tabs()
    for (let i = 0; i < order.length; i++) {
      const current = tabs.windowTabs(win)
      if (current[i]?.id === order[i]) continue
      const tab = current.find((t) => t.id === order[i])
      if (tab) await tabs.moveInWindow(tab, win, i)
    }
  }

  // ---------------------------------------------------------- TabGroupsLink

  tabRemoved(tabId: number) {
    const groupId = this.tabGroup.get(tabId)
    if (groupId === undefined) return
    this.tabGroup.delete(tabId)
    this.dropIfEmpty(groupId)
  }

  leaveGroup(tabId: number) {
    this.tabRemoved(tabId)
  }

  tabMoved(tabId: number) {
    const tabs = this.tabs()
    const tab = tabs.getTab(tabId)
    const win = tab && tabs.windowOf(tab)
    if (!tab || !win) return
    const list = tabs.windowTabs(win)
    const i = list.findIndex((t) => t.id === tabId)
    const left = i > 0 ? this.groupIdOf(list[i - 1].id) : -1
    const right = i < list.length - 1 ? this.groupIdOf(list[i + 1].id) : -1
    const mine = this.groupIdOf(tabId)
    let next = -1
    if (left !== -1 && left === right) next = left
    else if (mine !== -1 && (left === mine || right === mine)) next = mine
    else if (mine !== -1 && this.tabsOf(this.groups.get(mine)!).length === 1) next = mine
    if (tabs.isPinned(tabId)) next = -1
    if (next === mine) return
    if (next === -1) this.tabGroup.delete(tabId)
    else this.tabGroup.set(tabId, next)
    if (mine !== -1) this.dropIfEmpty(mine)
    if (next !== -1) this.membershipChanged(this.groups.get(next)!)
    tabs.onUpdated(tabId)
  }

  // ---------------------------------------------------------- for the host

  /**
   * Groups tabs, into `groupId` or a new group in `windowId` (the first tab's
   * window by default). Returns the group id.
   */
  async groupTabs(tabIds: number[], opts: { groupId?: number; windowId?: number } = {}): Promise<number> {
    const tabs = this.tabs()
    const list = tabIds.map((id) => {
      const tab = tabs.getTab(id)
      if (!tab) throw noTabError(id)
      return tab
    })
    if (!list.length) throw new Error('You must specify at least one tab.')
    const existing = opts.groupId !== undefined ? this.requireGroup(opts.groupId) : undefined
    const win = existing
      ? this.windowOfGroup(existing)
      : opts.windowId !== undefined
        ? this.ctx.store.getWindowById(opts.windowId)
        : tabs.windowOf(list[0])
    if (!win) throw new Error(`No window with id: ${existing ? existing.windowId : opts.windowId}.`)
    if (tabApis(this.ctx).windows?.typeOf(win) !== 'normal') {
      throw new Error('Tabs can only be moved to and from normal windows.')
    }
    if (list.some((tab) => tabs.windowOf(tab) !== win)) throw new Error(MOVE_BETWEEN_WINDOWS)

    // Pinned tabs are unpinned to join a group, as in Chrome.
    for (const tab of list) if (tabs.isPinned(tab.id)) await tabs.setPinned(tab, win, false)

    const group: Group = existing ?? {
      id: this.nextId++,
      title: '',
      color: this.pickColor(win.id),
      collapsed: false,
      windowId: win.id,
    }
    const before = this.tabs().windowTabs(win).map((t) => t.id)
    const joining = new Set(list.map((t) => t.id))
    const rest = before.filter((id) => !joining.has(id))
    let at: number
    if (existing) {
      const members = rest.filter((id) => this.tabGroup.get(id) === group.id)
      at = members.length ? rest.indexOf(members[members.length - 1]) + 1 : rest.length
    } else {
      // A new group starts where the first of its tabs was.
      const first = before.findIndex((id) => joining.has(id))
      at = before.slice(0, first).filter((id) => !joining.has(id)).length
    }
    const joiningInOrder = existing ? list.map((t) => t.id) : before.filter((id) => joining.has(id))
    const order = [...rest.slice(0, at), ...joiningInOrder, ...rest.slice(at)]

    if (!existing) {
      this.groups.set(group.id, group)
      this.notify('created', group)
    }
    const left = new Set<number>()
    for (const id of joining) {
      const previous = this.tabGroup.get(id)
      if (previous !== undefined && previous !== group.id) left.add(previous)
      this.tabGroup.set(id, group.id)
    }
    await this.arrange(win, order)
    for (const previous of left) this.dropIfEmpty(previous)
    this.membershipChanged(group)
    for (const id of joining) tabs.onUpdated(id)
    return group.id
  }

  /** Takes tabs out of their groups; a group left with no tabs is gone. */
  async ungroupTabs(tabIds: number[]) {
    const tabs = this.tabs()
    const list = tabIds.map((id) => {
      const tab = tabs.getTab(id)
      if (!tab) throw noTabError(id)
      return tab
    })
    for (const tab of list) {
      const groupId = this.tabGroup.get(tab.id)
      if (groupId === undefined) continue
      const group = this.groups.get(groupId)!
      const win = tabs.windowOf(tab)
      const members = this.tabsOf(group)
      // The tab leaves past the end of its group, so the group stays in one piece.
      const last = members[members.length - 1]
      if (win && last && last.id !== tab.id) {
        const lastIndex = tabs.windowTabs(win).findIndex((t) => t.id === last.id)
        await tabs.moveInWindow(tab, win, lastIndex)
      }
      this.tabGroup.delete(tab.id)
      this.dropIfEmpty(groupId)
      tabs.onUpdated(tab.id)
    }
  }

  /** Changes a group's title, color or collapsed state. */
  updateGroup(groupId: number, props: { title?: string; color?: string; collapsed?: boolean }) {
    const group = this.requireGroup(groupId)
    let changed = false
    if (typeof props.title === 'string' && props.title !== group.title) {
      group.title = props.title.slice(0, MAX_TITLE)
      changed = true
    }
    if (typeof props.color === 'string' && props.color !== group.color && COLORS.includes(props.color as Color)) {
      group.color = props.color as Color
      changed = true
    }
    if (typeof props.collapsed === 'boolean' && props.collapsed !== group.collapsed) {
      group.collapsed = props.collapsed
      changed = true
      if (group.collapsed) this.leaveActiveTabOut(group)
    }
    if (changed) this.notify('updated', group)
    return this.info(group)
  }

  /** Collapsing hides a group's tabs, so the active tab moves to the nearest tab outside it. */
  private leaveActiveTabOut(group: Group) {
    const win = this.windowOfGroup(group)
    if (!win) return
    const active = this.ctx.store.getActiveTabFromWindow(win)
    if (!active || this.groupIdOf(active.id) !== group.id) return
    const list = this.tabs().windowTabs(win)
    const i = list.findIndex((t) => t.id === active.id)
    const after = list.slice(i + 1).find((t) => this.groupIdOf(t.id) !== group.id)
    const before = list.slice(0, i).reverse().find((t) => this.groupIdOf(t.id) !== group.id)
    const next = after ?? before
    if (next) this.tabs().onActivated(next.id)
  }

  // ---------------------------------------------------------- handlers

  private async handleGroup(event: ExtensionEvent, options: unknown) {
    const opts = checkProps(
      SIG.group,
      'options',
      options,
      { groupId: 'integer', createProperties: 'object' },
      { required: ['tabIds'] },
    )
    const ids = readIdList(SIG.group, opts.tabIds)
    if (opts.groupId !== undefined && opts.createProperties !== undefined) {
      throw new Error("Cannot specify 'createProperties' along with a 'groupId'.")
    }
    let windowId: number | undefined
    if (opts.createProperties) {
      const create = checkProps(SIG.group, 'options', opts.createProperties, { windowId: intAtLeast(-2) })
      if (create.windowId === -2) {
        const current = this.tabs().currentWindow(event)
        if (!current) throw new Error('No current window')
        windowId = current.id
      } else {
        windowId = create.windowId
      }
    }
    return this.groupTabs(ids, { groupId: opts.groupId, windowId })
  }

  private async handleUngroup(event: ExtensionEvent, tabIds: unknown) {
    const ids = readIdList(SIG.ungroup, tabIds)
    if (!ids.length) throw new Error('You must specify at least one tab.')
    await this.ungroupTabs(ids)
  }

  private get(event: ExtensionEvent, groupId: unknown) {
    if (!Number.isSafeInteger(groupId)) throw signatureError(SIG.get)
    return this.info(this.requireGroup(groupId))
  }

  private query(event: ExtensionEvent, queryInfo: unknown) {
    const info = checkProps(SIG.query, 'queryInfo', queryInfo ?? {}, {
      collapsed: 'boolean',
      color: COLORS,
      shared: 'boolean',
      title: 'string',
      windowId: intAtLeast(-2),
    })
    let windowId = info.windowId as number | undefined
    if (windowId === -2) windowId = this.tabs().currentWindow(event)?.id ?? -1
    const tabs = this.tabs()
    const out: chrome.tabGroups.TabGroup[] = []
    for (const win of this.ctx.store.windows) {
      const seen = new Set<number>()
      for (const tab of tabs.windowTabs(win)) {
        const group = this.groups.get(this.groupIdOf(tab.id))
        if (!group || seen.has(group.id)) continue
        seen.add(group.id)
        if (info.collapsed !== undefined && info.collapsed !== group.collapsed) continue
        if (info.color !== undefined && info.color !== group.color) continue
        if (info.shared === true) continue
        if (info.title !== undefined && !globMatch(info.title, group.title)) continue
        if (windowId !== undefined && windowId !== group.windowId) continue
        out.push(this.info(group))
      }
    }
    return out
  }

  private update(event: ExtensionEvent, groupId: unknown, updateProperties: unknown) {
    if (!Number.isSafeInteger(groupId)) throw signatureError(SIG.update)
    const props = checkProps(SIG.update, 'updateProperties', updateProperties, {
      collapsed: 'boolean',
      color: COLORS,
      title: 'string',
    })
    return this.updateGroup(groupId as number, props)
  }

  private async move(event: ExtensionEvent, groupId: unknown, moveProperties: unknown) {
    if (!Number.isSafeInteger(groupId)) throw signatureError(SIG.move)
    const props = checkProps(
      SIG.move,
      'moveProperties',
      moveProperties,
      { index: intAtLeast(-1), windowId: intAtLeast(-2) },
      { required: ['index'] },
    )
    const group = this.requireGroup(groupId)
    const win = this.windowOfGroup(group)
    if (!win) throw new Error(`No group with id: ${groupId}.`)
    if (props.windowId !== undefined) {
      const target = props.windowId === -2 ? this.tabs().currentWindow(event) : this.ctx.store.getWindowById(props.windowId)
      if (!target) throw new Error(`No window with id: ${props.windowId}.`)
      if (target !== win) throw new Error(MOVE_BETWEEN_WINDOWS)
    }

    const tabs = this.tabs()
    const before = tabs.windowTabs(win).map((t) => t.id)
    const members = before.filter((id) => this.tabGroup.get(id) === group.id)
    const rest = before.filter((id) => this.tabGroup.get(id) !== group.id)
    const at = props.index === -1 ? rest.length : Math.min(props.index, rest.length)
    const pinned = rest.filter((id) => tabs.isPinned(id)).length
    if (at < pinned) throw new Error('Cannot move the group to an index that is in the middle of pinned tabs.')
    if (at > 0 && at < rest.length) {
      const leftGroup = this.groupIdOf(rest[at - 1])
      if (leftGroup !== -1 && leftGroup === this.groupIdOf(rest[at])) {
        throw new Error('Cannot move the group to an index that is in the middle of another group.')
      }
    }
    const order = [...rest.slice(0, at), ...members, ...rest.slice(at)]
    const moved = order.some((id, i) => before[i] !== id)
    await this.arrange(win, order)
    if (moved) this.notify('moved', group)
    return this.info(group)
  }
}
