import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ArgSpec, checkArgs, MAX_URL_LENGTH, ParamSpec, sendToPermitted, tryParseUrl } from './lib/arg-spec'

/** A bookmark as it is kept: plain data, so the state store can write it as is. */
interface StoredNode {
  id: string
  title: string
  url?: string
  dateAdded: number
  dateGroupModified?: number
  dateLastUsed?: number
  children?: StoredNode[]
}

interface StoredTree {
  version: 1
  nextId: number
  root: StoredNode
}

/** A bookmark or folder a host hands in, from its own bookmarks or an import. */
export interface BookmarkImportNode {
  title?: string
  /** Leave out for a folder. */
  url?: string
  /** Milliseconds since the epoch; now when left out. */
  dateAdded?: number
  children?: BookmarkImportNode[]
}

/** What `ElectronChromeExtensions` emits as 'bookmarks-changed' when an extension changes a bookmark. */
export type BookmarkChange = { extensionId: string } & (
  | { type: 'created'; id: string; node: chrome.bookmarks.BookmarkTreeNode }
  | { type: 'removed'; id: string; parentId: string; index: number; node: chrome.bookmarks.BookmarkTreeNode }
  | { type: 'changed'; id: string; title: string; url?: string }
  | { type: 'moved'; id: string; parentId: string; index: number; oldParentId: string; oldIndex: number }
)

const STATE_NS = 'bookmarks'
const ROOT_ID = '0'
const BAR_ID = '1'
const OTHER_ID = '2'
const MOBILE_ID = '3'
/** Chrome gives 4 to its managed bookmarks folder, so the first bookmark gets 5 there too. */
const FIRST_USER_ID = 5
const FOLDER_TYPES: Record<string, string> = {
  [BAR_ID]: 'bookmarks-bar',
  [OTHER_ID]: 'other',
  [MOBILE_ID]: 'mobile',
}
const PERMANENT_TITLES: Record<string, string> = {
  [BAR_ID]: 'Bookmarks Bar',
  [OTHER_ID]: 'Other Bookmarks',
  [MOBILE_ID]: 'Mobile Bookmarks',
}

// Chrome sets no limit, but this tree is kept in one JSON file: an extension
// must not be able to grow it without bound.
const MAX_NODES = 50_000
const MAX_TOTAL_CHARS = 32 * 1024 * 1024
const MAX_IMPORT_DEPTH = 64
/** Deeper trees would not survive being written as JSON. */
const MAX_DEPTH = 200
const FULL_ERROR = 'Bookmark storage is full.'
const DEPTH_ERROR = 'Bookmark folders are nested too deeply.'

const ERR = {
  noNode: "Can't find bookmark for id.",
  noParent: "Can't find parent bookmark for id.",
  invalidId: 'Bookmark id is invalid.',
  invalidIndex: 'Index out of bounds.',
  invalidUrl: 'Invalid URL.',
  modifySpecial: "Can't modify the root bookmark folders.",
  folderNotEmpty: "Can't remove non-empty folder (use recursive to force).",
  notFolder: "Parameter 'parentId' does not specify a folder.",
  folderUrl: "Can't set URL of a bookmark folder.",
  moveIntoSelf: "Can't move a folder to itself or its descendant.",
}

const sig = (name: string, params: string) => `bookmarks.${name}(${params}, optional function callback)`
const idParam: ParamSpec = { name: 'id', spec: { type: 'string' } }
const SIGNATURES: Record<string, [string, ParamSpec[]]> = {
  get: [
    sig('get', '[string|array] idOrIdList'),
    [
      {
        name: 'idOrIdList',
        spec: { choices: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
      },
    ],
  ],
  getChildren: [sig('getChildren', 'string id'), [idParam]],
  getRecent: [
    sig('getRecent', 'integer numberOfItems'),
    [{ name: 'numberOfItems', spec: { type: 'integer', minimum: 1 } }],
  ],
  getTree: ['bookmarks.getTree(optional function callback)', []],
  getSubTree: [sig('getSubTree', 'string id'), [idParam]],
  search: [
    sig('search', '[string|object] query'),
    [
      {
        name: 'query',
        spec: {
          choices: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                query: { type: 'string', optional: true },
                url: { type: 'string', optional: true },
                title: { type: 'string', optional: true },
              },
            },
          ],
        },
      },
    ],
  ],
  create: [
    sig('create', 'bookmarks.CreateDetails bookmark'),
    [
      {
        name: 'bookmark',
        spec: {
          type: 'object',
          properties: {
            parentId: { type: 'string', optional: true },
            index: { type: 'integer', minimum: 0, optional: true },
            title: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
          },
        },
      },
    ],
  ],
  move: [
    sig('move', 'string id, object destination'),
    [
      idParam,
      {
        name: 'destination',
        spec: {
          type: 'object',
          properties: {
            parentId: { type: 'string', optional: true },
            index: { type: 'integer', minimum: 0, optional: true },
          },
        },
      },
    ],
  ],
  update: [
    sig('update', 'string id, object changes'),
    [
      idParam,
      {
        name: 'changes',
        spec: {
          type: 'object',
          properties: {
            title: { type: 'string', optional: true },
            url: { type: 'string', optional: true },
          },
        },
      },
    ],
  ],
  remove: [sig('remove', 'string id'), [idParam]],
  removeTree: [sig('removeTree', 'string id'), [idParam]],
}

/** Chrome's ids are 64-bit integers written as decimal strings. */
const parseId = (id: string) => (/^-?\d{1,19}$/.test(id) ? id.replace(/^(-?)0+(?=\d)/, '$1') : undefined)

/** A URL as Chrome keeps it (its canonical form), or undefined when it is not one. */
const canonicalUrl = (value: string) => {
  if (value.length > MAX_URL_LENGTH) return undefined
  return tryParseUrl(value)?.href
}

const isFolder = (node: StoredNode) => node.url === undefined

const searchWords = (text: string) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^"+|"+$/g, ''))
    .filter(Boolean)

/** Case and accent blind, as Chrome's bookmark search is. */
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * chrome.bookmarks: a tree like Chrome's, with its permanent folders, ids,
 * events and errors, kept per session in the state store.
 */
export class BookmarksAPI {
  private tree?: StoredTree
  private byId = new Map<string, StoredNode>()
  private parents = new Map<string, StoredNode>()
  private totalChars = 0
  private loading?: Promise<StoredTree>
  private flushTimer?: NodeJS.Timeout

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const wrap =
      (name: keyof typeof SIGNATURES, fn: (event: ExtensionEvent, ...args: any[]) => any) =>
      async (event: ExtensionEvent, ...args: any[]) => {
        const [signature, params] = SIGNATURES[name]
        const resolved = checkArgs(signature, params, args)
        await this.load()
        return fn.call(this, event, ...resolved)
      }
    handle('bookmarks.get', wrap('get', this.get))
    handle('bookmarks.getChildren', wrap('getChildren', this.getChildren))
    handle('bookmarks.getRecent', wrap('getRecent', this.getRecent))
    handle('bookmarks.getTree', wrap('getTree', this.getTree))
    handle('bookmarks.getSubTree', wrap('getSubTree', this.getSubTree))
    handle('bookmarks.search', wrap('search', this.search))
    handle('bookmarks.create', wrap('create', this.create))
    handle('bookmarks.move', wrap('move', this.move))
    handle('bookmarks.update', wrap('update', this.update))
    handle('bookmarks.remove', wrap('remove', (event, id) => this.remove(event, id, false)))
    handle('bookmarks.removeTree', wrap('removeTree', (event, id) => this.remove(event, id, true)))
  }

  // ------------------------------------------------------------ the tree

  private freshTree(): StoredTree {
    const now = Date.now()
    const folder = (id: string): StoredNode => ({ id, title: PERMANENT_TITLES[id], dateAdded: now, children: [] })
    return {
      version: 1,
      nextId: FIRST_USER_ID,
      root: { id: ROOT_ID, title: '', dateAdded: now, children: [folder(BAR_ID), folder(OTHER_ID), folder(MOBILE_ID)] },
    }
  }

  /** Reads the tree once, after the state store has read its file. */
  private load(): Promise<StoredTree> {
    if (this.tree) return Promise.resolve(this.tree)
    if (!this.loading) {
      this.loading = this.ctx.stateStore.whenHydrated().then(() => {
        if (this.tree) return this.tree
        const saved = this.ctx.stateStore.getNamespace<StoredTree | null>(STATE_NS, null)
        let tree = saved && this.isValidTree(saved) ? saved : undefined
        if (!tree) {
          tree = this.freshTree()
          this.ctx.stateStore.setNamespace(STATE_NS, tree)
        }
        this.adopt(tree)
        return tree
      })
    }
    return this.loading
  }

  /** A saved tree is used only when it has Chrome's shape; a damaged one is replaced. */
  private isValidTree(tree: any): tree is StoredTree {
    if (!tree || tree.version !== 1 || typeof tree.nextId !== 'number') return false
    const root = tree.root
    if (!root || root.id !== ROOT_ID || !Array.isArray(root.children)) return false
    const ids = root.children.map((c: any) => c && c.id)
    if (ids[0] !== BAR_ID || ids[1] !== OTHER_ID || ids[2] !== MOBILE_ID || ids.length !== 3) return false
    const seen = new Set<string>()
    const walk = (node: any, depth: number): boolean => {
      if (!node || typeof node.id !== 'string' || seen.has(node.id) || depth > 1000) return false
      if (typeof node.title !== 'string' || typeof node.dateAdded !== 'number') return false
      seen.add(node.id)
      if (node.url !== undefined) return typeof node.url === 'string' && node.children === undefined
      return Array.isArray(node.children) && node.children.every((c: any) => walk(c, depth + 1))
    }
    return walk(root, 0) && seen.size <= MAX_NODES + 4
  }

  private adopt(tree: StoredTree) {
    this.tree = tree
    this.byId.clear()
    this.parents.clear()
    this.totalChars = 0
    const walk = (node: StoredNode, parent?: StoredNode) => {
      this.byId.set(node.id, node)
      if (parent) this.parents.set(node.id, parent)
      this.totalChars += node.title.length + (node.url?.length ?? 0)
      for (const child of node.children ?? []) walk(child, node)
    }
    walk(tree.root)
  }

  private persist() {
    this.ctx.stateStore.setNamespace(STATE_NS, this.tree)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.ctx.stateStore.flush().catch((error) => {
        console.error('Failed to save bookmarks:', error)
      })
    }, 250)
    this.flushTimer.unref?.()
  }

  private isPermanent(node: StoredNode) {
    return node.id === ROOT_ID || node.id in FOLDER_TYPES
  }

  /** Chrome hides Mobile bookmarks from extensions while it is empty. */
  private isVisible(node: StoredNode) {
    return node.id !== MOBILE_ID || (node.children?.length ?? 0) > 0
  }

  private lookup(id: string): StoredNode | undefined {
    const node = this.byId.get(id)
    return node && this.isVisible(node) ? node : undefined
  }

  /** Chrome's lookup of an id an extension passed: invalid, missing, or the node. */
  private nodeFromId(id: string): StoredNode {
    const parsed = parseId(id)
    if (parsed === undefined) throw new Error(ERR.invalidId)
    const node = this.lookup(parsed)
    if (!node) throw new Error(ERR.noNode)
    return node
  }

  private indexOf(node: StoredNode) {
    const parent = this.parents.get(node.id)
    return parent ? parent.children!.indexOf(node) : -1
  }

  /** The node as chrome.bookmarks gives it. `detached` leaves out where it was, for onRemoved. */
  private toTreeNode(node: StoredNode, recurse: boolean, detached = false): chrome.bookmarks.BookmarkTreeNode {
    const out: any = { id: node.id, title: node.title, dateAdded: node.dateAdded, syncing: false }
    const parent = this.parents.get(node.id)
    if (parent && !detached) {
      out.parentId = parent.id
      out.index = parent.children!.indexOf(node)
    }
    if (node.url !== undefined) {
      out.url = node.url
      if (node.dateLastUsed) out.dateLastUsed = node.dateLastUsed
    } else if (node.dateGroupModified) {
      out.dateGroupModified = node.dateGroupModified
    }
    if (FOLDER_TYPES[node.id]) out.folderType = FOLDER_TYPES[node.id]
    if (recurse && node.children) {
      out.children = node.children.filter((c) => this.isVisible(c)).map((c) => this.toTreeNode(c, true))
    }
    return out
  }

  private countNodes(node: StoredNode): number {
    let n = 1
    for (const child of node.children ?? []) n += this.countNodes(child)
    return n
  }

  private charsOf(node: StoredNode): number {
    let n = node.title.length + (node.url?.length ?? 0)
    for (const child of node.children ?? []) n += this.charsOf(child)
    return n
  }

  /** How far below the root a node is: 1 for the permanent folders. */
  private depthOf(node: StoredNode) {
    let depth = 0
    for (let p = this.parents.get(node.id); p; p = this.parents.get(p.id)) depth++
    return depth
  }

  /** Levels in a subtree: 1 for a bookmark or an empty folder. */
  private heightOf(node: StoredNode): number {
    let height = 0
    for (const child of node.children ?? []) height = Math.max(height, this.heightOf(child))
    return height + 1
  }

  private ensureRoom(nodes: number, chars: number) {
    if (this.byId.size + nodes > MAX_NODES + 4 || this.totalChars + chars > MAX_TOTAL_CHARS) {
      throw new Error(FULL_ERROR)
    }
  }

  private attach(node: StoredNode, parent: StoredNode, index: number) {
    parent.children!.splice(index, 0, node)
    const walk = (n: StoredNode, p: StoredNode) => {
      this.byId.set(n.id, n)
      this.parents.set(n.id, p)
      this.totalChars += n.title.length + (n.url?.length ?? 0)
      for (const c of n.children ?? []) walk(c, n)
    }
    walk(node, parent)
  }

  private detach(node: StoredNode) {
    const parent = this.parents.get(node.id)!
    parent.children!.splice(parent.children!.indexOf(node), 1)
    const walk = (n: StoredNode) => {
      this.byId.delete(n.id)
      this.parents.delete(n.id)
      this.totalChars -= n.title.length + (n.url?.length ?? 0)
      for (const c of n.children ?? []) walk(c)
    }
    walk(node)
  }

  private newId() {
    const tree = this.tree!
    while (this.byId.has(String(tree.nextId))) tree.nextId++
    return String(tree.nextId++)
  }

  private emitChange(change: BookmarkChange) {
    this.ctx.emit('bookmarks-changed', change)
  }

  private dispatch(eventName: string, ...args: any[]) {
    sendToPermitted(this.ctx, 'bookmarks', eventName, ...args)
  }

  // ------------------------------------------------------------ reads

  private get(_event: ExtensionEvent, idOrIdList: string | string[]) {
    const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList]
    return ids.map((id) => this.toTreeNode(this.nodeFromId(id), false))
  }

  private getChildren(_event: ExtensionEvent, id: string) {
    const node = this.nodeFromId(id)
    return (node.children ?? []).filter((c) => this.isVisible(c)).map((c) => this.toTreeNode(c, false))
  }

  private getRecent(_event: ExtensionEvent, count: number) {
    const urls: StoredNode[] = []
    for (const node of this.byId.values()) if (node.url !== undefined) urls.push(node)
    urls.sort((a, b) => b.dateAdded - a.dateAdded || Number(b.id) - Number(a.id))
    return urls.slice(0, count).map((n) => this.toTreeNode(n, false))
  }

  private getTree() {
    return [this.toTreeNode(this.tree!.root, true)]
  }

  private getSubTree(_event: ExtensionEvent, id: string) {
    return [this.toTreeNode(this.nodeFromId(id), true)]
  }

  private search(_event: ExtensionEvent, query: string | { query?: string; url?: string; title?: string }) {
    const fields = typeof query === 'string' ? { query } : query
    const words = fields.query !== undefined ? searchWords(fold(fields.query)) : []
    // An empty text query finds nothing, as in Chrome.
    if (fields.query !== undefined && words.length === 0) return []
    let url: string | undefined
    if (fields.url !== undefined) {
      url = canonicalUrl(fields.url)
      if (!url) return []
    }
    const matches: StoredNode[] = []
    const visit = (node: StoredNode) => {
      if (!this.isPermanent(node) && this.matches(node, words, url, fields.title)) matches.push(node)
      for (const child of node.children ?? []) if (this.isVisible(child)) visit(child)
    }
    visit(this.tree!.root)
    return matches.map((n) => this.toTreeNode(n, false))
  }

  /** Every word in the title, or every word in the URL; title and URL exact. */
  private matches(node: StoredNode, words: string[], url?: string, title?: string) {
    if (words.length) {
      const inText = (text: string) => {
        const folded = fold(text)
        return words.every((w) => folded.includes(w))
      }
      let decoded = node.url ?? ''
      try {
        decoded = decodeURI(decoded)
      } catch {}
      if (!inText(node.title) && !(node.url !== undefined && (inText(node.url) || inText(decoded)))) return false
    }
    if (title !== undefined && node.title !== title) return false
    if (url !== undefined && node.url !== url) return false
    return true
  }

  // ------------------------------------------------------------ writes

  /** Chrome's check before any change: the node exists and is not the root. */
  private modifiable(node: StoredNode | undefined, missing = ERR.noParent): StoredNode {
    if (!node) throw new Error(missing)
    if (node.id === ROOT_ID) throw new Error(ERR.modifySpecial)
    return node
  }

  private create(event: ExtensionEvent, details: { parentId?: string; index?: number; title?: string; url?: string }) {
    let parentId = OTHER_ID
    if (details.parentId !== undefined) {
      const parsed = parseId(details.parentId)
      if (parsed === undefined) throw new Error(ERR.invalidId)
      parentId = parsed
    }
    const parent = this.modifiable(this.lookup(parentId))
    if (!isFolder(parent)) throw new Error(ERR.notFolder)
    const count = parent.children!.length
    const index = details.index ?? count
    if (index > count) throw new Error(ERR.invalidIndex)
    const title = details.title ?? ''
    let url: string | undefined
    if (details.url) {
      url = canonicalUrl(details.url)
      if (!url) throw new Error(ERR.invalidUrl)
    }
    this.ensureRoom(1, title.length + (url?.length ?? 0))
    if (this.depthOf(parent) + 1 > MAX_DEPTH) throw new Error(DEPTH_ERROR)
    const now = Date.now()
    const node: StoredNode =
      url !== undefined
        ? { id: this.newId(), title, url, dateAdded: now }
        : { id: this.newId(), title, dateAdded: now, dateGroupModified: now, children: [] }
    this.attach(node, parent, index)
    if (url !== undefined) parent.dateGroupModified = now
    this.persist()
    const result = this.toTreeNode(node, false)
    this.dispatch('bookmarks.onCreated', node.id, result)
    this.emitChange({ type: 'created', id: node.id, node: result, extensionId: event.extension.id })
    return result
  }

  private move(event: ExtensionEvent, id: string, destination: { parentId?: string; index?: number }) {
    const node = this.nodeFromId(id)
    if (this.isPermanent(node)) throw new Error(ERR.modifySpecial)
    let parent: StoredNode | undefined
    if (destination.parentId === undefined) {
      parent = this.parents.get(node.id)
    } else {
      const parsed = parseId(destination.parentId)
      if (parsed === undefined) throw new Error(ERR.invalidId)
      parent = this.lookup(parsed)
    }
    parent = this.modifiable(parent)
    if (!isFolder(parent)) throw new Error(ERR.notFolder)
    for (let p: StoredNode | undefined = parent; p; p = this.parents.get(p.id)) {
      if (p === node) throw new Error(ERR.moveIntoSelf)
    }
    const count = parent.children!.length
    let index = destination.index ?? count
    if (index > count) throw new Error(ERR.invalidIndex)
    if (this.depthOf(parent) + this.heightOf(node) > MAX_DEPTH) throw new Error(DEPTH_ERROR)
    const oldParent = this.parents.get(node.id)!
    const oldIndex = oldParent.children!.indexOf(node)
    // Chrome counts the index before the node leaves its place.
    if (oldParent === parent && (index === oldIndex || index === oldIndex + 1)) {
      return this.toTreeNode(node, false)
    }
    if (oldParent === parent && index > oldIndex) index--
    oldParent.children!.splice(oldIndex, 1)
    parent.children!.splice(index, 0, node)
    this.parents.set(node.id, parent)
    parent.dateGroupModified = Date.now()
    this.persist()
    const info = { parentId: parent.id, index, oldParentId: oldParent.id, oldIndex }
    this.dispatch('bookmarks.onMoved', node.id, info)
    this.emitChange({ type: 'moved', id: node.id, ...info, extensionId: event.extension.id })
    return this.toTreeNode(node, false)
  }

  private update(event: ExtensionEvent, id: string, changes: { title?: string; url?: string }) {
    let url: string | undefined
    if (changes.url) {
      url = canonicalUrl(changes.url)
      if (!url) throw new Error(ERR.invalidUrl)
    }
    const parsed = parseId(id)
    const node = this.modifiable(parsed === undefined ? undefined : this.lookup(parsed))
    if (this.isPermanent(node)) throw new Error(ERR.modifySpecial)
    if (url !== undefined && isFolder(node)) throw new Error(ERR.folderUrl)
    const extra = (changes.title?.length ?? 0) + (url?.length ?? 0) - node.title.length - (node.url?.length ?? 0)
    if (extra > 0) this.ensureRoom(0, extra)
    // Each change is its own onChanged, as in Chrome; one that changes nothing sends none.
    const changed = () => {
      const info: { title: string; url?: string } = { title: node.title }
      if (node.url !== undefined) info.url = node.url
      this.dispatch('bookmarks.onChanged', node.id, info)
      this.emitChange({ type: 'changed', id: node.id, ...info, extensionId: event.extension.id })
    }
    if (changes.title !== undefined && changes.title !== node.title) {
      this.totalChars += changes.title.length - node.title.length
      node.title = changes.title
      this.persist()
      changed()
    }
    if (url !== undefined && url !== node.url) {
      this.totalChars += url.length - node.url!.length
      node.url = url
      this.persist()
      changed()
    }
    return this.toTreeNode(node, false)
  }

  private remove(event: ExtensionEvent, id: string, recursive: boolean) {
    const parsed = parseId(id)
    if (parsed === undefined) throw new Error(ERR.invalidId)
    const node = this.lookup(parsed)
    if (!node) throw new Error(ERR.noNode)
    if (this.isPermanent(node)) throw new Error(ERR.modifySpecial)
    if (isFolder(node) && node.children!.length > 0 && !recursive) throw new Error(ERR.folderNotEmpty)
    const parent = this.parents.get(node.id)!
    const index = parent.children!.indexOf(node)
    const removed = this.toTreeNode(node, true, true)
    this.detach(node)
    this.persist()
    const info = { parentId: parent.id, index, node: removed }
    this.dispatch('bookmarks.onRemoved', node.id, info)
    this.emitChange({ type: 'removed', id: node.id, ...info, extensionId: event.extension.id })
  }

  // ------------------------------------------------------------ for the host

  /** The whole tree, as extensions see it. */
  async getTreeForHost() {
    await this.load()
    return this.getTree()
  }

  private buildImported(input: BookmarkImportNode, depth: number, now: number): StoredNode | undefined {
    if (!input || typeof input !== 'object' || depth > MAX_IMPORT_DEPTH) return undefined
    const title = typeof input.title === 'string' ? input.title : ''
    const dateAdded =
      typeof input.dateAdded === 'number' && Number.isFinite(input.dateAdded) ? input.dateAdded : now
    if (typeof input.url === 'string' && input.url) {
      const url = canonicalUrl(input.url)
      if (!url) return undefined
      return { id: this.newId(), title, url, dateAdded }
    }
    const node: StoredNode = { id: this.newId(), title, dateAdded, dateGroupModified: dateAdded, children: [] }
    for (const child of Array.isArray(input.children) ? input.children : []) {
      const built = this.buildImported(child, depth + 1, now)
      if (built) node.children!.push(built)
    }
    return node
  }

  private announceCreated(node: StoredNode) {
    this.dispatch('bookmarks.onCreated', node.id, this.toTreeNode(node, false))
    for (const child of node.children ?? []) this.announceCreated(child)
  }

  /**
   * Adds the host's bookmarks under a folder, as an import: extensions get
   * onImportBegan, onCreated for each node, then onImportEnded.
   */
  async importNodes(nodes: BookmarkImportNode[], options: { parentId?: string } = {}) {
    await this.load()
    const parent = this.byId.get(options.parentId ?? OTHER_ID)
    if (!parent || !isFolder(parent) || parent.id === ROOT_ID) throw new Error(ERR.noParent)
    const now = Date.now()
    const built = (Array.isArray(nodes) ? nodes : [])
      .map((n) => this.buildImported(n, 0, now))
      .filter((n): n is StoredNode => !!n)
    this.ensureRoom(
      built.reduce((sum, n) => sum + this.countNodes(n), 0),
      built.reduce((sum, n) => sum + this.charsOf(n), 0),
    )
    const depth = this.depthOf(parent)
    if (built.some((n) => depth + this.heightOf(n) > MAX_DEPTH)) throw new Error(DEPTH_ERROR)
    this.dispatch('bookmarks.onImportBegan')
    for (const node of built) {
      this.attach(node, parent, parent.children!.length)
      this.announceCreated(node)
    }
    if (built.length) parent.dateGroupModified = now
    this.persist()
    this.dispatch('bookmarks.onImportEnded')
    return built.map((n) => this.toTreeNode(n, true))
  }

  /**
   * Replaces what the permanent folders hold with the host's own bookmarks.
   * A folder left out keeps what it has. Extensions see onImportBegan,
   * onRemoved for what went, onCreated for what came, then onImportEnded.
   */
  async replaceTree(folders: {
    bookmarksBar?: BookmarkImportNode[]
    other?: BookmarkImportNode[]
    mobile?: BookmarkImportNode[]
  }) {
    await this.load()
    const now = Date.now()
    const plan: [StoredNode, StoredNode[]][] = []
    let nodes = 0
    let chars = 0
    for (const [key, id] of [
      ['bookmarksBar', BAR_ID],
      ['other', OTHER_ID],
      ['mobile', MOBILE_ID],
    ] as const) {
      const list = folders?.[key]
      if (!Array.isArray(list)) continue
      const folder = this.byId.get(id)!
      const built = list.map((n) => this.buildImported(n, 0, now)).filter((n): n is StoredNode => !!n)
      for (const child of folder.children!) {
        nodes -= this.countNodes(child)
        chars -= this.charsOf(child)
      }
      for (const n of built) {
        nodes += this.countNodes(n)
        chars += this.charsOf(n)
      }
      plan.push([folder, built])
    }
    this.ensureRoom(Math.max(0, nodes), Math.max(0, chars))
    this.dispatch('bookmarks.onImportBegan')
    for (const [folder, built] of plan) {
      const wasVisible = this.isVisible(folder)
      while (folder.children!.length) {
        const child = folder.children![folder.children!.length - 1]
        const index = folder.children!.length - 1
        const removed = this.toTreeNode(child, true, true)
        this.detach(child)
        if (wasVisible) this.dispatch('bookmarks.onRemoved', child.id, { parentId: folder.id, index, node: removed })
      }
      for (const node of built) {
        this.attach(node, folder, folder.children!.length)
        this.announceCreated(node)
      }
      folder.dateGroupModified = now
    }
    this.persist()
    this.dispatch('bookmarks.onImportEnded')
    return this.getTree()
  }
}
