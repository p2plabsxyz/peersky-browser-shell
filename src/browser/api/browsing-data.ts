import { ExtensionContext } from '../context'

/** chrome.browsingData. Not served yet: calls fail as unregistered handlers. */
export class BrowsingDataAPI {
  constructor(private ctx: ExtensionContext) {}
}
