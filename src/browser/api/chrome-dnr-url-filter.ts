/**
 * Chrome {@link https://developer.chrome.com/docs/extensions/reference/declarativeNetRequest#property-RuleCondition-urlFilter declarativeNetRequest urlFilter}
 * pattern matching (not ABP / uBlock — `^` separator semantics differ).
 */

/** `^` matches any single char except ASCII alnum and `_-`.%`, or end of string (Chrome). */
export function isChromeUrlFilterSeparatorChar(c: string): boolean {
  if (!c) return true
  const code = c.charCodeAt(0)
  if (code >= 48 && code <= 57) return false
  if (code >= 65 && code <= 90) return false
  if (code >= 97 && code <= 122) return false
  if (c === '_' || c === '-' || c === '.' || c === '%') return false
  return true
}

function hostMatchesDomainAnchor(requestUrl: string, domain: string): boolean {
  try {
    const host = new URL(requestUrl).hostname.toLowerCase()
    const d = domain.toLowerCase()
    return host === d || host.endsWith(`.${d}`)
  } catch {
    return false
  }
}

/** Text after `URL.origin` (path + search + hash), for matching the post-`||` part. */
function pathQueryHashAfterOrigin(requestUrl: string): string {
  try {
    const u = new URL(requestUrl)
    const o = u.origin
    if (requestUrl.startsWith(o)) return requestUrl.slice(o.length)
    return u.pathname + u.search + u.hash
  } catch {
    return requestUrl
  }
}

/**
 * Host key after `||` for indexing (ASCII hostname segment only).
 * Returns null if not a `||`-anchored filter or empty host.
 */
export function chromeUrlFilterHostKeyForIndex(urlFilter: string): string | null {
  if (!urlFilter.startsWith('||')) return null
  let i = 2
  let host = ''
  while (i < urlFilter.length) {
    const c = urlFilter[i]
    if (
      (c >= 'a' && c <= 'z') ||
      (c >= 'A' && c <= 'Z') ||
      (c >= '0' && c <= '9') ||
      c === '.' ||
      c === '-'
    ) {
      host += c.toLowerCase()
      i++
      continue
    }
    break
  }
  return host.length > 0 ? host : null
}

function extractDomainAfterDoublePipe(urlFilter: string): string | null {
  const key = chromeUrlFilterHostKeyForIndex(urlFilter)
  return key
}

/**
 * Match `pattern` against `text` from the start; optionally require consuming all of `text`.
 */
function matchTail(
  pattern: string,
  text: string,
  mustConsumeAllText: boolean,
): boolean {
  const rec = (pi: number, ti: number): boolean => {
    if (pi === pattern.length) {
      return !mustConsumeAllText || ti === text.length
    }

    const pc = pattern[pi]

    if (pc === '*') {
      for (let skip = 0; ti + skip <= text.length; skip++) {
        if (rec(pi + 1, ti + skip)) return true
      }
      return false
    }

    if (pc === '^') {
      if (ti === text.length) return rec(pi + 1, ti)
      // `^/` at a path boundary: `^` is the separator token and `/` is the literal path
      // slash (Chrome `||example.com/foo` style rules use `^` then `/`).
      if (
        pi + 1 < pattern.length &&
        pattern[pi + 1] === '/' &&
        text[ti] === '/'
      ) {
        return rec(pi + 2, ti + 1)
      }
      if (isChromeUrlFilterSeparatorChar(text[ti])) return rec(pi + 1, ti + 1)
      return false
    }

    if (ti === text.length) return false
    if (pc === text[ti]) return rec(pi + 1, ti + 1)
    return false
  }

  return rec(0, 0)
}

function matchUnanchored(pattern: string, url: string, mustEnd: boolean): boolean {
  for (let i = 0; i <= url.length; i++) {
    if (matchTail(pattern, url.slice(i), mustEnd)) return true
  }
  return false
}

/**
 * Returns true if `requestUrl` matches Chrome MV3 `urlFilter` (and optional case flag).
 */
export function matchDeclarativeNetRequestUrlFilter(
  urlFilter: string,
  requestUrl: string,
  isUrlFilterCaseSensitive?: boolean,
): boolean {
  if (!urlFilter) return false

  const cs = !!isUrlFilterCaseSensitive
  const urlNorm = cs ? requestUrl : requestUrl.toLowerCase()
  let pat = cs ? urlFilter : urlFilter.toLowerCase()

  let mustEnd = false
  if (pat.endsWith('|') && !pat.endsWith('||')) {
    mustEnd = true
    pat = pat.slice(0, -1)
  }

  if (pat.startsWith('||')) {
    const domain = extractDomainAfterDoublePipe(urlFilter)
    if (!domain) return false
    if (!hostMatchesDomainAnchor(requestUrl, domain)) return false
    const domainLen = domain.length
    const rest = pat.slice(2 + domainLen)
    const tail = pathQueryHashAfterOrigin(requestUrl)
    const tailNorm = cs ? tail : tail.toLowerCase()
    return matchTail(rest, tailNorm, mustEnd)
  }

  if (pat.startsWith('|')) {
    const rest = pat.slice(1)
    return matchTail(rest, urlNorm, mustEnd)
  }

  return matchUnanchored(pat, urlNorm, mustEnd)
}
