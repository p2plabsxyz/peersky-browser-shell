import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { TabContents, matchesPattern, validateExtensionResource } from './common'
import { promises as fs } from 'node:fs'

const ISOLATED_WORLD = 1000
const DYNAMIC_REGISTRY_NS = 'scripting.dynamic.registry.v1'
type RunAt = 'document_start' | 'document_end' | 'document_idle'

function frameId(f: Electron.WebFrameMain) {
  return f === f.top ? 0 : f.frameTreeNodeId
}

function resolveFrame(tab: Electron.WebContents, frameIds?: number[]): Electron.WebFrameMain | null {
  if (!('mainFrame' in tab)) return null
  const main = (tab as Electron.WebContents & { mainFrame: Electron.WebFrameMain }).mainFrame
  if (!main || main.isDestroyed()) return null

  // Missing frameId → null (don't fall back to main frame).
  const fid = frameIds?.[0]
  if (fid == null || fid === 0) return main

  const hit = main.framesInSubtree.find((f) => frameId(f) === fid)
  return hit && !hit.isDestroyed() ? hit : null
}

function resolveInjectionFrame(
  tab: Electron.WebContents,
  target: { frameIds?: number[]; documentIds?: string[] } | undefined,
  resolveDocId: (documentId: string) => { tabId: number; frameId: number } | undefined,
  expectedTabId: number,
): Electron.WebFrameMain | null {
  const documentIds = target?.documentIds
  if (Array.isArray(documentIds) && typeof documentIds[0] === 'string') {
    const resolved = resolveDocId(documentIds[0])
    if (!resolved || resolved.tabId !== expectedTabId) return null
    return resolveFrame(tab, [resolved.frameId])
  }
  return resolveFrame(tab, target?.frameIds)
}

export class ScriptingAPI {
  private registryByExtension = new Map<string, chrome.scripting.RegisteredContentScript[]>()
  private observedTabs = new Set<number>()
  private injectedByTab = new Map<number, Set<string>>()
  private registryReady: Promise<void>

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('scripting.insertCSS', this.insertCSS.bind(this), { permission: 'scripting' })
    handle('scripting.executeScript', this.executeScript.bind(this), { permission: 'scripting' })
    handle('scripting.registerContentScripts', this.registerContentScripts.bind(this), {
      permission: 'scripting',
    })
    handle('scripting.getRegisteredContentScripts', this.getRegisteredContentScripts.bind(this), {
      permission: 'scripting',
    })
    handle('scripting.unregisterContentScripts', this.unregisterContentScripts.bind(this), {
      permission: 'scripting',
    })
    handle('scripting.updateContentScripts', this.updateContentScripts.bind(this), {
      permission: 'scripting',
    })

    this.registryReady = this.loadPersistedRegistry()
    this.ctx.store.on('tab-added', (tab: TabContents) => this.observeTab(tab))
  }

  private cloneScripts(list: chrome.scripting.RegisteredContentScript[]) {
    return JSON.parse(JSON.stringify(list)) as chrome.scripting.RegisteredContentScript[]
  }

  private async loadPersistedRegistry() {
    await this.ctx.stateStore.whenHydrated()
    const initial = this.ctx.stateStore.getNamespace<Record<string, chrome.scripting.RegisteredContentScript[]>>(
      DYNAMIC_REGISTRY_NS,
      {},
    )
    Object.entries(initial || {}).forEach(([extensionId, scripts]) => {
      if (Array.isArray(scripts)) {
        this.registryByExtension.set(extensionId, this.cloneScripts(scripts))
      }
    })
  }

  private persistRegistry() {
    const payload: Record<string, chrome.scripting.RegisteredContentScript[]> = {}
    this.registryByExtension.forEach((scripts, extensionId) => {
      payload[extensionId] = this.cloneScripts(scripts)
    })
    this.ctx.stateStore.setNamespace(DYNAMIC_REGISTRY_NS, payload)
    void this.ctx.stateStore.flush().catch((error) => {
      console.error('Failed to persist dynamic scripting registry', error)
    })
  }

  private scriptMatchesUrl(script: chrome.scripting.RegisteredContentScript, url: string) {
    if (!Array.isArray(script.matches) || script.matches.length === 0) return false
    const included = script.matches.some((pattern) => matchesPattern(pattern, url))
    if (!included) return false
    const excluded = Array.isArray(script.excludeMatches)
      ? script.excludeMatches.some((pattern) => matchesPattern(pattern, url))
      : false
    return !excluded
  }

  private observeTab(tab: TabContents) {
    if (!tab || tab.isDestroyed() || this.observedTabs.has(tab.id)) return
    this.observedTabs.add(tab.id)

    const injectFor = (runAt: RunAt) => {
      void this.injectDynamicScripts(tab, runAt).catch((error) => {
        console.error('Dynamic scripting injection failed', error)
      })
    }

    tab.on('did-start-navigation', () => {
      this.injectedByTab.delete(tab.id)
      injectFor('document_start')
    })
    tab.on('dom-ready', () => injectFor('document_end'))
    tab.on('did-finish-load', () => injectFor('document_idle'))

    tab.once('destroyed', () => {
      this.observedTabs.delete(tab.id)
      this.injectedByTab.delete(tab.id)
    })
  }

  private async injectDynamicScripts(tab: TabContents, runAt: RunAt) {
    await this.registryReady
    if (!tab || tab.isDestroyed()) return
    const url = tab.getURL()
    if (!url || typeof url !== 'string') return

    const seen = this.injectedByTab.get(tab.id) || new Set<string>()
    this.injectedByTab.set(tab.id, seen)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    for (const [extensionId, scripts] of this.registryByExtension) {
      if (!Array.isArray(scripts) || scripts.length === 0) continue
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension) continue

      for (const script of scripts) {
        const targetRunAt = (script.runAt || 'document_idle') as RunAt
        if (targetRunAt !== runAt) continue
        if (!this.scriptMatchesUrl(script, url)) continue

        const dedupeKey = `${url}|${runAt}|${extensionId}|${script.id}`
        if (seen.has(dedupeKey)) continue

        if (Array.isArray(script.css)) {
          for (const cssPath of script.css) {
            const absPath = await validateExtensionResource(extension, cssPath)
            if (!absPath) continue
            const css = await fs.readFile(absPath, 'utf8')
            await tab.insertCSS(css)
          }
        }

        if (Array.isArray(script.js)) {
          for (const jsPath of script.js) {
            const absPath = await validateExtensionResource(extension, jsPath)
            if (!absPath) continue
            const jsCode = await fs.readFile(absPath, 'utf8')
            const world = script.world || 'ISOLATED'
            if (world !== 'MAIN' && typeof tab.executeJavaScriptInIsolatedWorld === 'function') {
              await tab.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: jsCode }], true)
            } else {
              await tab.executeJavaScript(jsCode, true)
            }
          }
        }

        seen.add(dedupeKey)
      }
    }
  }

  private validateRegisteredScript(script: chrome.scripting.RegisteredContentScript) {
    if (!script || typeof script !== 'object') {
      throw new Error('registerContentScripts: script object is required')
    }
    if (!script.id || typeof script.id !== 'string') {
      throw new Error('registerContentScripts: script.id is required')
    }
    if (!Array.isArray(script.matches) || script.matches.length === 0) {
      throw new Error('registerContentScripts: script.matches must be a non-empty array')
    }
    if (!Array.isArray(script.js) && !Array.isArray(script.css)) {
      throw new Error('registerContentScripts: script.js or script.css is required')
    }
  }

  private validateUpdateScript(script: chrome.scripting.RegisteredContentScript) {
    if (!script || typeof script !== 'object' || !script.id || typeof script.id !== 'string') {
      throw new Error('updateContentScripts: script.id is required')
    }
    if (
      typeof script.matches === 'undefined' &&
      typeof script.excludeMatches === 'undefined' &&
      typeof script.js === 'undefined' &&
      typeof script.css === 'undefined' &&
      typeof script.runAt === 'undefined' &&
      typeof script.world === 'undefined' &&
      typeof script.persistAcrossSessions === 'undefined' &&
      typeof script.matchOriginAsFallback === 'undefined'
    ) {
      throw new Error(`updateContentScripts: script "${script.id}" has no mutable fields`)
    }
  }

  private async registerContentScripts(
    event: ExtensionEvent,
    scripts: chrome.scripting.RegisteredContentScript[],
  ) {
    await this.registryReady
    if (!Array.isArray(scripts) || scripts.length === 0) return
    const extensionId = event.extension.id
    const current = this.registryByExtension.get(extensionId) || []
    const ids = new Set(current.map((s) => s.id))

    scripts.forEach((script) => {
      this.validateRegisteredScript(script)
      if (ids.has(script.id)) {
        throw new Error(`registerContentScripts: duplicate script id "${script.id}"`)
      }
      current.push(this.cloneScripts([script])[0])
      ids.add(script.id)
    })

    this.registryByExtension.set(extensionId, current)
    this.persistRegistry()
  }

  private async getRegisteredContentScripts(
    event: ExtensionEvent,
    filter?: { ids?: string[] },
  ): Promise<chrome.scripting.RegisteredContentScript[]> {
    await this.registryReady
    const extensionId = event.extension.id
    const all = this.registryByExtension.get(extensionId) || []
    const ids = filter?.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return this.cloneScripts(all)
    }
    const selected = all.filter((script) => ids.includes(script.id))
    return this.cloneScripts(selected)
  }

  private async unregisterContentScripts(
    event: ExtensionEvent,
    filter?: { ids?: string[] },
  ): Promise<void> {
    await this.registryReady
    const extensionId = event.extension.id
    const all = this.registryByExtension.get(extensionId) || []
    if (!filter || !Array.isArray(filter.ids) || filter.ids.length === 0) {
      this.registryByExtension.delete(extensionId)
      this.persistRegistry()
      return
    }
    const ids = new Set(filter.ids)
    const next = all.filter((script) => !ids.has(script.id))
    if (next.length > 0) this.registryByExtension.set(extensionId, next)
    else this.registryByExtension.delete(extensionId)
    this.persistRegistry()
  }

  private async updateContentScripts(
    event: ExtensionEvent,
    scripts: chrome.scripting.RegisteredContentScript[],
  ): Promise<void> {
    await this.registryReady
    if (!Array.isArray(scripts) || scripts.length === 0) return
    const extensionId = event.extension.id
    const current = this.registryByExtension.get(extensionId) || []
    const byId = new Map(current.map((script) => [script.id, script]))

    scripts.forEach((update) => {
      this.validateUpdateScript(update)
      const existing = byId.get(update.id)
      if (!existing) {
        throw new Error(`updateContentScripts: unknown script id "${update.id}"`)
      }

      const merged: chrome.scripting.RegisteredContentScript = {
        ...existing,
        ...this.cloneScripts([update])[0],
        id: existing.id,
      }
      this.validateRegisteredScript(merged)
      byId.set(merged.id, merged)
    })

    this.registryByExtension.set(extensionId, Array.from(byId.values()))
    this.persistRegistry()
  }

  private async insertCSS(_event: ExtensionEvent, injection: any): Promise<void> {
    const tabId = injection?.target?.tabId
    const css = injection?.css
    if (typeof tabId !== 'number' || typeof css !== 'string') return

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${tabId}`)
    }

    const frame = resolveInjectionFrame(
      tab,
      injection?.target,
      (id) => this.ctx.store.resolveByDocumentId(id),
      tabId,
    )
    if (!frame || frame.isDestroyed()) {
      throw new Error('insertCSS: frame not available')
    }
    if (frame.top && frame !== frame.top) {
      const code = `(function(){var e=document.createElement('style');e.textContent=${JSON.stringify(css)};(document.head||document.documentElement).appendChild(e);})()`
      await frame.executeJavaScript(code, true)
      return
    }

    await tab.insertCSS(css)
  }

  private async executeScript(
    _event: ExtensionEvent,
    injection: any,
  ): Promise<{ documentId?: string; frameId?: number; result?: unknown }[]> {
    const tabId = injection?.target?.tabId
    if (typeof tabId !== 'number') {
      throw new Error('executeScript: target.tabId is required')
    }

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${tabId}`)
    }

    const funcSrc =
      typeof injection.func === 'string' ? injection.func : String(injection.func ?? '')
    if (!funcSrc.trim()) {
      throw new Error('executeScript: func is required')
    }
    const args = Array.isArray(injection.args) ? injection.args : []
    const frame = resolveInjectionFrame(
      tab,
      injection?.target,
      (id) => this.ctx.store.resolveByDocumentId(id),
      tabId,
    )
    if (!frame || frame.isDestroyed()) {
      throw new Error('executeScript: frame not available')
    }

    const resolvedFrameId = frameId(frame)
    const documentId =
      this.ctx.store.getDocumentId(tabId, resolvedFrameId) ||
      this.ctx.store.newDocumentId(tabId, resolvedFrameId)

    const code = `(function(){ const __a = ${JSON.stringify(args)}; var fn = ${funcSrc}; return fn.apply(null, __a); })()`

    const world = injection.world
    const isolated = world !== 'MAIN' && world !== 1

    if (isolated) {
      // Isolated world only works on the top frame in Electron.
      if (frame === frame.top && typeof tab.executeJavaScriptInIsolatedWorld === 'function') {
        const out = await tab.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }], true)
        return [{ documentId, frameId: resolvedFrameId, result: out }]
      }
      throw new Error('executeScript: ISOLATED world is unavailable for this frame')
    }

    const result = await frame.executeJavaScript(code, true)
    return [{ documentId, frameId: resolvedFrameId, result }]
  }
}
