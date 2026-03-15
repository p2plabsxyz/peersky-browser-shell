/* global chrome */

const sendIpc = ({ tabId, name }) => {
  chrome.tabs.sendMessage(tabId, { type: 'send-ipc', args: [name] })
}

const transformArgs = (args, sender) => {
  const tabId = sender.tab.id

  const transformArg = (arg) => {
    if (arg && typeof arg === 'object') {
      if ('__IPC_FN__' in arg) {
        return () => {
          sendIpc({ tabId, name: arg.__IPC_FN__ })
        }
      } else {
        for (const key of Object.keys(arg)) {
          if (arg.hasOwnProperty(key)) {
            arg[key] = transformArg(arg[key])
          }
        }
      }
    }
    return arg
  }

  return args.map(transformArg)
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message.type) {
    case 'api': {
      const { method, args } = message
      const parts = method.split('.')
      
      let target = chrome
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]]
      }
      const fnName = parts[parts.length - 1]

      if (target && typeof target[fnName] === 'function') {
        const transformedArgs = transformArgs(args, sender)
        target[fnName](...transformedArgs, reply)
      } else {
        reply({ error: `Function ${method} not found` })
      }

      break
    }

    case 'event-once': {
      const { name } = message
      const parts = name.split('.')
      
      let target = chrome
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]]
      }
      const eventName = parts[parts.length - 1]

      if (target && target[eventName]) {
        const event = target[eventName]
        event.addListener(function callback(...args) {
          if (chrome.runtime.lastError) {
            reply(chrome.runtime.lastError)
          } else {
            reply(args)
          }
          event.removeListener(callback)
        })
      } else {
        reply({ error: `Event ${name} not found` })
      }
    }
  }

  // Respond asynchronously
  return true
})

console.log('background-script-evaluated')
