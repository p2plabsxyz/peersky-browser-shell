import { ExtensionContext } from '../context'

/** chrome.tabCapture. Not served yet: calls fail as unregistered handlers. */
export class TabCaptureAPI {
  constructor(private ctx: ExtensionContext) {}
}
