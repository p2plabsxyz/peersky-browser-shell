import { ExtensionContext } from './context'
import { tabApis } from './api/tabs'

/**
 * The person invoked an extension on a tab: a toolbar click, one of its
 * context menu items, its keyboard shortcut or its omnibox keyword. As in
 * Chrome, the extension gets a user gesture and, with activeTab (or
 * tabCapture), access to that tab's page until it leaves for another origin.
 */
export function noteInvocation(ctx: ExtensionContext, extensionId: string, tab?: Electron.WebContents) {
  ctx.store.noteUserGesture(extensionId)
  const extension = (ctx.session.extensions || ctx.session).getExtension(extensionId)
  if (!extension || !tab || tab.isDestroyed() || !ctx.store.tabs?.has(tab)) return
  ctx.permissions.grantActiveTab(extension, ctx.store.getTabIdForWebContentsId(tab.id), tab.getURL())
}

/** A tab's details as this extension may see them: url and title only with access. */
export function tabForExtension<T extends Partial<chrome.tabs.Tab>>(
  ctx: ExtensionContext,
  extensionId: string,
  details: T | undefined,
): T | undefined {
  if (!details) return details
  const extension = (ctx.session.extensions || ctx.session).getExtension(extensionId)
  const tabs = tabApis(ctx).tabs
  return tabs && extension ? tabs.forExtension(extension, details as any) : details
}
