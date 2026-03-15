/* eslint-disable */

function evalInMainWorld(fn) {
  const script = document.createElement('script')
  script.textContent = `((${fn})())`
  document.documentElement.appendChild(script)
}

function sendIpc(name, ...args) {
  const jsonArgs = [name, ...args].map((arg) => JSON.stringify(arg))
  const funcStr = `() => { electronTest.sendIpc(${jsonArgs.join(', ')}) }`
  evalInMainWorld(funcStr)
}

async function exec(action) {
  const send = async () => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(action, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message)
        } else {
          resolve(result)
        }
      })
    })
  }

  let result
  for (let i = 0; i < 3; i++) {
    try {
      result = await send()
      break
    } catch (e) {
      console.error(e)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  sendIpc('success', result)
}

window.addEventListener('message', (event) => {
  exec(event.data)
})

evalInMainWorld(() => {
  window.exec = (json) => window.postMessage(JSON.parse(json))
})

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'send-ipc': {
      const [name] = message.args
      sendIpc(name)
      break
    }
  }
})
