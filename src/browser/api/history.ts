import { ExtensionContext } from '../context'

/** chrome.history. Not served yet: calls fail as unregistered handlers. */
export class HistoryAPI {
  constructor(private ctx: ExtensionContext) {}
}
