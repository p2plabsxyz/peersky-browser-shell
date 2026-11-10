import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * chrome.permissions, on top of the session's ExtensionPermissions, which
 * every other API checks against too. Optional permissions are granted only
 * after a user gesture and the person's yes, and are kept across restarts.
 */
export class PermissionsAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('permissions.contains', this.contains)
    handle('permissions.getAll', this.getAll)
    handle('permissions.remove', this.remove)
    handle('permissions.request', this.request)
    handle('permissions.addHostAccessRequest', this.hostAccessRequest)
    handle('permissions.removeHostAccessRequest', this.hostAccessRequest)
  }

  private contains = ({ extension }: ExtensionEvent, permissions: chrome.permissions.Permissions) =>
    this.ctx.permissions.contains(extension as Electron.Extension, permissions || {})

  private getAll = ({ extension }: ExtensionEvent) =>
    this.ctx.permissions.getAll(extension as Electron.Extension)

  private remove = ({ extension }: ExtensionEvent, permissions: chrome.permissions.Permissions) =>
    this.ctx.permissions.remove(extension as Electron.Extension, permissions || {})

  private request = (event: ExtensionEvent, permissions: chrome.permissions.Permissions) =>
    this.ctx.permissions.request(
      event.extension as Electron.Extension,
      permissions || {},
      !!event.gesture || this.ctx.store.hasUserGesture(event.extension.id),
    )

  /**
   * Chrome shows a request in its toolbar for the person to grant later. The
   * shell has no such toolbar entry, so it only checks the tab exists.
   */
  private hostAccessRequest = (
    _event: ExtensionEvent,
    request: { tabId?: number; documentId?: string; pattern?: string } = {},
  ) => {
    if (typeof request.tabId === 'number' && !this.ctx.store.getTabById(request.tabId)) {
      throw new Error(`No tab with id: ${request.tabId}.`)
    }
  }
}
