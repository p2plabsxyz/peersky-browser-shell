import { WebContents } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import debug from 'debug'

const d = debug('electron-chrome-extensions:debugger')

type AttachedEntry = {
  onDetach: (event: Electron.Event, reason: string) => void
  onMessage: (event: Electron.Event, method: string, params: object) => void
}

export class DebuggerAPI {
  private attached = new Map<string, Map<number, AttachedEntry>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()

    handle('debugger.attach', this.attach, { extensionContext: true, permission: 'debugger' })
    handle('debugger.detach', this.detach, { extensionContext: true, permission: 'debugger' })
    handle('debugger.getTargets', this.getTargets, { extensionContext: true, permission: 'debugger' })
    handle('debugger.sendCommand', this.sendCommand, { extensionContext: true, permission: 'debugger' })

    const sessionExtensions = ctx.session.extensions || (ctx.session as any)
    sessionExtensions.on('extension-unloaded', (_event: any, extension: Electron.Extension) => {
      this.detachAll(extension.id)
    })
  }

  private attach = async (
    { extension }: ExtensionEvent,
    target: chrome.debugger.Debuggee,
    requiredVersion: string = '1.1',
  ) => {
    const { tabId } = target
    if (typeof tabId !== 'number') {
      throw new Error('chrome.debugger.attach: tabId is required')
    }

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) {
      throw new Error(`chrome.debugger.attach: no tab with id ${tabId}`)
    }

    const extensionId = extension.id
    const extMap = this.getOrCreateExtMap(extensionId)

    if (extMap.has(tabId)) {
      throw new Error(`chrome.debugger.attach: already attached to tab ${tabId}`)
    }

    const onDetach = (_event: Electron.Event, reason: string) => {
      d(`debugger detached from tab ${tabId}: ${reason}`)
      this.cleanupEntry(extensionId, tabId)
      this.ctx.router.sendEvent(extensionId, 'debugger.onDetach', { tabId }, reason)
    }

    const onMessage = (_event: Electron.Event, method: string, params: object) => {
      d(`debugger event from tab ${tabId}: ${method}`)
      this.ctx.router.sendEvent(
        extensionId,
        'debugger.onEvent',
        { tabId },
        method,
        params,
      )
    }

    tab.debugger.on('detach', onDetach)
    tab.debugger.on('message', onMessage)

    try {
      tab.debugger.attach(requiredVersion)
    } catch (err: any) {
      tab.debugger.removeListener('detach', onDetach)
      tab.debugger.removeListener('message', onMessage)
      throw new Error(`chrome.debugger.attach failed for tab ${tabId}: ${err.message}`)
    }

    extMap.set(tabId, { onDetach, onMessage })

    tab.once('destroyed', () => {
      this.cleanupEntry(extensionId, tabId)
    })

    d(`extension ${extensionId} attached debugger to tab ${tabId}`)
  }

  private detach = async (
    { extension }: ExtensionEvent,
    target: chrome.debugger.Debuggee,
  ) => {
    const { tabId } = target
    if (typeof tabId !== 'number') {
      throw new Error('chrome.debugger.detach: tabId is required')
    }

    const extensionId = extension.id
    const extMap = this.attached.get(extensionId)
    if (!extMap?.has(tabId)) {
      throw new Error(
        `chrome.debugger.detach: extension ${extensionId} is not attached to tab ${tabId}`,
      )
    }

    const tab = this.ctx.store.getTabById(tabId)
    if (tab && !tab.isDestroyed()) {
      try {
        tab.debugger.detach()
      } catch {
        // Ignored
      }
      const entry = extMap.get(tabId)
      if (entry) {
        this.removeListeners(tab, entry)
      }
    }

    extMap.delete(tabId)
    if (extMap.size === 0) {
      this.attached.delete(extensionId)
    }

    d(`extension ${extensionId} detached debugger from tab ${tabId}`)
  }

  private getTargets = (_event: ExtensionEvent): chrome.debugger.TargetInfo[] => {
    const results: chrome.debugger.TargetInfo[] = []

    for (const tab of this.ctx.store.tabs) {
      if (tab.isDestroyed()) continue
      results.push({
        type: 'page' as const,
        id: String(tab.id),
        tabId: tab.id,
        attached: tab.debugger.isAttached(),
        title: tab.getTitle(),
        url: tab.getURL(),
      })
    }

    return results
  }

  private sendCommand = async (
    { extension }: ExtensionEvent,
    target: chrome.debugger.Debuggee,
    method: string,
    commandParams?: object,
  ) => {
    const { tabId } = target
    if (typeof tabId !== 'number') {
      throw new Error('chrome.debugger.sendCommand: tabId is required')
    }

    const extensionId = extension.id
    const extMap = this.attached.get(extensionId)
    if (!extMap?.has(tabId)) {
      throw new Error(
        `chrome.debugger.sendCommand: extension ${extensionId} is not attached to tab ${tabId}`,
      )
    }

    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) {
      throw new Error(`chrome.debugger.sendCommand: tab ${tabId} no longer exists`)
    }

    d(`sending CDP command ${method} to tab ${tabId}`)
    const result = await tab.debugger.sendCommand(method, commandParams)
    return result
  }

  private getOrCreateExtMap(extensionId: string) {
    if (!this.attached.has(extensionId)) {
      this.attached.set(extensionId, new Map())
    }
    return this.attached.get(extensionId)!
  }

  private removeListeners(tab: WebContents, entry: AttachedEntry) {
    tab.debugger.removeListener('detach', entry.onDetach)
    tab.debugger.removeListener('message', entry.onMessage)
  }

  private cleanupEntry(extensionId: string, tabId: number) {
    const extMap = this.attached.get(extensionId)
    if (!extMap) return

    const entry = extMap.get(tabId)
    if (entry) {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab && !tab.isDestroyed()) {
        this.removeListeners(tab, entry)
      }
    }

    extMap.delete(tabId)
    if (extMap.size === 0) {
      this.attached.delete(extensionId)
    }
  }

  private detachAll(extensionId: string) {
    const extMap = this.attached.get(extensionId)
    if (!extMap) return

    for (const [tabId, entry] of extMap) {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab && !tab.isDestroyed()) {
        try {
          tab.debugger.detach()
        } catch {
          // Ignored
        }
        this.removeListeners(tab, entry)
      }
    }

    this.attached.delete(extensionId)
    d(`cleaned up all debugger attachments for extension ${extensionId}`)
  }
}
