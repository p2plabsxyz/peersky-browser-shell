import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { checkArgs, MAX_URL_LENGTH, tryParseUrl } from './lib/arg-spec'

const DISPOSITIONS = ['CURRENT_TAB', 'NEW_TAB', 'NEW_WINDOW'] as const
type Disposition = (typeof DISPOSITIONS)[number]

const SIGNATURE = 'search.query(search.QueryInfo queryInfo, optional function callback)'
const PARAMS = [
  {
    name: 'queryInfo',
    spec: {
      type: 'object' as const,
      properties: {
        text: { type: 'string' as const },
        disposition: { type: 'string' as const, enum: DISPOSITIONS, optional: true },
        tabId: { type: 'integer' as const, optional: true },
      },
    },
  },
]

/** The search engine used when the host gives none. */
export const defaultSearchUrl = (text: string) => `https://duckduckgo.com/?q=${encodeURIComponent(text)}`

/**
 * chrome.search.query: searches with the host's search engine (its
 * `getSearchUrl` hook), or DuckDuckGo, in the tab or window asked for.
 */
export class SearchAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('search.query', (event: ExtensionEvent, ...args: any[]) => {
      const [info] = checkArgs(SIGNATURE, PARAMS, args) as [{ text: string; disposition?: Disposition; tabId?: number }]
      return this.query(event, info)
    })
  }

  private async searchUrl(text: string) {
    const hook = this.ctx.store.impl.getSearchUrl
    if (typeof hook === 'function') {
      try {
        const url: unknown = await hook(text)
        const parsed = typeof url === 'string' ? tryParseUrl(url) : undefined
        if (parsed && parsed.protocol !== 'javascript:' && parsed.href.length <= MAX_URL_LENGTH) return parsed.href
      } catch (error) {
        console.error('getSearchUrl failed, searching with the default engine:', error)
      }
    }
    return defaultSearchUrl(text)
  }

  private async query(event: ExtensionEvent, info: { text: string; disposition?: Disposition; tabId?: number }) {
    if (!info.text) throw new Error('Empty text parameter.')
    if (info.tabId !== undefined && info.disposition !== undefined) {
      throw new Error("Cannot set both 'disposition' and 'tabId'.")
    }
    const { store } = this.ctx
    let target: Electron.WebContents | undefined
    if (info.tabId !== undefined) {
      target = store.getTabById(info.tabId)
      if (!target) throw new Error(`No tab with id: ${info.tabId}.`)
    }
    const disposition = info.disposition ?? 'CURRENT_TAB'
    if (!target && disposition === 'CURRENT_TAB') {
      const win = store.getCurrentWindowForExtension(event.extension.id)
      target = win ? store.getActiveTabFromWindow(win) : undefined
      if (!target) throw new Error('No active browser.')
    }
    const url = await this.searchUrl(info.text)
    if (target) {
      if (target.isDestroyed()) throw new Error(`No tab with id: ${info.tabId ?? target.id}.`)
      target.loadURL(url).catch(() => {})
      return
    }
    if (disposition === 'NEW_WINDOW' && typeof store.impl.createWindow === 'function') {
      await store.createWindow(event, { url, focused: true })
      return
    }
    // A host without windows of its own gets a new tab.
    await store.createTab({ url, active: true })
  }
}
