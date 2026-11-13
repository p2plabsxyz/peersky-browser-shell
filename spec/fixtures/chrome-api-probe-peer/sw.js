/* global chrome, probe, importScripts */
importScripts('probe-lib.js', 'suites.js')

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

chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (message && message.ping) reply({ pong: 'peer', from: sender.id, hasTab: !!sender.tab })
  return false
})
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener((message) => port.postMessage({ echo: message, name: port.name, from: port.sender && port.sender.id }))
})
