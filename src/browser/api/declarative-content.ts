import { ExtensionContext } from '../context'

/** chrome.declarativeContent. Not served yet: calls fail as unregistered handlers. */
export class DeclarativeContentAPI {
  constructor(private ctx: ExtensionContext) {}
}
