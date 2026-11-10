import { ExtensionContext } from '../context'

/** chrome.tts. Not served yet: calls fail as unregistered handlers. */
export class TtsAPI {
  constructor(private ctx: ExtensionContext) {}
}
