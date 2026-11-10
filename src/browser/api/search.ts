import { ExtensionContext } from '../context'

/** chrome.search. Not served yet: calls fail as unregistered handlers. */
export class SearchAPI {
  constructor(private ctx: ExtensionContext) {}
}
