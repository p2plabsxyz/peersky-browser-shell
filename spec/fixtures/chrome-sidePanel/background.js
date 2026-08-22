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
          if (Object.prototype.hasOwnProperty.call(arg, key)) {
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
      const [apiName, subMethod] = method.split('.')
      const fn = chrome[apiName] && chrome[apiName][subMethod]

      if (typeof fn !== 'function') {
        reply({ __error: `Function ${method} not found` })
        break
      }

      const transformedArgs = transformArgs(args, sender)
      ;(async () => {
        try {
          const result = await fn.apply(chrome[apiName], transformedArgs)
          reply(result === undefined ? null : result)
        } catch (err) {
          reply({
            __error: String(err && err.message ? err.message : err),
          })
        }
      })()
      break
    }

    case 'event-once': {
      const { name } = message
      const [apiName, eventName] = name.split('.')
      if (typeof chrome[apiName]?.[eventName] === 'object') {
        const event = chrome[apiName][eventName]
        event.addListener(function callback(...eventArgs) {
          reply(eventArgs)
          event.removeListener(callback)
        })
      }
      break
    }
  }

  return true
})

console.log('background-script-evaluated')
