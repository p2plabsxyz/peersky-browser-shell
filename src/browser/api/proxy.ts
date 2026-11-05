import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type ProxySettingDetails = {
  value: chrome.proxy.ProxyConfig
  levelOfControl: chrome.types.LevelOfControl
  incognitoSpecific: boolean
}

const PAC_DATA_MIME_TYPE = 'application/x-ns-proxy-autoconfig'
const PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5']

export class ProxyAPI {
  private currentConfig: chrome.proxy.ProxyConfig = { mode: 'system' }
  private controllingExtensionId?: string

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('proxy.settings.get', this.settingsGet, {
      extensionContext: true,
      permission: 'proxy',
    })
    handle('proxy.settings.set', this.settingsSet, {
      extensionContext: true,
      permission: 'proxy',
    })
    handle('proxy.settings.clear', this.settingsClear, {
      extensionContext: true,
      permission: 'proxy',
    })
  }

  private settingsGet = async (
    { extension }: ExtensionEvent,
    _details?: chrome.types.ChromeSettingGetDetails,
  ): Promise<ProxySettingDetails> => {
    const levelOfControl: chrome.types.LevelOfControl =
      !this.controllingExtensionId
        ? 'controllable_by_this_extension'
        : this.controllingExtensionId === extension.id
          ? 'controlled_by_this_extension'
          : 'controlled_by_other_extensions'

    return {
      value: this.currentConfig,
      levelOfControl,
      incognitoSpecific: false,
    }
  }

  private settingsSet = async (
    { extension }: ExtensionEvent,
    details: chrome.types.ChromeSettingSetDetails<chrome.proxy.ProxyConfig>,
  ): Promise<void> => {
    const config = (details?.value || { mode: 'system' }) as chrome.proxy.ProxyConfig
    console.log(
      `[ProxyAPI] proxy.settings.set from extension=${extension.id} mode=${config?.mode ?? 'system'}`,
    )
    await this.applyProxyConfig(config)
    this.currentConfig = config
    this.controllingExtensionId = extension.id
    this.emitSettingsChange()
  }

  private settingsClear = async ({ extension }: ExtensionEvent): Promise<void> => {
    if (this.controllingExtensionId && this.controllingExtensionId !== extension.id) {
      console.log(
        `[ProxyAPI] proxy.settings.clear denied for extension=${extension.id} controlledBy=${this.controllingExtensionId}`,
      )
      return
    }

    await this.ctx.session.setProxy({ mode: 'system' })
    this.currentConfig = { mode: 'system' }
    this.controllingExtensionId = undefined
    this.emitSettingsChange()
  }

  private async applyProxyConfig(config: chrome.proxy.ProxyConfig): Promise<void> {
    const mode = config?.mode || 'system'

    if (mode === 'direct') {
      console.log('[ProxyAPI] session.setProxy direct')
      await this.ctx.session.setProxy({ mode: 'direct' })
      return
    }

    if (mode === 'system') {
      console.log('[ProxyAPI] session.setProxy system')
      await this.ctx.session.setProxy({ mode: 'system' })
      return
    }

    if (mode === 'pac_script') {
      const pacScript = this.resolvePacScript(config.pacScript)
      console.log('[ProxyAPI] session.setProxy pac_script', {
        hasPacUrl: !!pacScript && !!config.pacScript?.url,
        hasPacData: !!pacScript && !!config.pacScript?.data,
      })
      await this.ctx.session.setProxy({
        mode: 'pac_script',
        pacScript,
      })
      return
    }

    if (mode === 'fixed_servers') {
      const proxyRules = this.resolveProxyRules(config.rules)
      // Chrome refuses rules it can't read. Setting none sent everything out
      // directly while the extension went on thinking its proxy was on.
      if (!proxyRules) throw new Error("Invalid 'rules' specified.")
      const proxyBypassRules = this.resolveBypassRules(config.rules)
      console.log('[ProxyAPI] session.setProxy fixed_servers', {
        proxyRules,
        proxyBypassRules,
      })
      await this.ctx.session.setProxy({
        mode: 'fixed_servers',
        proxyRules,
        proxyBypassRules,
      })
      return
    }

    console.log('[ProxyAPI] session.setProxy unknown mode', { mode })
    await this.ctx.session.setProxy({ mode: mode as Electron.ProxyConfig['mode'] })
  }

  private resolvePacScript(
    pacScript?: chrome.proxy.PacScript,
  ): string | undefined {
    if (!pacScript) return undefined
    if (pacScript.url) return pacScript.url
    if (!pacScript.data) return undefined

    const base64Data = Buffer.from(pacScript.data, 'utf8').toString('base64')
    return `data:${PAC_DATA_MIME_TYPE};base64,${base64Data}`
  }

  // Each server with its own scheme, the way Chrome writes them: without one,
  // Chromium took an HTTPS proxy for a plain HTTP one and SOCKS5 for SOCKS4.
  // fallbackProxy goes in the "socks=" slot, which Chromium reads as "for
  // everything else", whatever the server's scheme.
  private resolveProxyRules(rules?: chrome.proxy.ProxyRules): string | undefined {
    if (!rules) return undefined
    if (rules.singleProxy) return this.formatProxyUri(rules.singleProxy)

    const segments: string[] = []
    for (const [key, server] of [
      ['http', rules.proxyForHttp],
      ['https', rules.proxyForHttps],
      ['ftp', rules.proxyForFtp],
      ['socks', rules.fallbackProxy],
    ] as const) {
      const uri = this.formatProxyUri(server)
      if (uri) segments.push(`${key}=${uri}`)
    }

    if (segments.length === 0) return undefined
    return segments.join(';')
  }

  private resolveBypassRules(rules?: chrome.proxy.ProxyRules): string | undefined {
    const bypassList = rules?.bypassList
    if (!bypassList || bypassList.length === 0) return undefined
    // Electron docs: `proxyBypassRules` is a comma-separated list.
    return bypassList.join(',')
  }

  private formatHostPort(server?: chrome.proxy.ProxyServer): string | undefined {
    if (typeof server?.host !== 'string' || !server.host) return undefined
    // A host that could end one rule and start another is not a host.
    if (/[\s;=,/@?#]/.test(server.host)) return undefined

    const isIpv6 = server.host.includes(':') && !server.host.startsWith('[')
    const host = isIpv6 ? `[${server.host}]` : server.host
    const port =
      Number.isInteger(server.port) && server.port! > 0 && server.port! < 65536 ? `:${server.port}` : ''
    return `${host}${port}`
  }

  private formatProxyUri(server?: chrome.proxy.ProxyServer): string | undefined {
    const hostPort = this.formatHostPort(server)
    if (!hostPort) return undefined

    const scheme = server?.scheme || 'http'
    if (!PROXY_SCHEMES.includes(scheme)) return undefined
    return `${scheme}://${hostPort}`
  }

  private emitSettingsChange(): void {
    this.ctx.router.sendEventForEachListener('proxy.settings.onChange', (extensionId) => {
      const levelOfControl: chrome.types.LevelOfControl =
        !this.controllingExtensionId
          ? 'controllable_by_this_extension'
          : this.controllingExtensionId === extensionId
            ? 'controlled_by_this_extension'
            : 'controlled_by_other_extensions'

      return [
        {
          value: this.currentConfig,
          levelOfControl,
          incognitoSpecific: false,
        },
      ]
    })
  }
}