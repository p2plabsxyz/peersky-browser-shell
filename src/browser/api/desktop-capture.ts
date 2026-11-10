import { ExtensionContext } from '../context'

/** chrome.desktopCapture. Not served yet: calls fail as unregistered handlers. */
export class DesktopCaptureAPI {
  constructor(private ctx: ExtensionContext) {}
}
