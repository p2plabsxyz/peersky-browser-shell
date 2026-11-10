import { ExtensionContext } from '../context'

/** chrome.omnibox. Not served yet: calls fail as unregistered handlers. */
export class OmniboxAPI {
  constructor(private ctx: ExtensionContext) {}
}
