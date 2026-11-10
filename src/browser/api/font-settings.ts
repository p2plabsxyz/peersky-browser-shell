import { ExtensionContext } from '../context'

/** chrome.fontSettings. Not served yet: calls fail as unregistered handlers. */
export class FontSettingsAPI {
  constructor(private ctx: ExtensionContext) {}
}
