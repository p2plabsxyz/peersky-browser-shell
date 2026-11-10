import { ExtensionContext } from '../context'

/** chrome.bookmarks. Not served yet: calls fail as unregistered handlers. */
export class BookmarksAPI {
  constructor(private ctx: ExtensionContext) {}
}
