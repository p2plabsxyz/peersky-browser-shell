import { ExtensionContext } from '../context'

/** chrome.pageCapture. Not served yet: calls fail as unregistered handlers. */
export class PageCaptureAPI {
  constructor(private ctx: ExtensionContext) {}
}
