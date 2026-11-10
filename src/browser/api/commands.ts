import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type ManifestCommand = {
  description?: unknown
  suggested_key?: unknown
}

// Chrome lists the action's own command even when the manifest does not name
// it, with an empty description and no shortcut.
const actionCommandName = (manifest: chrome.runtime.Manifest): string | undefined => {
  if (manifest.manifest_version === 3) return manifest.action ? '_execute_action' : undefined
  if ((manifest as chrome.runtime.ManifestV2).browser_action) return '_execute_browser_action'
  if ((manifest as chrome.runtime.ManifestV2).page_action) return '_execute_page_action'
  return undefined
}

const platformKey = () => {
  switch (process.platform) {
    case 'darwin':
      return 'mac'
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      return 'default'
  }
}

// What Chrome shows for a shortcut: symbols in Chrome's order on macOS, where
// Ctrl means Command, and "Ctrl+Alt+Shift+Key" elsewhere.
export const formatShortcut = (accelerator: string, platform = process.platform): string => {
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()))
  if (platform === 'darwin') {
    let out = ''
    if (mods.has('macctrl')) out += '⌃'
    if (mods.has('alt')) out += '⌥'
    if (mods.has('shift')) out += '⇧'
    if (mods.has('ctrl') || mods.has('command')) out += '⌘'
    return out + key
  }
  const names: string[] = []
  if (mods.has('ctrl') || mods.has('macctrl')) names.push('Ctrl')
  if (mods.has('alt')) names.push('Alt')
  if (mods.has('shift')) names.push('Shift')
  if (mods.has('command') || mods.has('search')) names.push('Search')
  return [...names, key].join('+')
}

const suggestedKey = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const keys = value as Record<string, unknown>
  const own = keys[platformKey()]
  if (typeof own === 'string') return own
  return typeof keys.default === 'string' ? keys.default : ''
}

export class CommandsAPI {
  private commandMap = new Map</* extensionId */ string, chrome.commands.Command[]>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('commands.getAll', this.getAll, { permission: null })

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions().forEach((extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.removeCommands(extension)
    })
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    const declared =
      manifest.commands && typeof manifest.commands === 'object'
        ? (manifest.commands as Record<string, ManifestCommand>)
        : {}
    const commands: chrome.commands.Command[] = []

    const actionName = actionCommandName(manifest)
    if (actionName && !(actionName in declared)) {
      commands.push({ name: actionName, description: '', shortcut: '' })
    }

    for (const [name, details] of Object.entries(declared)) {
      const command = details && typeof details === 'object' ? details : {}
      const accelerator = suggestedKey(command.suggested_key)
      commands.push({
        name,
        description: typeof command.description === 'string' ? command.description : '',
        shortcut: accelerator ? formatShortcut(accelerator) : '',
      })
    }

    if (commands.length) this.commandMap.set(extension.id, commands)
    else this.commandMap.delete(extension.id)
  }

  private removeCommands(extension: Electron.Extension) {
    this.commandMap.delete(extension.id)
  }

  private getAll = ({ extension }: ExtensionEvent): chrome.commands.Command[] => {
    return (this.commandMap.get(extension.id) || []).map((c) => ({ ...c }))
  }

  /**
   * Runs a command the person pressed the shortcut for. The host calls this
   * from its own keyboard handling; it fires commands.onCommand with the
   * active tab, as Chrome does. The _execute_* commands open the action
   * instead, which is the host's to do, so they fire nothing here.
   */
  execute(extensionId: string, name: string) {
    if (name.startsWith('_execute_')) return false
    const commands = this.commandMap.get(extensionId)
    if (!commands?.some((c) => c.name === name)) return false
    const active = this.ctx.store.getActiveTabOfCurrentWindow()
    const tab = active ? this.ctx.store.tabDetailsCache.get(active.id) : undefined
    this.ctx.store.noteUserGesture(extensionId)
    this.ctx.router.sendEvent(extensionId, 'commands.onCommand', name, tab)
    return true
  }
}
