import { ExtensionContext } from '../context'

/** chrome.privacy. Not served yet: calls fail as unregistered handlers. */
export class PrivacyAPI {
  constructor(private ctx: ExtensionContext) {}
}
