import { app, webContents as allWebContents } from 'electron'
import { ExtensionContext } from '../context'
import { ArgSpec } from './arg-check'
import { ExtensionSettings, serveChromeSetting } from './chrome-setting'

type WebRTCPolicy = Parameters<Electron.WebContents['setWebRTCIPHandlingPolicy']>[0]

const IP_HANDLING_POLICIES = [
  'default',
  'default_public_and_private_interfaces',
  'default_public_interface_only',
  'disable_non_proxied_udp',
] as const

const AUTOFILL_BLOCKED_TYPES = ['contact_info', 'payments', 'identity_docs', 'travel', 'all'] as const

const BOOLEAN: ArgSpec = { type: 'boolean' }

const AUTOFILL_SETTINGS: ArgSpec = {
  type: 'array',
  ref: 'privacy.AutofillSettings',
  items: {
    type: 'object',
    properties: {
      urlPattern: { type: 'string' },
      blockedTypes: {
        type: 'array',
        items: { type: 'string', enum: AUTOFILL_BLOCKED_TYPES, ref: 'privacy.AutofillBlockedType' },
      },
    },
  },
}

const SANDBOX_ERROR = 'Extensions aren’t allowed to enable Privacy Sandbox APIs.'
const MAX_AUTOFILL_ENTRIES = 1000

interface PrivacySetting {
  /** Chrome's default for a new profile. */
  value: unknown
  spec: ArgSpec
  /** The Chrome pref behind it, when two settings share one. */
  pref?: string
  /** A Privacy Sandbox API: extensions may turn it off, never on. */
  sandbox?: boolean
}

/**
 * Every chrome.privacy setting Chrome 157 has on desktop, with Chrome's
 * defaults. protectedContentEnabled is left out: Chrome has it only on Windows
 * and ChromeOS.
 */
export const PRIVACY_SETTINGS: Record<string, PrivacySetting> = {
  'network.networkPredictionEnabled': { value: true, spec: BOOLEAN },
  'network.webRTCIPHandlingPolicy': {
    value: 'default',
    spec: { type: 'string', enum: IP_HANDLING_POLICIES, ref: 'privacy.IPHandlingPolicy' },
  },
  'services.alternateErrorPagesEnabled': { value: true, spec: BOOLEAN },
  // autofillEnabled is Chrome's old name for the address setting, and changes it.
  'services.autofillAddressEnabled': { value: true, spec: BOOLEAN, pref: 'autofill.profile' },
  'services.autofillCreditCardEnabled': { value: true, spec: BOOLEAN },
  'services.autofillEnabled': { value: true, spec: BOOLEAN, pref: 'autofill.profile' },
  'services.autofillSettings': { value: [], spec: AUTOFILL_SETTINGS },
  'services.passwordSavingEnabled': { value: true, spec: BOOLEAN },
  'services.safeBrowsingEnabled': { value: true, spec: BOOLEAN },
  'services.safeBrowsingExtendedReportingEnabled': { value: false, spec: BOOLEAN },
  'services.searchSuggestEnabled': { value: true, spec: BOOLEAN },
  'services.spellingServiceEnabled': { value: false, spec: BOOLEAN },
  'services.translationServiceEnabled': { value: true, spec: BOOLEAN },
  'websites.adMeasurementEnabled': { value: false, spec: BOOLEAN, sandbox: true },
  'websites.doNotTrackEnabled': { value: false, spec: BOOLEAN },
  'websites.fledgeEnabled': { value: false, spec: BOOLEAN, sandbox: true },
  'websites.hyperlinkAuditingEnabled': { value: true, spec: BOOLEAN },
  'websites.referrersEnabled': { value: true, spec: BOOLEAN },
  'websites.thirdPartyCookiesAllowed': { value: true, spec: BOOLEAN },
  'websites.topicsEnabled': { value: false, spec: BOOLEAN, sandbox: true },
}

const keyFor = (name: string) => `privacy.${PRIVACY_SETTINGS[name].pref ?? name}`

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

/** What a host hears when a chrome.privacy setting changes. */
export interface PrivacySettingChange {
  /** Such as 'websites.doNotTrackEnabled'. */
  name: string
  value: unknown
  /** The extension whose value counts, or undefined for Chrome's default. */
  controlledBy?: string
}

/**
 * chrome.privacy. Every setting can be read, set and cleared, with Chrome's
 * levels of control between extensions, and is kept per session.
 *
 * What the library can apply, it applies: webRTCIPHandlingPolicy on every page
 * of the session, and doNotTrackEnabled and referrersEnabled on the requests
 * that pass through the host's webRequest bridge (see
 * `ElectronChromeExtensions.notifyWebRequestOnBeforeSendHeaders`). The other
 * settings are the host's own features (autofill, password saving, search
 * suggestions, ...): the host reads them with
 * `ElectronChromeExtensions.getPrivacySettings()` and hears changes on its
 * 'privacy-setting-changed' event.
 */
export class PrivacyAPI {
  private settings: ExtensionSettings
  /** The policy each page had before an extension took control of it. */
  private webrtcOriginal = new WeakMap<Electron.WebContents, WebRTCPolicy>()

  constructor(private ctx: ExtensionContext) {
    this.settings = ExtensionSettings.for(ctx)

    for (const [name, setting] of Object.entries(PRIVACY_SETTINGS)) {
      serveChromeSetting(ctx, this.settings, {
        name: `privacy.${name}`,
        key: keyFor(name),
        permission: 'privacy',
        defaultValue: () => clone(setting.value),
        valueSpec: setting.spec,
        accept: (value) => {
          if (setting.sandbox && value === true) throw new Error(SANDBOX_ERROR)
          if (Array.isArray(value)) {
            if (value.length > MAX_AUTOFILL_ENTRIES) throw new Error('Invalid invocation')
            return value.map((entry: any) => ({
              urlPattern: String(entry.urlPattern).slice(0, 2048),
              blockedTypes: [...new Set<string>(entry.blockedTypes)],
            }))
          }
          return value
        },
      })
    }

    this.settings.onChange(({ key, controller }) => {
      for (const name of Object.keys(PRIVACY_SETTINGS)) {
        if (keyFor(name) !== key) continue
        const change: PrivacySettingChange = { name, value: this.get(name), controlledBy: controller }
        ctx.emit('privacy-setting-changed', change)
      }
      if (key === keyFor('network.webRTCIPHandlingPolicy')) this.applyWebRTCPolicyToAll()
    })

    // Pages made later follow the policy too, as every page in Chrome does.
    app.on('web-contents-created', (_event, contents) => {
      if (contents.session !== ctx.session) return
      if (this.settings.effective(keyFor('network.webRTCIPHandlingPolicy'))) this.applyWebRTCPolicy(contents)
    })
  }

  /** The value that counts for a setting such as 'websites.doNotTrackEnabled'. */
  get(name: string): unknown {
    const setting = PRIVACY_SETTINGS[name]
    if (!setting) return undefined
    const current = this.settings.effective(keyFor(name))
    return clone(current ? current.value : setting.value)
  }

  /** Every setting's value that counts, as { network: {...}, services: {...}, websites: {...} }. */
  getAll(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const name of Object.keys(PRIVACY_SETTINGS)) {
      const [group, setting] = name.split('.')
      ;(out[group] ||= {})[setting] = this.get(name)
    }
    return out
  }

  /**
   * Adds what the privacy settings ask of a request's headers: DNT: 1 while
   * doNotTrackEnabled is on, and no Referer while referrersEnabled is off.
   * Returns undefined when nothing changes.
   */
  requestHeadersFor(headers: Record<string, string | string[]> | undefined) {
    // Read without copying: this runs for every request.
    const dnt = this.settings.effective(keyFor('websites.doNotTrackEnabled'))?.value === true
    const noReferrer = this.settings.effective(keyFor('websites.referrersEnabled'))?.value === false
    if (!dnt && !noReferrer) return undefined
    const out: Record<string, string | string[]> = { ...(headers || {}) }
    let changed = false
    const find = (name: string) => Object.keys(out).filter((k) => k.toLowerCase() === name)
    if (dnt && find('dnt').length === 0) {
      out.DNT = '1'
      changed = true
    }
    if (noReferrer) {
      for (const k of find('referer')) {
        delete out[k]
        changed = true
      }
    }
    return changed ? out : undefined
  }

  private applyWebRTCPolicyToAll() {
    for (const contents of allWebContents.getAllWebContents()) {
      if (contents.session === this.ctx.session) this.applyWebRTCPolicy(contents)
    }
  }

  private applyWebRTCPolicy(contents: Electron.WebContents) {
    if (contents.isDestroyed()) return
    const controlled = this.settings.effective(keyFor('network.webRTCIPHandlingPolicy'))
    try {
      if (controlled) {
        if (!this.webrtcOriginal.has(contents)) {
          this.webrtcOriginal.set(contents, contents.getWebRTCIPHandlingPolicy() as WebRTCPolicy)
        }
        contents.setWebRTCIPHandlingPolicy(controlled.value as WebRTCPolicy)
      } else if (this.webrtcOriginal.has(contents)) {
        // Back to what the host had set, not to a default of ours.
        contents.setWebRTCIPHandlingPolicy(this.webrtcOriginal.get(contents)!)
        this.webrtcOriginal.delete(contents)
      }
    } catch {
      // A page being torn down.
    }
  }
}
