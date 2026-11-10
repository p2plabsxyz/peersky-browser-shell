import { ExtensionContext } from '../context'

/** chrome.readingList. Not served yet: calls fail as unregistered handlers. */
export class ReadingListAPI {
  constructor(private ctx: ExtensionContext) {}
}
