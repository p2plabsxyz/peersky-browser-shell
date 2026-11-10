import { promises as fs } from 'node:fs'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { matchesAnyPattern } from '../match-pattern'
import { readManifestPermissions } from '../permissions'
import { TabContents, resolveExtensionPath } from './common'

/**
 * chrome.scripting
 *
 * Electron runs Chromium's own chrome.scripting in extension contexts, with
 * isolated worlds per extension in every frame, real document ids and
 * Chrome's errors. It only knows the host permissions in the manifest,
 * though, and nothing about browser-internal pages or the tabs this library
 * tracks. So every call comes here first: the tab must be one of ours, and
 * the extension must have host access to the frames as PeerSky counts it.
 * Then the renderer hands the call to Electron.
 *
 * Where only PeerSky grants access (optional host permissions, activeTab),
 * Electron refuses, and the call comes back here to be run by the main
 * process instead: in an isolated world of the extension's own on the top
 * frame, or in the page's world.
 *
 * Electron forgets registered content scripts when the browser restarts, so
 * the ones that ask to persist are kept here and handed back to the
 * extension's first context to register again.
 */

const CONTENT_SCRIPTS_NS = 'scripting.contentScripts'
/** Where an earlier version of this library kept its own registry. */
const LEGACY_REGISTRY_NS = 'scripting.dynamic.registry.v1'

const MAX_TARGET_IDS = 100
const MAX_SCRIPTS = 1000
const MAX_FILES = 100
const MAX_CODE_LENGTH = 10 * 1024 * 1024

type RunAt = 'document_start' | 'document_end' | 'document_idle'
type RegisteredScript = chrome.scripting.RegisteredContentScript

interface Target {
  tabId: number
  frameIds?: number[]
  documentIds?: string[]
  allFrames?: boolean
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const frameIdOf = (f: Electron.WebFrameMain) => (f === f.top ? 0 : f.frameTreeNodeId)

/** A world id of the extension's own for scripts the main process runs. */
function isolatedWorldId(extensionId: string) {
  let hash = 0
  for (let i = 0; i < extensionId.length; i++) hash = (hash * 31 + extensionId.charCodeAt(i)) >>> 0
  // Clear of Electron's own worlds (0, 999) and of the range Chromium hands
  // to extensions it runs itself.
  return 1 << 24 | hash % 100000
}

export class ScriptingAPI {
  /** What each extension has registered, as Electron reports it. */
  private registered = new Map<string, RegisteredScript[]>()
  /** Extensions whose persisted scripts were handed back in this run. */
  private restored = new Set<string>()
  /** CSS the main process inserted, to remove it again: key -> Electron's key. */
  private insertedCss = new Map<string, string>()
  private observedTabs = new WeakSet<Electron.WebContents>()
  private ready: Promise<void>

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('scripting.executeScript', this.executeScript)
    handle('scripting.insertCSS', (event: ExtensionEvent, injection: any, opts?: any) =>
      this.css(event, injection, opts, 'insertCSS'),
    )
    handle('scripting.removeCSS', (event: ExtensionEvent, injection: any, opts?: any) =>
      this.css(event, injection, opts, 'removeCSS'),
    )
    handle('scripting.restoreContentScripts', this.restoreContentScripts)
    handle('scripting.syncContentScripts', this.syncContentScripts)

    this.ready = this.load()
    this.ctx.store.on('tab-added', (tab: TabContents) => this.observeTab(tab))

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event: unknown, extension: Electron.Extension) => {
      // Electron drops registered scripts with the extension; a reload
      // registers the persisted ones again.
      this.registered.delete(extension.id)
      this.restored.delete(extension.id)
    })
  }

  private async load() {
    await this.ctx.stateStore.whenHydrated()
    const legacy = this.ctx.stateStore.getNamespace<Record<string, RegisteredScript[]> | null>(
      LEGACY_REGISTRY_NS,
      null,
    )
    if (legacy && typeof legacy === 'object') {
      const current = this.persisted()
      for (const [extensionId, scripts] of Object.entries(legacy)) {
        if (current[extensionId] || !Array.isArray(scripts)) continue
        current[extensionId] = scripts.filter((s) => isPlainObject(s) && s.persistAcrossSessions !== false)
      }
      this.ctx.stateStore.setNamespace(CONTENT_SCRIPTS_NS, current)
      this.ctx.stateStore.setNamespace(LEGACY_REGISTRY_NS, undefined)
      void this.ctx.stateStore.flush().catch(() => {})
    }
  }

  private persisted(): Record<string, RegisteredScript[]> {
    return { ...this.ctx.stateStore.getNamespace<Record<string, RegisteredScript[]>>(CONTENT_SCRIPTS_NS, {}) }
  }

  // ------------------------------------------------------------ access

  /** Chrome's refusal for a frame the extension may not script, or undefined. */
  private accessError(extension: Electron.Extension, url: string, tabId: number): string | undefined {
    let parsed: URL | undefined
    try {
      parsed = new URL(url)
    } catch {}
    if (parsed?.protocol === 'chrome:') return 'Cannot access a chrome:// URL'
    if (parsed?.protocol === 'chrome-extension:' && parsed.hostname !== extension.id) {
      return 'Cannot access a chrome-extension:// URL of different extension'
    }
    if (this.ctx.permissions.hasHostAccess(extension, url, { tabId, scriptable: true })) return undefined
    // Chrome names the page only to an extension allowed to see its URL.
    const seesUrl = this.ctx.permissions.has(extension, 'tabs') || this.ctx.permissions.hasActiveTab(extension, tabId)
    return seesUrl
      ? `Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`
      : 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
  }

  /** Whether Electron itself would inject there: manifest hosts only. */
  private electronCovers(extension: Electron.Extension, url: string) {
    const declared = readManifestPermissions(extension.manifest)
    return matchesAnyPattern([...declared.origins, ...declared.contentScriptOrigins], url)
  }

  private getTab(target: any): Electron.WebContents {
    const tabId = target?.tabId
    if (!Number.isInteger(tabId)) {
      throw new Error("Error at parameter 'injection': Error at property 'target': Missing required property 'tabId'.")
    }
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) throw new Error(`No tab with id: ${tabId}`)
    return tab
  }

  /**
   * The frames a target names. Ids Electron would refuse are left for it to
   * name in its own error; documentIds come from webNavigation, which makes
   * its own, so they are turned into frame ids here.
   */
  private resolveTarget(tab: Electron.WebContents, target: Target, strict: boolean) {
    const main = tab.mainFrame
    const all = main.framesInSubtree.filter((f) => !f.isDestroyed())
    const byId = (id: number) => all.find((f) => frameIdOf(f) === id)
    const frameIds = Array.isArray(target.frameIds) ? target.frameIds.slice(0, MAX_TARGET_IDS + 1) : undefined
    const documentIds = Array.isArray(target.documentIds)
      ? target.documentIds.slice(0, MAX_TARGET_IDS + 1)
      : undefined
    if ((frameIds?.length ?? 0) > MAX_TARGET_IDS || (documentIds?.length ?? 0) > MAX_TARGET_IDS) {
      throw new Error('Too many frames.')
    }
    if (strict) {
      if (target.allFrames === true && (frameIds || documentIds)) {
        throw new Error("Cannot specify 'allFrames' if either 'frameIds' or 'documentIds' is specified.")
      }
      if (frameIds && documentIds) throw new Error("Cannot specify both 'frameIds' and 'documentIds'.")
    }

    let ids: number[] | undefined = frameIds?.filter((id) => Number.isInteger(id))
    if (documentIds) {
      ids = []
      for (const documentId of documentIds) {
        if (typeof documentId !== 'string') continue
        const resolved = this.ctx.store.resolveByDocumentId(documentId)
        if (!resolved || resolved.tabId !== tab.id) {
          throw new Error(`No document with id ${documentId} in tab with id ${tab.id}`)
        }
        ids.push(resolved.frameId)
      }
    }

    const frames: Electron.WebFrameMain[] = []
    if (target.allFrames === true && !ids) {
      frames.push(...all)
    } else {
      for (const id of ids ?? [0]) {
        const frame = byId(id)
        if (frame) frames.push(frame)
        else if (strict) throw new Error(`No frame with id ${id} in tab with id ${tab.id}`)
      }
    }
    const electronTarget: Target = { tabId: tab.id }
    if (ids) electronTarget.frameIds = ids
    else if (target.allFrames === true) electronTarget.allFrames = true
    return { frames, electronTarget }
  }

  /** Throws Chrome's refusal for the first frame of `frames` the extension cannot script. */
  private checkFrames(
    extension: Electron.Extension,
    tab: Electron.WebContents,
    frames: Electron.WebFrameMain[],
    target: Target,
  ) {
    // With allFrames, frames out of reach are left out, as in Chrome; the
    // top frame still has to be reachable.
    const checked = target.allFrames === true ? frames.filter((f) => f === f.top) : frames
    for (const frame of checked) {
      const error = this.accessError(extension, frame.url, tab.id)
      if (error) throw new Error(error)
    }
  }

  private documentIds(tabId: number, frames: Electron.WebFrameMain[]) {
    const out: Record<number, string> = {}
    for (const frame of frames) {
      const id = frameIdOf(frame)
      const documentId = this.ctx.store.getDocumentId(tabId, id)
      if (documentId) out[id] = documentId
    }
    return out
  }

  // ------------------------------------------------------------ executeScript

  private executeScript = async (
    { extension }: ExtensionEvent,
    injection: any,
    opts?: { fallback?: boolean },
  ) => {
    if (!isPlainObject(injection)) throw new Error("Error at parameter 'injection': Invalid type: expected object.")
    const tab = this.getTab(injection.target)
    const fallback = opts?.fallback === true
    const { frames, electronTarget } = this.resolveTarget(tab, injection.target, fallback)
    this.checkFrames(extension, tab, frames, injection.target)
    if (!fallback) {
      return { mode: 'electron', target: electronTarget, documentIds: this.documentIds(tab.id, frames) }
    }
    return { mode: 'done', result: await this.runScript(extension, tab, frames, injection) }
  }

  private async readFiles(extension: Electron.Extension, files: unknown): Promise<string[]> {
    if (!Array.isArray(files)) throw new Error("Error at property 'files': Invalid type: expected array.")
    if (files.length === 0) throw new Error('At least one file must be specified.')
    if (files.length > MAX_FILES) throw new Error('Too many files.')
    const out: string[] = []
    for (const file of files) {
      const abs = typeof file === 'string' ? resolveExtensionPath(extension, file) : undefined
      let text: string | undefined
      if (abs) {
        try {
          const stat = await fs.stat(abs)
          if (stat.isFile() && stat.size <= MAX_CODE_LENGTH) text = await fs.readFile(abs, 'utf8')
        } catch {}
      }
      if (text === undefined) throw new Error(`Could not load file: '${String(file)}'.`)
      out.push(text)
    }
    return out
  }

  /** Runs a script from the main process, for frames Electron would not inject into. */
  private async runScript(
    extension: Electron.Extension,
    tab: Electron.WebContents,
    frames: Electron.WebFrameMain[],
    injection: any,
  ) {
    const hasFunc = typeof injection.func === 'string' && injection.func.trim() !== ''
    const hasFiles = injection.files !== undefined
    if (hasFunc === hasFiles) throw new Error("Exactly one of 'func' and 'files' must be specified")
    if (hasFiles && injection.args !== undefined) throw new Error("'args' may not be used with file injections.")
    const world = injection.world ?? 'ISOLATED'
    if (world !== 'ISOLATED' && world !== 'MAIN') {
      throw new Error("Error at property 'world': Value must be one of ISOLATED, MAIN.")
    }
    let sources: string[]
    if (hasFunc) {
      if (injection.func.length > MAX_CODE_LENGTH) throw new Error('Script is too long.')
      let args = '[]'
      if (injection.args !== undefined) {
        if (!Array.isArray(injection.args)) throw new Error("Error at property 'args': Invalid type: expected array.")
        args = JSON.stringify(injection.args)
        if (args.length > MAX_CODE_LENGTH) throw new Error('Arguments are too long.')
      }
      sources = [`(${injection.func}).apply(null, ${args})`]
    } else {
      sources = await this.readFiles(extension, injection.files)
    }

    const results: { documentId?: string; frameId: number; result: unknown }[] = []
    for (const frame of frames) {
      if (frame.isDestroyed() || this.accessError(extension, frame.url, tab.id)) continue
      const frameId = frameIdOf(frame)
      let result: unknown = null
      try {
        for (const code of sources) {
          if (world === 'MAIN') {
            result = await frame.executeJavaScript(code, true)
          } else if (frame === frame.top) {
            result = await tab.executeJavaScriptInIsolatedWorld(isolatedWorldId(extension.id), [{ code }], true)
          } else {
            // Electron has no isolated worlds in subframes for the main
            // process; the page's own world would let the page tamper.
            throw new Error('skip')
          }
        }
      } catch (error) {
        if ((error as Error)?.message === 'skip') continue
        result = null
      }
      const documentId =
        this.ctx.store.getDocumentId(tab.id, frameId) || this.ctx.store.newDocumentId(tab.id, frameId)
      results.push({ documentId, frameId, result: result === undefined ? null : result })
    }
    return results
  }

  // ------------------------------------------------------------ insertCSS / removeCSS

  private css = async (
    { extension }: ExtensionEvent,
    injection: any,
    opts: { fallback?: boolean } | undefined,
    method: 'insertCSS' | 'removeCSS',
  ) => {
    if (!isPlainObject(injection)) throw new Error("Error at parameter 'injection': Invalid type: expected object.")
    const tab = this.getTab(injection.target)
    const fallback = opts?.fallback === true
    const { frames, electronTarget } = this.resolveTarget(tab, injection.target, fallback)
    this.checkFrames(extension, tab, frames, injection.target)
    if (!fallback) return { mode: 'electron', target: electronTarget }

    const hasCss = typeof injection.css === 'string'
    const hasFiles = injection.files !== undefined
    if (hasCss === hasFiles) throw new Error("Exactly one of 'css' and 'files' must be specified.")
    const origin = injection.origin ?? 'AUTHOR'
    if (origin !== 'AUTHOR' && origin !== 'USER') {
      throw new Error("Error at property 'origin': Value must be one of AUTHOR, USER.")
    }
    if (hasCss && injection.css.length > MAX_CODE_LENGTH) throw new Error('CSS is too long.')
    const sources: string[] = hasCss ? [injection.css] : await this.readFiles(extension, injection.files)
    const label = hasCss ? `css:${injection.css}` : `files:${JSON.stringify(injection.files)}`

    // Electron inserts CSS into the top frame only from here.
    for (const frame of frames) {
      if (frame !== frame.top || this.accessError(extension, frame.url, tab.id)) continue
      const key = `${extension.id}|${tab.id}|${frame.url}|${origin}|${label}`
      if (method === 'insertCSS') {
        const cssOrigin = origin === 'USER' ? 'user' : 'author'
        const inserted = await tab.insertCSS(sources.join('\n'), { cssOrigin })
        this.insertedCss.set(key, inserted)
      } else {
        const inserted = this.insertedCss.get(key)
        if (inserted) {
          this.insertedCss.delete(key)
          await tab.removeInsertedCSS(inserted).catch(() => {})
        }
      }
    }
    return { mode: 'done' }
  }

  // ------------------------------------------------------------ registered content scripts

  /** The persisted scripts to register again, once per run, to the first context that asks. */
  private restoreContentScripts = async ({ extension }: ExtensionEvent): Promise<RegisteredScript[]> => {
    await this.ready
    if (this.restored.has(extension.id)) return []
    this.restored.add(extension.id)
    const scripts = this.persisted()[extension.id]
    return Array.isArray(scripts) ? scripts.filter(isPlainObject).slice(0, MAX_SCRIPTS) : []
  }

  /** What Electron has registered now, after a change; persisted ones are kept. */
  private syncContentScripts = async ({ extension }: ExtensionEvent, scripts: unknown) => {
    await this.ready
    if (!Array.isArray(scripts)) return
    const list: RegisteredScript[] = []
    for (const script of scripts.slice(0, MAX_SCRIPTS)) {
      if (!isPlainObject(script) || typeof script.id !== 'string' || !Array.isArray(script.matches)) continue
      const strings = (v: unknown) =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, MAX_FILES) : undefined
      const clean: RegisteredScript = {
        id: script.id.slice(0, 1024),
        matches: strings(script.matches) || [],
        allFrames: script.allFrames === true,
        matchOriginAsFallback: script.matchOriginAsFallback === true,
        persistAcrossSessions: script.persistAcrossSessions !== false,
        runAt: ['document_start', 'document_end', 'document_idle'].includes(script.runAt)
          ? script.runAt
          : 'document_idle',
        world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
      }
      const excludeMatches = strings(script.excludeMatches)
      if (excludeMatches?.length) clean.excludeMatches = excludeMatches
      const js = strings(script.js)
      if (js?.length) clean.js = js
      const css = strings(script.css)
      if (css?.length) clean.css = css
      list.push(clean)
    }
    this.registered.set(extension.id, list)
    const all = this.persisted()
    const keep = list.filter((s) => s.persistAcrossSessions !== false)
    if (keep.length) all[extension.id] = keep
    else delete all[extension.id]
    this.ctx.stateStore.setNamespace(CONTENT_SCRIPTS_NS, all)
    void this.ctx.stateStore.flush().catch((error) => {
      console.error('Failed to persist registered content scripts', error)
    })
  }

  /**
   * Electron injects registered scripts only where the manifest grants
   * access. Where PeerSky alone grants it (an optional host permission),
   * the main process injects them into the top frame.
   */
  private observeTab(tab: TabContents) {
    if (!tab || tab.isDestroyed() || this.observedTabs.has(tab)) return
    this.observedTabs.add(tab)
    const inject = (runAt: RunAt) => {
      void this.injectRegistered(tab, runAt).catch((error) => {
        console.error('Content script injection failed', error)
      })
    }
    tab.on('did-navigate', () => inject('document_start'))
    tab.on('dom-ready', () => inject('document_end'))
    tab.on('did-finish-load', () => inject('document_idle'))
  }

  private async injectRegistered(tab: TabContents, runAt: RunAt) {
    if (tab.isDestroyed() || this.registered.size === 0) return
    const url = tab.getURL()
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    for (const [extensionId, scripts] of this.registered) {
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension || this.electronCovers(extension, url)) continue
      if (this.accessError(extension, url, tab.id)) continue
      for (const script of scripts) {
        if ((script.runAt || 'document_idle') !== runAt) continue
        if (!matchesAnyPattern(script.matches, url) || matchesAnyPattern(script.excludeMatches, url)) continue
        for (const file of script.css || []) {
          const [text] = await this.readFiles(extension, [file]).catch(() => [undefined])
          if (text !== undefined && !tab.isDestroyed()) await tab.insertCSS(text)
        }
        for (const file of script.js || []) {
          const [code] = await this.readFiles(extension, [file]).catch(() => [undefined])
          if (code === undefined || tab.isDestroyed()) continue
          if (script.world === 'MAIN') await tab.mainFrame.executeJavaScript(code, false)
          else await tab.executeJavaScriptInIsolatedWorld(isolatedWorldId(extension.id), [{ code }], false)
        }
      }
    }
  }
}
