import { ExtensionContext } from '../context'

/** chrome.contentSettings. Not served yet: calls fail as unregistered handlers. */
export class ContentSettingsAPI {
  constructor(private ctx: ExtensionContext) {}
}
