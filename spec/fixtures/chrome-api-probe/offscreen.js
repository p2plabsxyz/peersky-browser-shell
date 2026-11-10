/* global chrome, probe */
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message && message.offscreen === 'ping') {
    const surface = probe.apiSurface(chrome)
    reply({ pong: true, namespaces: [...new Set(Object.keys(surface).map((k) => k.split('.')[0]))].sort() })
  }
  return false
})
