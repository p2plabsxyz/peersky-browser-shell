/* global chrome */
// Answers the host's address bar the way an omnibox extension does. What it
// was told comes back through setDefaultSuggestion, which the host sees.
const told = (what) => chrome.omnibox.setDefaultSuggestion({ description: what })

chrome.omnibox.onInputStarted.addListener(() => told('started'))
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  if (text === 'bad') {
    try {
      suggest([{ description: 'no content' }])
    } catch (e) {
      told('threw ' + e.message.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    }
    return
  }
  suggest([
    { content: text + ' one', description: 'First <match>' + text + '</match>' },
    { content: text + ' two', description: '<dim>Second</dim>', deletable: true },
  ])
})
chrome.omnibox.onInputEntered.addListener((text, disposition) => told(`entered ${text} ${disposition}`))
chrome.omnibox.onInputCancelled.addListener(() => told('cancelled'))
chrome.omnibox.onDeleteSuggestion.addListener((text) => told('deleted ' + text))
