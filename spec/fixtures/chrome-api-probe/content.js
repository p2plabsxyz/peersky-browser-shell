/* global chrome, probe */
// Records what a content script can reach, for the contentScript suite, and
// answers tabs.sendMessage and tabs.connect from the probe's worker.
;(async () => {
  const out = { surface: probe.apiSurface(chrome) }
  // A new id every time the page loads: only its type can be compared.
  if (typeof out.surface['runtime.dynamicId'] === 'string') {
    out.surface['runtime.dynamicId'] = out.surface['runtime.dynamicId'].split(':')[0]
  }
  try {
    out.sendMessage = await probe.withTimeout(chrome.runtime.sendMessage({ probe: 'suites' }), 3000, 'sendMessage').then((names) => Array.isArray(names))
  } catch (e) {
    out.sendMessage = { error: probe.errorMessage(e) }
  }
  try {
    await chrome.storage.local.set({ fromContent: 1 })
    out.storage = await chrome.storage.local.get('fromContent')
    await chrome.storage.local.remove('fromContent')
  } catch (e) {
    out.storage = { error: probe.errorMessage(e) }
  }
  try {
    await chrome.storage.session.get(null)
    out.sessionStorage = 'allowed'
  } catch (e) {
    out.sessionStorage = { error: probe.errorMessage(e) }
  }
  out.i18n = chrome.i18n.getMessage('extName')
  out.getURL = chrome.runtime.getURL('icon.png') === `chrome-extension://${chrome.runtime.id}/icon.png`
  const host = document.getElementById('closed-host')
  try {
    out.openOrClosedShadowRoot = host && chrome.dom && chrome.dom.openOrClosedShadowRoot(host) ? 'found' : 'none'
  } catch (e) {
    out.openOrClosedShadowRoot = { error: probe.errorMessage(e) }
  }
  out.mainWorldMarker = typeof window.mainWorldMarker
  document.documentElement.dataset.probe = JSON.stringify(out)
})()

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message && message.ping === 'tab') {
    reply({ pong: true, path: location.pathname, fromExtension: sender.id === chrome.runtime.id, hasTab: !!sender.tab })
  }
  return false
})
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message) => port.postMessage({ echo: message, name: port.name }))
})
