import { ExtensionContext } from '../context'

/** chrome.sessions. Not served yet: calls fail as unregistered handlers. */
export class SessionsAPI {
  constructor(private ctx: ExtensionContext) {}
}
