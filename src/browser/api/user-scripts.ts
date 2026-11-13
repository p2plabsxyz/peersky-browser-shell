import { promises as fs } from 'node:fs'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesAnyPattern, matchesGlob, parseMatchPattern } from '../match-pattern'
import { TabContents, resolveExtensionPath } from './common'

/**
 * chrome.userScripts
 *
 * Chrome offers this API only once the person turns on "Allow User Scripts"
 * for the extension, since it runs any code the extension hands it. The shell
 * asks the host (impl.isUserScriptsAllowed); without that hook it is off, as
 * in Chrome. While it is off, chrome.userScripts is not there, and scripts an
 * extension registered before do not run.
 *
 * Registered scripts are kept across restarts, as in Chrome, and run in
 * pages the extension has host access to: in the page's world (MAIN), or in
 * a world of the extension's own (USER_SCRIPT, one per worldId) that has no
 * chrome.* APIs. Electron gives the main process isolated worlds in the top
 * frame only, so USER_SCRIPT scripts run there and MAIN ones in every frame
 * that allFrames asks for.
 */

const STATE_NS = 'userScripts'
const MAX_SCRIPTS = 1000
const MAX_SOURCES = 100
const MAX_CODE = 10 * 1024 * 1024
const MAX_WORLDS = 100

type RunAt = 'document_start' | 'document_end' | 'document_idle'
type World = 'MAIN' | 'USER_SCRIPT'

interface ScriptSource {
  code?: string
  file?: string
}

interface UserScript {
  id: string
  matches: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  js: ScriptSource[]
  runAt: RunAt
  allFrames: boolean
  world: World
  worldId?: string
}

interface WorldProperties {
  worldId?: string
  csp?: string
  messaging?: boolean
}

interface Persisted {
  [extensionId: string]: { scripts?: UserScript[]; worlds?: WorldProperties[] }
}

const RUN_AT = new Set(['document_start', 'document_end', 'document_idle'])

const frameIdOf = (f: Electron.WebFrameMain) => (f === f.top ? 0 : f.frameTreeNodeId)

/** A world id of the extension's own for each of its user script worlds. */
function worldIdFor(extensionId: string, worldId = '') {
  let hash = 7
  const key = `${extensionId}/${worldId}`
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  // Clear of Electron's worlds and of the ones chrome.scripting uses here.
  return (1 << 25) | hash % 1000000
}

const stringList = (value: unknown, label: string): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 1000 || !value.every((v) => typeof v === 'string')) {
    throw new Error(`Error at property '${label}': Invalid type: expected array of strings.`)
  }
  return [...value]
}

export class UserScriptsAPI {
  private scripts = new Map<string, Map<string, UserScript>>()
  private worlds = new Map<string, WorldProperties[]>()
  private observedTabs = new WeakSet<Electron.WebContents>()
  private ready: Promise<void>

  constructor(private ctx: ExtensionContext) {
    // A starting page or worker learns whether to show chrome.userScripts.
    this.ctx.router.addContextInfoProvider((extension) => ({
      userScripts: this.ctx.permissions.has(extension, 'userScripts') && this.allowed(extension),
    }))
    const handle = this.ctx.router.apiHandler()
    handle('userScripts.getScripts', this.gate(this.getScripts))
    handle('userScripts.register', this.gate(this.register))
    handle('userScripts.unregister', this.gate(this.unregister))
    handle('userScripts.update', this.gate(this.update))
    handle('userScripts.execute', this.gate(this.execute))
    handle('userScripts.configureWorld', this.gate(this.configureWorld))
    handle('userScripts.getWorldConfigurations', this.gate(this.getWorldConfigurations))
    handle('userScripts.resetWorldConfiguration', this.gate(this.resetWorldConfiguration))

    this.ready = this.load()
    this.ctx.store.on('tab-added', (tab: TabContents) => this.observeTab(tab))
  }

  private async load() {
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<Persisted>(STATE_NS, {})
    for (const [extensionId, entry] of Object.entries(saved || {})) {
      const map = new Map<string, UserScript>()
      for (const script of Array.isArray(entry?.scripts) ? entry.scripts : []) {
        if (script && typeof script.id === 'string') map.set(script.id, script)
      }
      if (map.size) this.scripts.set(extensionId, map)
      if (Array.isArray(entry?.worlds)) this.worlds.set(extensionId, entry.worlds)
    }
  }

  private persist(extensionId: string) {
    const all = { ...this.ctx.stateStore.getNamespace<Persisted>(STATE_NS, {}) }
    const scripts = [...(this.scripts.get(extensionId)?.values() ?? [])]
    const worlds = this.worlds.get(extensionId) ?? []
    if (scripts.length || worlds.length) all[extensionId] = { scripts, worlds }
    else delete all[extensionId]
    this.ctx.stateStore.setNamespace(STATE_NS, all)
    void this.ctx.stateStore.flush().catch((error) => console.error('Failed to persist user scripts', error))
  }

  private allowed(extension: Electron.Extension) {
    const hook = this.ctx.store.impl?.isUserScriptsAllowed
    if (typeof hook !== 'function') return false
    try {
      return hook(extension) === true
    } catch {
      return false
    }
  }

  /** Every call waits for the stored scripts, and is refused when the person said no. */
  private gate<T extends (event: ExtensionEvent, ...args: any[]) => any>(fn: T) {
    return async (event: ExtensionEvent, ...args: any[]) => {
      if (!this.allowed(event.extension)) {
        throw new Error('The userScripts API is not available: user scripts are not allowed for this extension.')
      }
      await this.ready
      return fn(event, ...args)
    }
  }

  private bucket(extensionId: string) {
    let map = this.scripts.get(extensionId)
    if (!map) {
      map = new Map()
      this.scripts.set(extensionId, map)
    }
    return map
  }

  private view(script: UserScript) {
    return JSON.parse(JSON.stringify(script)) as UserScript
  }

  // ------------------------------------------------------------ registration

  private async checkSources(extension: Electron.Extension, id: string, js: unknown): Promise<ScriptSource[]> {
    if (!Array.isArray(js) || js.length === 0) throw new Error(`Script with ID '${id}' must specify at least one js source.`)
    if (js.length > MAX_SOURCES) throw new Error(`Script with ID '${id}' has too many js sources.`)
    const out: ScriptSource[] = []
    for (const source of js) {
      const hasCode = typeof source?.code === 'string'
      const hasFile = typeof source?.file === 'string'
      if (hasCode === hasFile) throw new Error("Exactly one of 'code' and 'file' must be specified.")
      if (hasCode) {
        if (source.code.length > MAX_CODE) throw new Error(`Script with ID '${id}' is too large.`)
        out.push({ code: source.code })
      } else {
        const abs = resolveExtensionPath(extension, source.file)
        let ok = false
        if (abs) {
          try {
            ok = (await fs.stat(abs)).isFile()
          } catch {}
        }
        if (!ok) throw new Error(`Could not load javascript '${source.file}' for script.`)
        out.push({ file: source.file })
      }
    }
    return out
  }

  private checkPatterns(id: string, list: string[] | undefined, key: string) {
    list?.forEach((pattern, i) => {
      try {
        parseMatchPattern(pattern)
      } catch (error) {
        throw new Error(`Script with ID '${id}' has invalid value for ${key}[${i}]: ${(error as Error).message}`)
      }
    })
  }

  /** Checks a script as Chrome does and fills in its defaults. */
  private async checkScript(extension: Electron.Extension, raw: any): Promise<UserScript> {
    if (!raw || typeof raw !== 'object') throw new Error("Error at parameter 'scripts': Invalid type: expected object.")
    const id = raw.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 1024) throw new Error('Script\'s ID must not be empty')
    if (id.startsWith('_')) throw new Error(`Script's ID '${id}' must not start with '_'`)
    const matches = stringList(raw.matches, 'matches')
    if (!matches || matches.length === 0) throw new Error(`Script with ID '${id}' must specify at least one match.`)
    this.checkPatterns(id, matches, 'matches')
    const excludeMatches = stringList(raw.excludeMatches, 'excludeMatches')
    this.checkPatterns(id, excludeMatches, 'excludeMatches')
    const includeGlobs = stringList(raw.includeGlobs, 'includeGlobs')
    const excludeGlobs = stringList(raw.excludeGlobs, 'excludeGlobs')
    const runAt = raw.runAt ?? 'document_idle'
    if (!RUN_AT.has(runAt)) throw new Error("Error at property 'runAt': Value must be one of document_start, document_end, document_idle.")
    const world = raw.world ?? 'USER_SCRIPT'
    if (world !== 'MAIN' && world !== 'USER_SCRIPT') throw new Error("Error at property 'world': Value must be one of MAIN, USER_SCRIPT.")
    if (raw.allFrames !== undefined && typeof raw.allFrames !== 'boolean') {
      throw new Error("Error at property 'allFrames': Invalid type: expected boolean.")
    }
    if (raw.worldId !== undefined) {
      if (typeof raw.worldId !== 'string' || raw.worldId.startsWith('_')) {
        throw new Error(`Script with ID '${id}' has an invalid worldId.`)
      }
      if (world === 'MAIN') throw new Error("World ID can only be specified for USER_SCRIPT worlds.")
    }
    const script: UserScript = {
      id,
      matches,
      js: await this.checkSources(extension, id, raw.js),
      runAt,
      allFrames: raw.allFrames === true,
      world,
    }
    if (excludeMatches?.length) script.excludeMatches = excludeMatches
    if (includeGlobs?.length) script.includeGlobs = includeGlobs
    if (excludeGlobs?.length) script.excludeGlobs = excludeGlobs
    if (typeof raw.worldId === 'string' && raw.worldId) script.worldId = raw.worldId
    return script
  }

  private getScripts = ({ extension }: ExtensionEvent, filter?: { ids?: string[] }) => {
    const all = [...this.bucket(extension.id).values()]
    const ids = filter?.ids
    return (Array.isArray(ids) ? all.filter((s) => ids.includes(s.id)) : all).map((s) => this.view(s))
  }

  private register = async ({ extension }: ExtensionEvent, scripts: unknown) => {
    if (!Array.isArray(scripts)) throw new Error("Error at parameter 'scripts': Invalid type: expected array.")
    const map = this.bucket(extension.id)
    if (map.size + scripts.length > MAX_SCRIPTS) throw new Error('Too many user scripts.')
    const seen = new Set<string>()
    const checked: UserScript[] = []
    for (const raw of scripts) {
      const id = (raw as any)?.id
      if (typeof id === 'string' && (map.has(id) || seen.has(id))) throw new Error(`Duplicate script ID '${id}'`)
      const script = await this.checkScript(extension, raw)
      seen.add(script.id)
      checked.push(script)
    }
    for (const script of checked) map.set(script.id, script)
    this.persist(extension.id)
  }

  private update = async ({ extension }: ExtensionEvent, scripts: unknown) => {
    if (!Array.isArray(scripts)) throw new Error("Error at parameter 'scripts': Invalid type: expected array.")
    const map = this.bucket(extension.id)
    const next: UserScript[] = []
    for (const raw of scripts) {
      const id = (raw as any)?.id
      const existing = typeof id === 'string' ? map.get(id) : undefined
      if (!existing) throw new Error(`Script with ID '${id}' does not exist or is not fully registered`)
      const merged = { ...existing, ...(raw as object) }
      // A field set to undefined in the update keeps the old value, as in Chrome.
      for (const [key, value] of Object.entries(raw as object)) if (value === undefined) (merged as any)[key] = (existing as any)[key]
      next.push(await this.checkScript(extension, merged))
    }
    for (const script of next) map.set(script.id, script)
    this.persist(extension.id)
  }

  private unregister = ({ extension }: ExtensionEvent, filter?: { ids?: string[] }) => {
    const map = this.bucket(extension.id)
    if (!filter || !Array.isArray(filter.ids)) {
      map.clear()
    } else {
      for (const id of filter.ids) if (!map.has(id)) throw new Error(`Nonexistent script ID '${id}'`)
      for (const id of filter.ids) map.delete(id)
    }
    this.persist(extension.id)
  }

  // ------------------------------------------------------------ worlds

  private configureWorld = ({ extension }: ExtensionEvent, properties?: WorldProperties) => {
    if (!properties || typeof properties !== 'object') {
      throw new Error("Error at parameter 'properties': Invalid type: expected object.")
    }
    if (properties.csp !== undefined && (typeof properties.csp !== 'string' || properties.csp.length > 10000)) {
      throw new Error("Error at property 'csp': Invalid type: expected string.")
    }
    if (properties.messaging !== undefined && typeof properties.messaging !== 'boolean') {
      throw new Error("Error at property 'messaging': Invalid type: expected boolean.")
    }
    if (properties.worldId !== undefined && (typeof properties.worldId !== 'string' || properties.worldId.startsWith('_'))) {
      throw new Error("Error at property 'worldId': Invalid value.")
    }
    const worldId = properties.worldId || undefined
    const configs = (this.worlds.get(extension.id) || []).filter((c) => (c.worldId || undefined) !== worldId)
    if (configs.length >= MAX_WORLDS) throw new Error('Too many user script worlds.')
    const config: WorldProperties = {}
    if (worldId) config.worldId = worldId
    if (properties.csp !== undefined) config.csp = properties.csp
    if (properties.messaging !== undefined) config.messaging = properties.messaging
    configs.push(config)
    this.worlds.set(extension.id, configs)
    this.persist(extension.id)
  }

  private getWorldConfigurations = ({ extension }: ExtensionEvent) => {
    return (this.worlds.get(extension.id) || []).map((c) => ({ ...c }))
  }

  private resetWorldConfiguration = ({ extension }: ExtensionEvent, worldId?: string) => {
    const configs = this.worlds.get(extension.id) || []
    this.worlds.set(
      extension.id,
      configs.filter((c) => (c.worldId || undefined) !== (worldId || undefined)),
    )
    this.persist(extension.id)
  }

  // ------------------------------------------------------------ running

  private async sourceCode(extension: Electron.Extension, sources: ScriptSource[]): Promise<string[]> {
    const out: string[] = []
    for (const source of sources) {
      if (typeof source.code === 'string') {
        out.push(source.code)
        continue
      }
      const abs = typeof source.file === 'string' ? resolveExtensionPath(extension, source.file) : undefined
      if (!abs) throw new Error(`Could not load file: '${source.file}'.`)
      try {
        out.push(await fs.readFile(abs, 'utf8'))
      } catch {
        throw new Error(`Could not load file: '${source.file}'.`)
      }
    }
    return out
  }

  private mayRunIn(extension: Electron.Extension, tabId: number, url: string) {
    let parsed: URL | undefined
    try {
      parsed = new URL(url)
    } catch {}
    if (parsed?.protocol === 'chrome-extension:' && parsed.hostname !== extension.id) return false
    return this.ctx.permissions.hasHostAccess(extension, url, { tabId })
  }

  private async run(
    extension: Electron.Extension,
    tab: Electron.WebContents,
    frame: Electron.WebFrameMain,
    code: string[],
    world: World,
    worldId?: string,
  ): Promise<unknown> {
    let result: unknown
    for (const source of code) {
      if (world === 'MAIN') result = await frame.executeJavaScript(source, false)
      else result = await tab.executeJavaScriptInIsolatedWorld(worldIdFor(extension.id, worldId), [{ code: source }], false)
    }
    return result
  }

  private execute = async ({ extension }: ExtensionEvent, injection: any) => {
    if (!injection || typeof injection !== 'object') throw new Error("Error at parameter 'injection': Invalid type: expected object.")
    const target = injection.target
    if (!target || !Number.isInteger(target.tabId)) {
      throw new Error("Error at parameter 'injection': Error at property 'target': Missing required property 'tabId'.")
    }
    const tab = this.ctx.store.getTabById(target.tabId)
    if (!tab || tab.isDestroyed()) throw new Error(`No tab with id: ${target.tabId}`)
    const world: World = injection.world ?? 'USER_SCRIPT'
    if (world !== 'MAIN' && world !== 'USER_SCRIPT') {
      throw new Error("Error at property 'world': Value must be one of MAIN, USER_SCRIPT.")
    }
    if (Array.isArray(target.frameIds) && target.allFrames === true) {
      throw new Error("Cannot specify 'allFrames' if either 'frameIds' or 'documentIds' is specified.")
    }
    const sources = await this.checkSources(extension, 'execute', injection.js)
    const code = await this.sourceCode(extension, sources)

    const all = tab.mainFrame.framesInSubtree.filter((f) => !f.isDestroyed())
    let frames: Electron.WebFrameMain[]
    if (Array.isArray(target.documentIds)) {
      frames = []
      for (const documentId of target.documentIds.slice(0, 100)) {
        const resolved = typeof documentId === 'string' ? this.ctx.store.resolveByDocumentId(documentId) : undefined
        const frame = resolved && resolved.tabId === tab.id ? all.find((f) => frameIdOf(f) === resolved.frameId) : undefined
        if (!frame) throw new Error(`No document with id ${documentId} in tab with id ${tab.id}`)
        frames.push(frame)
      }
    } else if (Array.isArray(target.frameIds)) {
      frames = []
      for (const id of target.frameIds.slice(0, 100)) {
        const frame = all.find((f) => frameIdOf(f) === id)
        if (!frame) throw new Error(`No frame with id ${id} in tab with id ${tab.id}`)
        frames.push(frame)
      }
    } else {
      frames = target.allFrames === true ? all : [tab.mainFrame]
    }
    const top = frames.find((f) => f === f.top) ?? frames[0]
    if (top && !this.mayRunIn(extension, tab.id, top.url)) {
      throw new Error(`Cannot access contents of url "${top.url}". Extension manifest must request permission to access this host.`)
    }

    const results: { documentId: string; frameId: number; result?: unknown; error?: string }[] = []
    for (const frame of frames) {
      if (!this.mayRunIn(extension, tab.id, frame.url)) continue
      // Electron runs isolated worlds from here in the top frame only.
      if (world === 'USER_SCRIPT' && frame !== frame.top) continue
      const frameId = frameIdOf(frame)
      const documentId =
        this.ctx.store.getDocumentId(tab.id, frameId) || this.ctx.store.newDocumentId(tab.id, frameId)
      try {
        const result = await this.run(extension, tab, frame, code, world, injection.worldId)
        results.push({ documentId, frameId, result: result === undefined ? null : result })
      } catch (error) {
        results.push({ documentId, frameId, error: (error as Error)?.message || String(error) })
      }
    }
    return results
  }

  private observeTab(tab: TabContents) {
    if (!tab || tab.isDestroyed() || this.observedTabs.has(tab)) return
    this.observedTabs.add(tab)
    const inject = (runAt: RunAt) => {
      void this.injectRegistered(tab, runAt).catch((error) => {
        console.error('User script injection failed', error)
      })
    }
    tab.on('did-navigate', () => inject('document_start'))
    tab.on('dom-ready', () => inject('document_end'))
    tab.on('did-finish-load', () => inject('document_idle'))
  }

  private matchesUrl(script: UserScript, url: string) {
    if (!matchesAnyPattern(script.matches, url) || matchesAnyPattern(script.excludeMatches, url)) return false
    if (script.includeGlobs?.length && !script.includeGlobs.some((g) => matchesGlob(g, url))) return false
    if (script.excludeGlobs?.some((g) => matchesGlob(g, url))) return false
    return true
  }

  private async injectRegistered(tab: TabContents, runAt: RunAt) {
    await this.ready
    if (tab.isDestroyed()) return
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    for (const [extensionId, scripts] of this.scripts) {
      if (scripts.size === 0) continue
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension || !this.allowed(extension) || !this.ctx.permissions.has(extension, 'userScripts')) continue
      for (const script of scripts.values()) {
        if (script.runAt !== runAt) continue
        const frames =
          script.allFrames && script.world === 'MAIN'
            ? tab.mainFrame.framesInSubtree.filter((f) => !f.isDestroyed())
            : [tab.mainFrame]
        let code: string[] | undefined
        for (const frame of frames) {
          if (!this.matchesUrl(script, frame.url) || !this.mayRunIn(extension, tab.id, frame.url)) continue
          code ??= await this.sourceCode(extension, script.js).catch(() => [])
          if (!code.length || tab.isDestroyed()) break
          await this.run(extension, tab, frame, code, script.world, script.worldId).catch(() => {})
        }
      }
    }
  }
}
