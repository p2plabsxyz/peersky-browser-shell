/* global chrome */
// Shared by both probe extensions, in every context they run in (service
// worker, extension pages and content scripts). It records what each chrome.*
// call does as plain JSON, so a run in Chrome and a run in the shell can be
// compared line by line. Nothing here may depend on ids, times or paths that
// differ between two runs: tests record types, key lists and outcomes instead.
;(function (global) {
  const TIMEOUT_MS = 5000

  // Every member of an API namespace, as 'tabs.query': 'function',
  // 'tabs.onCreated': 'event', 'tabs.TAB_ID_NONE': 'number:-1'.
  function apiSurface(root, maxDepth) {
    const out = {}
    const seen = new Set()
    const depthLimit = typeof maxDepth === 'number' ? maxDepth : 4
    const walk = (obj, prefix, depth) => {
      if (!obj || seen.has(obj)) return
      seen.add(obj)
      const keys = new Set()
      for (let o = obj; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) keys.add(k)
      }
      for (const k of [...keys].sort()) {
        if (k === 'constructor' || k.startsWith('_')) continue
        const path = prefix + k
        let v
        try {
          v = obj[k]
        } catch (e) {
          out[path] = 'throws'
          continue
        }
        if (typeof v === 'function') out[path] = 'function'
        else if (v && typeof v === 'object' && typeof v.addListener === 'function') out[path] = 'event'
        else if (v && typeof v === 'object') {
          const before = Object.keys(out).length
          if (depth < depthLimit) walk(v, path + '.', depth + 1)
          if (Object.keys(out).length === before) out[path] = 'object'
        } else if (k === 'dynamicId') {
          // A new UUID every time the extension loads: only its type compares.
          out[path] = typeof v
        } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[path] = typeof v + ':' + v
        } else {
          out[path] = typeof v
        }
      }
    }
    walk(root, '', 0)
    return out
  }

  function withTimeout(promise, ms, label) {
    let timer
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timeout: ' + label)), ms || TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // The type of every key, sorted: { id: 'number', url: 'string' }.
  function shape(value) {
    if (Array.isArray(value)) return value.length ? ['array', shape(value[0])] : ['array']
    if (value === null) return 'null'
    if (typeof value !== 'object') return typeof value
    const out = {}
    for (const k of Object.keys(value).sort()) {
      const v = value[k]
      out[k] = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v
    }
    return out
  }

  function errorMessage(e) {
    if (!e) return String(e)
    return typeof e.message === 'string' ? e.message : String(e)
  }

  // A test records observations under keys. call() records { ok } or { error }.
  function createRecorder() {
    const results = {}
    const t = {
      results,
      set(key, value) {
        results[key] = value === undefined ? '<undefined>' : value
      },
      async call(key, fn, map) {
        try {
          const value = await withTimeout(Promise.resolve().then(fn), TIMEOUT_MS, key)
          results[key] = { ok: map ? map(value) : value === undefined ? '<undefined>' : value }
          return value
        } catch (e) {
          results[key] = { error: errorMessage(e) }
          return undefined
        }
      },
      // Waits for the first event that passes `filter` after `trigger` runs.
      async event(key, event, trigger, opts) {
        const options = opts || {}
        const wait = new Promise((resolve) => {
          const listener = (...args) => {
            if (options.filter && !options.filter(...args)) return
            event.removeListener(listener)
            resolve(args)
          }
          event.addListener(listener)
          setTimeout(() => {
            event.removeListener(listener)
            resolve(null)
          }, options.timeout || TIMEOUT_MS)
        })
        let triggerError
        try {
          if (trigger) await withTimeout(Promise.resolve().then(trigger), TIMEOUT_MS, key)
        } catch (e) {
          triggerError = errorMessage(e)
        }
        const args = await wait
        if (triggerError) results[key] = { triggerError }
        else if (!args) results[key] = { event: 'none' }
        else results[key] = { event: options.map ? options.map(...args) : args.length }
        return args
      },
      // Calls a callback-style API and records chrome.runtime.lastError.
      callback(key, fn) {
        return withTimeout(
          new Promise((resolve) => {
            try {
              fn((...args) => {
                const lastError = chrome.runtime.lastError
                results[key] = lastError
                  ? { lastError: lastError.message }
                  : { ok: args.length ? shape(args[0]) : '<no args>' }
                resolve(args[0])
              })
            } catch (e) {
              results[key] = { threw: errorMessage(e) }
              resolve(undefined)
            }
          }),
          TIMEOUT_MS,
          key,
        ).catch((e) => {
          results[key] = { error: errorMessage(e) }
        })
      },
    }
    return t
  }

  global.probe = { apiSurface, createRecorder, shape, sleep, withTimeout, errorMessage }
})(globalThis)
