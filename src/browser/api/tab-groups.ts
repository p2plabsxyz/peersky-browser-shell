import { ExtensionContext } from '../context'

/** chrome.tabGroups. Not served yet: calls fail as unregistered handlers. */
export class TabGroupsAPI {
  constructor(private ctx: ExtensionContext) {}
}
