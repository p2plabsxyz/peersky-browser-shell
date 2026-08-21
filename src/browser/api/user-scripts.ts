import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const USER_SCRIPT_WORLD = 1001

type RegisteredUserScript = Record<string, any> & { id: string }

/**
 * chrome.userScripts
 *
 * Enough of the API for extensions that use it as an injection primitive
 * (uBlock Origin MV3 gates its entire boot on getScripts() not throwing, then
 * injects through execute()). Registered scripts are stored and reported back
 * but are not auto-injected into matching pages; execute() is the live path.
 *
 * World mapping: MAIN runs in the page's world. USER_SCRIPT (the default)
 * runs in an isolated world, which Electron only supports on the top frame —
 * subframe USER_SCRIPT injections resolve to no-ops rather than rejecting,
 * so callers that fan out over frames keep working.
 */
export class UserScriptsAPI {
  private scripts = new Map<string, Map<string, RegisteredUserScript>>()
  private worldConfigs = new Map<string, Record<string, any>[]>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const opts = { permission: 'userScripts' as any }
    handle('userScripts.getScripts', this.getScripts, opts)
    handle('userScripts.register', this.register, opts)
    handle('userScripts.unregister', this.unregister, opts)
    handle('userScripts.update', this.update, opts)
    handle('userScripts.execute', this.execute, opts)
    handle('userScripts.configureWorld', this.configureWorld, opts)
    handle('userScripts.getWorldConfigurations', this.getWorldConfigurations, opts)
    handle('userScripts.resetWorldConfiguration', this.resetWorldConfiguration, opts)
  }

  private bucket(extensionId: string) {
    let map = this.scripts.get(extensionId)
    if (!map) {
      map = new Map()
      this.scripts.set(extensionId, map)
    }
    return map
  }

  private getScripts = (event: ExtensionEvent, filter?: { ids?: string[] }) => {
    const all = [...this.bucket(event.extension.id).values()]
    if (Array.isArray(filter?.ids)) return all.filter((s) => filter.ids!.includes(s.id))
    return all
  }

  private register = (event: ExtensionEvent, scripts: RegisteredUserScript[]) => {
    const map = this.bucket(event.extension.id)
    for (const script of scripts || []) {
      if (!script?.id) throw new Error('userScripts.register: script id is required')
      if (map.has(script.id)) throw new Error(`Duplicate script id: ${script.id}`)
      map.set(script.id, script)
    }
  }

  private update = (event: ExtensionEvent, scripts: RegisteredUserScript[]) => {
    const map = this.bucket(event.extension.id)
    for (const script of scripts || []) {
      const existing = script?.id ? map.get(script.id) : undefined
      if (!existing) throw new Error(`Script not found: ${script?.id}`)
      map.set(script.id, { ...existing, ...script })
    }
  }

  private unregister = (event: ExtensionEvent, filter?: { ids?: string[] }) => {
    const map = this.bucket(event.extension.id)
    if (!filter?.ids) {
      map.clear()
      return
    }
    for (const id of filter.ids) map.delete(id)
  }

  private configureWorld = (event: ExtensionEvent, properties?: Record<string, any>) => {
    const configs = this.worldConfigs.get(event.extension.id) || []
    const worldId = properties?.worldId || ''
    const next = configs.filter((c) => (c.worldId || '') !== worldId)
    next.push({ ...(properties || {}), worldId })
    this.worldConfigs.set(event.extension.id, next)
  }

  private getWorldConfigurations = (event: ExtensionEvent) => {
    return this.worldConfigs.get(event.extension.id) || []
  }

  private resetWorldConfiguration = (event: ExtensionEvent, worldId?: string) => {
    const configs = this.worldConfigs.get(event.extension.id) || []
    this.worldConfigs.set(
      event.extension.id,
      configs.filter((c) => (c.worldId || '') !== (worldId || '')),
    )
  }

  private execute = async (
    event: ExtensionEvent,
    injection: {
      target?: { tabId?: number; frameIds?: number[]; allFrames?: boolean }
      js?: { code?: string; file?: string }[]
      world?: string
      injectImmediately?: boolean
    },
  ): Promise<{ frameId: number; result?: unknown; error?: string }[]> => {
    const tabId = injection?.target?.tabId
    if (typeof tabId !== 'number') {
      throw new Error('userScripts.execute: target.tabId is required')
    }

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`No tab with id: ${tabId}`)
    }

    const sources: string[] = []
    for (const entry of injection?.js || []) {
      if (typeof entry?.code === 'string' && entry.code) {
        sources.push(entry.code)
      } else if (typeof entry?.file === 'string' && entry.file) {
        const abs = path.join(event.extension.path, entry.file.replace(/^\//, ''))
        const rel = path.relative(event.extension.path, abs)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`userScripts.execute: file escapes extension root: ${entry.file}`)
        }
        sources.push(await fs.readFile(abs, 'utf8'))
      }
    }
    if (!sources.length) return []
    const code = sources.join(';\n')

    const wantedFrameIds = injection?.target?.frameIds
    const frames: Electron.WebFrameMain[] = []
    const mainFrame = tab.mainFrame
    if (Array.isArray(wantedFrameIds) && wantedFrameIds.length) {
      for (const frame of mainFrame.framesInSubtree) {
        if (!frame.isDestroyed() && wantedFrameIds.includes(frame.routingId)) frames.push(frame)
      }
    } else if (injection?.target?.allFrames) {
      for (const frame of mainFrame.framesInSubtree) {
        if (!frame.isDestroyed()) frames.push(frame)
      }
    } else {
      frames.push(mainFrame)
    }

    const isMainWorld = injection?.world === 'MAIN'
    const results: { frameId: number; result?: unknown; error?: string }[] = []

    for (const frame of frames) {
      const id = frame.routingId
      try {
        if (isMainWorld) {
          results.push({ frameId: id, result: await frame.executeJavaScript(code, true) })
        } else if (frame === mainFrame && typeof tab.executeJavaScriptInIsolatedWorld === 'function') {
          const result = await tab.executeJavaScriptInIsolatedWorld(USER_SCRIPT_WORLD, [{ code }], true)
          results.push({ frameId: id, result })
        } else {
          // No isolated-world API for subframes; skip rather than leak into MAIN.
          results.push({ frameId: id, result: undefined })
        }
      } catch (error) {
        results.push({ frameId: id, error: (error as Error)?.message })
      }
    }
    return results
  }
}
