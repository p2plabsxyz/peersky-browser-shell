import { ExtensionContext } from '../context'
import { ArgSpec } from './arg-check'
import { ExtensionSettings, serveChromeSetting } from './chrome-setting'

const PAC_DATA_MIME_TYPE = 'application/x-ns-proxy-autoconfig'
const MODES = ['direct', 'auto_detect', 'pac_script', 'fixed_servers', 'system'] as const
const SCHEMES = ['http', 'https', 'quic', 'socks4', 'socks5'] as const
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, quic: 443, socks4: 1080, socks5: 1080 }
/** In Chrome's order, which decides which pair an error names. */
const SERVER_FIELDS = ['singleProxy', 'proxyForHttp', 'proxyForHttps', 'proxyForFtp', 'fallbackProxy'] as const
const MAX_PAC_BYTES = 2 * 1024 * 1024
const MAX_BYPASS_ENTRIES = 1000

const PROXY_SERVER: ArgSpec = {
  type: 'object',
  ref: 'proxy.ProxyServer',
  optional: true,
  properties: {
    scheme: { type: 'string', enum: SCHEMES, ref: 'proxy.Scheme', optional: true },
    host: { type: 'string' },
    port: { type: 'integer', optional: true },
  },
}

const PROXY_CONFIG: ArgSpec = {
  type: 'object',
  ref: 'proxy.ProxyConfig',
  properties: {
    mode: { type: 'string', enum: MODES, ref: 'proxy.Mode' },
    rules: {
      type: 'object',
      ref: 'proxy.ProxyRules',
      optional: true,
      properties: {
        singleProxy: PROXY_SERVER,
        proxyForHttp: PROXY_SERVER,
        proxyForHttps: PROXY_SERVER,
        proxyForFtp: PROXY_SERVER,
        fallbackProxy: PROXY_SERVER,
        bypassList: { type: 'array', items: { type: 'string' }, optional: true },
      },
    },
    pacScript: {
      type: 'object',
      ref: 'proxy.PacScript',
      optional: true,
      properties: {
        url: { type: 'string', optional: true },
        data: { type: 'string', optional: true },
        mandatory: { type: 'boolean', optional: true },
      },
    },
  },
}

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s)

type Server = { scheme: string; host: string; port: number }

/**
 * Turns an extension's proxy config into the one Chrome keeps and reports
 * back: servers get their scheme and port filled in, and only what the mode
 * uses stays. Throws Chrome's error for a config Chrome refuses.
 */
export function normalizeProxyConfig(config: chrome.proxy.ProxyConfig): chrome.proxy.ProxyConfig {
  const mode = config.mode
  if (mode === 'direct' || mode === 'auto_detect' || mode === 'system') return { mode }

  if (mode === 'pac_script') {
    const pac = config.pacScript
    const url = typeof pac?.url === 'string' && pac.url ? pac.url : undefined
    const data = typeof pac?.data === 'string' && pac.data ? pac.data : undefined
    if (!url && !data) {
      throw new Error(
        "Proxy mode 'pac_script' requires a 'pacScript' field with either a 'url' field or a 'data' field.",
      )
    }
    const mandatory = pac?.mandatory === true
    if (url) {
      if (!isAscii(url)) throw new Error("'pacScript.url' supports only ASCII URLs (encode URLs in Punycode format).")
      if (url.length > MAX_PAC_BYTES) throw new Error('Invalid invocation')
      return { mode, pacScript: { url, mandatory } }
    }
    if (!isAscii(data!)) throw new Error("'pacScript.data' supports only ASCII code(encode URLs in Punycode format).")
    if (data!.length > MAX_PAC_BYTES) throw new Error('Invalid invocation')
    return { mode, pacScript: { data, mandatory } }
  }

  // fixed_servers
  const rules = config.rules
  const present = SERVER_FIELDS.filter((field) => rules?.[field])
  if (!rules || present.length === 0) throw new Error("Proxy mode 'fixed_servers' requires a 'rules' field.")
  if (rules.singleProxy) {
    const other = present.find((field) => field !== 'singleProxy')
    if (other) throw new Error(`Proxy rule for singleProxy and ${other} cannot be set at the same time.`)
  }
  const out: chrome.proxy.ProxyRules = {}
  for (const field of present) out[field] = normalizeServer(rules[field]!)
  if (Array.isArray(rules.bypassList) && rules.bypassList.length > 0) {
    if (rules.bypassList.length > MAX_BYPASS_ENTRIES) throw new Error('Invalid invocation')
    for (const entry of rules.bypassList) {
      if (!isAscii(entry)) {
        throw new Error("'rules.bypassList' supports only ASCII URLs (encode URLs in Punycode format).")
      }
    }
    out.bypassList = rules.bypassList.map((entry) => entry.slice(0, 1024))
  }
  return { mode, rules: out }
}

function normalizeServer(server: chrome.proxy.ProxyServer): Server {
  const host = server.host
  if (!host) throw new Error("Invalid 'rules.???.host' entry. Hostname cannot be empty.")
  if (!isAscii(host)) {
    throw new Error(
      `Invalid 'rules.???.host' entry '${host}'. 'host' field supports only ASCII URLs (encode URLs in Punycode format).`,
    )
  }
  // Chrome drops a server it cannot read and goes direct while the extension
  // thinks it is proxied. Refusing it says so instead, and keeps a host from
  // ending one Electron proxy rule and starting another.
  if (host.length > 255 || /[\s;=,/@?#\\[\]]/.test(host.replace(/^\[|\]$/g, ''))) {
    throw new Error("Invalid 'rules' specified.")
  }
  // QUIC proxies are gone from Chrome; it keeps them as HTTP ones.
  const scheme = !server.scheme || server.scheme === 'quic' ? 'http' : server.scheme
  const defaultPort = DEFAULT_PORTS[server.scheme || 'http']
  const port =
    Number.isInteger(server.port) && server.port! > 0 && server.port! < 65536 ? (server.port as number) : defaultPort
  return { scheme, host: host.replace(/^\[|\]$/g, ''), port }
}

const formatServer = ({ scheme, host, port }: Server) =>
  `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`

/** The Electron config for what Chrome keeps; undefined means the system's. */
export function toElectronProxyConfig(config: chrome.proxy.ProxyConfig | undefined): Electron.ProxyConfig {
  if (!config || config.mode === 'system') return { mode: 'system' }
  if (config.mode === 'direct' || config.mode === 'auto_detect') return { mode: config.mode }
  if (config.mode === 'pac_script') {
    const { url, data } = config.pacScript || {}
    const pacScript = url
      ? url
      : `data:${PAC_DATA_MIME_TYPE};base64,${Buffer.from(data || '', 'utf8').toString('base64')}`
    return { mode: 'pac_script', pacScript }
  }
  const rules = config.rules || {}
  let proxyRules: string
  if (rules.singleProxy) {
    proxyRules = formatServer(rules.singleProxy as Server)
  } else {
    // Each server keeps its own scheme: without one, Chromium took an HTTPS
    // proxy for a plain HTTP one and SOCKS5 for SOCKS4. fallbackProxy goes in
    // the "socks=" slot, which Chromium reads as "for everything else".
    proxyRules = (
      [
        ['http', rules.proxyForHttp],
        ['https', rules.proxyForHttps],
        ['ftp', rules.proxyForFtp],
        ['socks', rules.fallbackProxy],
      ] as const
    )
      .filter(([, server]) => server)
      .map(([slot, server]) => `${slot}=${formatServer(server as Server)}`)
      .join(';')
  }
  const out: Electron.ProxyConfig = { mode: 'fixed_servers', proxyRules }
  // Electron reads proxyBypassRules as a comma-separated list.
  if (rules.bypassList?.length) out.proxyBypassRules = rules.bypassList.join(',')
  return out
}

/**
 * chrome.proxy.settings, a types.ChromeSetting kept per session like
 * chrome.privacy's: the most recently installed extension that set a proxy is
 * the one in control, and its proxy comes back when it loads after a restart.
 */
export class ProxyAPI {
  private settings: ExtensionSettings

  constructor(private ctx: ExtensionContext) {
    this.settings = ExtensionSettings.for(ctx)
    serveChromeSetting(ctx, this.settings, {
      name: 'proxy.settings',
      key: 'proxy',
      permission: 'proxy',
      defaultValue: () => ({ mode: 'system' }),
      valueSpec: PROXY_CONFIG,
      accept: (value: chrome.proxy.ProxyConfig) => normalizeProxyConfig(value),
    })
    this.settings.onChange(async ({ key, value }) => {
      if (key !== 'proxy') return
      await this.ctx.session.setProxy(toElectronProxyConfig(value as chrome.proxy.ProxyConfig | undefined))
    })
  }

  /** The proxy config that counts now, as chrome.proxy.settings.get reports it. */
  getConfig(): chrome.proxy.ProxyConfig {
    const current = this.settings.effective('proxy')
    return current ? JSON.parse(JSON.stringify(current.value)) : { mode: 'system' }
  }
}
