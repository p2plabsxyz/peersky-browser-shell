import { ExtensionContext } from '../context'
import { HistoryAPI } from './history'
import { checkArgs } from './lib/arg-spec'

/** How many sites Chrome lists. */
const TOP_SITES_COUNT = 10

/**
 * chrome.topSites: the most visited sites in the session's history. Chrome
 * lists its own suggestions in a new profile; here a new profile has none.
 */
export class TopSitesAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('topSites.get', async (_event, ...args: any[]) => {
      checkArgs('topSites.get(optional function callback)', [], args)
      const history = HistoryAPI.forContext(this.ctx)
      return history ? history.mostVisited(TOP_SITES_COUNT) : []
    })
  }
}
