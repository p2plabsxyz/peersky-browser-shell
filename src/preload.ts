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

// Only load within extension page context. Service workers run only for
// extensions the library loaded, and have no `location` to check.
if (process.type === 'service-worker') {
  inject()
} else if (
  typeof location !== 'undefined' &&
  location.href.startsWith('chrome-extension://') &&
  !isComponentExtension(location.href)
) {
  inject()
}
