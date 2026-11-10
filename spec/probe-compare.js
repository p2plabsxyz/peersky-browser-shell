// Shared by the parity spec and script/chrome-parity.mjs: turns a probe run
// into JSON that does not change between runs, and lists where two runs differ.

/** Replaces the test server's address, whose port changes every run. */
function normalizeResults(value, env) {
  const text = JSON.stringify(value)
    .split(env.base)
    .join('<base>/')
    .split(env.other)
    .join('<other>/')
    .split(env.base.replace(/\/$/, ''))
    .join('<base>')
    .split(env.other.replace(/\/$/, ''))
    .join('<other>')
    // Real tab, window and download ids in error messages. The ids the probe
    // invents for missing things (987654, 987655) stay.
    .replace(/\b(id:? )(?!98765[45]\b)\d+/g, '$1<n>')
  return JSON.parse(text)
}

/** Flattens nested objects to { 'a.b.0': value }. */
function flatten(value, prefix, out) {
  out = out || {}
  prefix = prefix || ''
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) out[prefix] = Array.isArray(value) ? '[]' : '{}'
    for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, out)
  } else {
    out[prefix] = value
  }
  return out
}

/**
 * Lists every path whose value differs, as { path, chrome, shell }. A known
 * difference names a path, or a path ending in '*' for everything under it,
 * and the reason the shell is allowed to differ there.
 */
function diffResults(chrome, shell, known) {
  const a = flatten(chrome)
  const b = flatten(shell)
  const allowed = (path) =>
    (known || []).some((k) => (k.path.endsWith('*') ? path.startsWith(k.path.slice(0, -1)) : path === k.path))
  const out = []
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[path] === b[path] || allowed(path)) continue
    out.push({ path, chrome: path in a ? a[path] : '<missing>', shell: path in b ? b[path] : '<missing>' })
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : 1))
}

module.exports = { normalizeResults, flatten, diffResults }
