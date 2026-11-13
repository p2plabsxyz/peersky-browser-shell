/* global chrome, probe, importScripts */
importScripts('probe-lib.js', 'suites.js')

// Startup events are recorded before any suite runs, since they only fire once.
self.startupEvents = []
chrome.runtime.onInstalled.addListener((details) => {
  self.startupEvents.push({ name: 'onInstalled', reason: details.reason })
})
chrome.runtime.onStartup.addListener(() => {
  self.startupEvents.push({ name: 'onStartup' })
})

// The shell's test runner asks through an extension page, since it cannot
// evaluate code in a service worker the way Chrome's DevTools protocol can.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message && message.probe === 'run') {
    self.runSuite(message.suite, message.env).then(reply)
    return true
  }
  if (message && message.probe === 'suites') {
    reply(self.suiteNames())
    return false
  }
  return false
})

// The peer extension talks to this one.
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message && message.ping) {
    reply({ pong: true, from: sender.id, hasTab: !!sender.tab, hasUrl: typeof sender.url })
  }
  return false
})
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener((message) => {
    port.postMessage({ echo: message, name: port.name, from: port.sender && port.sender.id })
  })
})
