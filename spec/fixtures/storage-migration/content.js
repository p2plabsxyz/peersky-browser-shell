/* global chrome */
// What a content script sees in chrome.storage.local, and a value it writes
// for the extension's own pages to read.
chrome.storage.local.get(null).then(async (all) => {
  await chrome.storage.local.set({ fromContent: 'written by the content script' })
  document.documentElement.dataset.storage = JSON.stringify(all)
})
