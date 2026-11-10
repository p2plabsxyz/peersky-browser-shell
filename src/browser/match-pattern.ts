/**
 * Chrome's match patterns, as used for host permissions, content scripts,
 * tabs.query({ url }), webRequest filters and context menu patterns.
 *
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 *
 * A pattern is `<scheme>://<host><path>` or `<all_urls>`. The host part may be
 * `*`, `*.example.com` (example.com and every subdomain) or an exact host, and
 * may carry a port; without a port any port matches. The path is a glob over
 * the path and query.
 */

export interface ParsedMatchPattern {
  allUrls: boolean
  /** A scheme, or '*' for http and https. */
  scheme: string
  /** '' for file: URLs. */
  host: string
  matchSubdomains: boolean
  /** undefined: any port. */
  port?: string
  path: RegExp
  source: string
}

const SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'file', 'ftp', 'urn', 'chrome-extension'])
const WILDCARD_SCHEMES = new Set(['http', 'https', 'ws', 'wss'])

const escapeRegExp = (s: string) => s.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`, 's')

/** Parses a pattern, or throws with Chrome's wording for what is wrong with it. */
export function parseMatchPattern(pattern: string): ParsedMatchPattern {
  if (typeof pattern !== 'string') throw new Error('Invalid match pattern.')
  if (pattern === '<all_urls>') {
    return { allUrls: true, scheme: '*', host: '*', matchSubdomains: true, path: /.*/s, source: pattern }
  }
  const separator = pattern.indexOf('://')
  if (separator < 0) {
    // urn: and data: style patterns have no '//'.
    if (/^urn:/.test(pattern)) {
      return { allUrls: false, scheme: 'urn', host: '', matchSubdomains: false, path: globToRegExp(pattern.slice(4)), source: pattern }
    }
    throw new Error('Missing scheme separator.')
  }
  const scheme = pattern.slice(0, separator).toLowerCase()
  if (scheme !== '*' && !SCHEMES.has(scheme)) throw new Error('Invalid scheme.')
  const rest = pattern.slice(separator + 3)
  const slash = rest.indexOf('/')
  if (scheme === 'file') {
    if (slash < 0) throw new Error('Missing path.')
    return { allUrls: false, scheme, host: '', matchSubdomains: false, path: globToRegExp(rest.slice(slash)), source: pattern }
  }
  if (slash < 0) throw new Error('Missing path.')
  let hostPort = rest.slice(0, slash)
  const path = rest.slice(slash)
  if (!hostPort) throw new Error('Empty host.')
  let port: string | undefined
  // IPv6 literals keep their colons inside brackets.
  const portMatch = /^(\[[^\]]+\]|[^:]+):(\d+|\*)$/.exec(hostPort)
  if (portMatch) {
    hostPort = portMatch[1]
    port = portMatch[2] === '*' ? undefined : portMatch[2]
  } else if (!hostPort.startsWith('[') && hostPort.includes(':')) {
    throw new Error('Invalid port.')
  }
  let host = hostPort.toLowerCase()
  let matchSubdomains = false
  if (host === '*') {
    matchSubdomains = true
  } else if (host.startsWith('*.')) {
    matchSubdomains = true
    host = host.slice(2)
  }
  if (host !== '*' && host.includes('*')) throw new Error('Invalid host wildcard.')
  return { allUrls: false, scheme, host, matchSubdomains, port, path: globToRegExp(path), source: pattern }
}

/** Parses, returning undefined for an invalid pattern. */
export function tryParseMatchPattern(pattern: string): ParsedMatchPattern | undefined {
  try {
    return parseMatchPattern(pattern)
  } catch {
    return undefined
  }
}

const defaultPort = (scheme: string) =>
  scheme === 'http' || scheme === 'ws' ? '80' : scheme === 'https' || scheme === 'wss' ? '443' : ''

/** Whether `url` matches the parsed pattern. */
export function urlMatches(parsed: ParsedMatchPattern, url: string | URL): boolean {
  let u: URL
  try {
    u = typeof url === 'string' ? new URL(url) : url
  } catch {
    return false
  }
  const scheme = u.protocol.replace(/:$/, '')
  if (parsed.allUrls) {
    return SCHEMES.has(scheme) && scheme !== 'chrome-extension'
  }
  if (parsed.scheme === '*') {
    if (!WILDCARD_SCHEMES.has(scheme)) return false
  } else if (parsed.scheme !== scheme) {
    return false
  }
  if (scheme === 'urn') return parsed.path.test(u.pathname)
  if (scheme === 'file') return parsed.path.test(u.pathname)
  const host = u.hostname.toLowerCase()
  if (parsed.host !== '*' || !parsed.matchSubdomains) {
    const wanted = parsed.host
    const ok = host === wanted || (parsed.matchSubdomains && (wanted === '' || host.endsWith('.' + wanted)))
    if (!ok) return false
  }
  if (parsed.port !== undefined) {
    const port = u.port || defaultPort(scheme)
    if (port !== parsed.port) return false
  }
  return parsed.path.test(u.pathname + u.search)
}

/** Whether `url` matches the pattern string. An invalid pattern matches nothing. */
export function matchesPattern(pattern: string, url: string | URL): boolean {
  const parsed = tryParseMatchPattern(pattern)
  return !!parsed && urlMatches(parsed, url)
}

/** Whether `url` matches any of the patterns. */
export function matchesAnyPattern(patterns: readonly string[] | undefined, url: string | URL): boolean {
  return !!patterns && patterns.some((p) => matchesPattern(p, url))
}

/** Whether every URL `inner` matches is also matched by `outer`. */
export function patternCovers(outer: string, inner: string): boolean {
  const a = tryParseMatchPattern(outer)
  const b = tryParseMatchPattern(inner)
  if (!a || !b) return false
  if (a.allUrls) return true
  if (b.allUrls) return false
  if (a.scheme !== '*' && a.scheme !== b.scheme) return false
  if (a.scheme === '*' && b.scheme !== '*' && !WILDCARD_SCHEMES.has(b.scheme)) return false
  if (a.host !== '*' || !a.matchSubdomains) {
    if (b.host === '*' && b.matchSubdomains) return false
    const hostOk = a.host === b.host || (a.matchSubdomains && b.host.endsWith('.' + a.host))
    if (!hostOk) return false
    if (b.matchSubdomains && !a.matchSubdomains) return false
  }
  if (a.port !== undefined && a.port !== b.port) return false
  const aPath = a.source.slice(a.source.indexOf('/', a.source.indexOf('://') + 3))
  const bPath = b.source.slice(b.source.indexOf('/', b.source.indexOf('://') + 3))
  return aPath === '/*' || aPath === bPath || globToRegExp(aPath).test(bPath)
}

/** Glob match for titles in tabs.query({ title }). */
export function matchesGlob(glob: string, text: string): boolean {
  return globToRegExp(glob).test(text)
}
