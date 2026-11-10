import { ExtensionContext } from '../context'

/** chrome.topSites. Not served yet: calls fail as unregistered handlers. */
export class TopSitesAPI {
  constructor(private ctx: ExtensionContext) {}
}
