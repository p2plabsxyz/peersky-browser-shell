/**
 * Chromium serves its own component extensions, the PDF viewer among them, from
 * chrome-extension:// like any other extension, but they run against the real
 * browser APIs in a renderer the IPC-backed shims must never touch: merely
 * reading `ipcRenderer` off the electron module, or calling
 * `contextBridge.executeInMainWorld`, from a preload in the viewer's frames
 * leaves the PDF tab permanently blank (measured on Electron 43; a no-op
 * executeInMainWorld is enough).
 *
 * Two consequences shape this file:
 * - The check has to be local and synchronous. Asking the main process which
 *   extensions it loaded would be more general, but ipcRenderer.sendSync in the
 *   viewer's own frame blanks the tab just as reliably as injecting does.
 * - The shim module is required lazily, inside the branch, so component
 *   extension frames evaluate none of it — not even its `require('electron')`.
 */
const CHROMIUM_COMPONENT_EXTENSIONS = ['mhjfbmdgcfjbbpaeojofohoefgiehjai']

const isComponentExtension = (href: string) =>
  CHROMIUM_COMPONENT_EXTENSIONS.some((id) => href.startsWith(`chrome-extension://${id}/`))

const inject = () => {
  // Lazy: esbuild wraps './renderer' in a deferred init, so its module body
  // (including the electron require) only ever runs past the guards below.
  const { injectExtensionAPIs } = require('./renderer') as typeof import('./renderer')
  injectExtensionAPIs()
}

// Only load within extension page context. The session gives this preload to
// every service worker, websites' too: only an extension's own worker gets the
// APIs. A website's worker would wait forever on the context call the APIs
// start with, and never run.
// A worker's preload runs in a realm of its own, without the worker's
// location, so the address is read from the worker itself.
const workerHref = () => {
  try {
    const { contextBridge } = require('electron') as typeof import('electron')
    const href = (contextBridge as any).executeInMainWorld({
      func: () => String((globalThis as any).location?.href ?? ''),
    })
    return typeof href === 'string' ? href : ''
  } catch {
    return ''
  }
}

if (process.type === 'service-worker') {
  const href = workerHref()
  if (href.startsWith('chrome-extension://') && !isComponentExtension(href)) inject()
} else if (
  typeof location !== 'undefined' &&
  location.href.startsWith('chrome-extension://') &&
  !isComponentExtension(location.href)
) {
  inject()
}
