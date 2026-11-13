/* global chrome, probe */
// An extension page. The shell's runner evaluates in it, since it cannot reach
// the worker directly: runInWorker() relays a suite run to the service worker.
window.runInWorker = (suite, env) => chrome.runtime.sendMessage({ probe: 'run', suite, env })
window.suiteNames = () => chrome.runtime.sendMessage({ probe: 'suites' })
window.pageSurface = () => probe.apiSurface(chrome)
