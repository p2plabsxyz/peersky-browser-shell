import { ipcRenderer } from 'electron'

const formatIpcName = (name: string) => `crx-${name}`

const listenerMap = new Map<string, number>()

/**
 * Maps the original user callback to the anonymous IPC wrapper registered with
 * ipcRenderer so that removeExtensionListener can find and remove the right
 * function reference, scoped per-event name.
 */
const callbackWrapperMap = new Map<string, WeakMap<object, (...args: any[]) => void>>()

const getCallbackMapForName = (name: string) => {
  let map = callbackWrapperMap.get(name)
  if (!map) {
    map = new WeakMap<object, (...args: any[]) => void>()
    callbackWrapperMap.set(name, map)
  }
  return map
}

export const addExtensionListener = (extensionId: string, name: string, callback: Function) => {
  const callbackMap = getCallbackMapForName(name)
  if (callbackMap.has(callback as object)) return

  const listenerCount = listenerMap.get(name) || 0

  if (listenerCount === 0) {
    // TODO: should these IPCs be batched in a microtask?
    ipcRenderer.send('crx-add-listener', extensionId, name)
  }

  listenerMap.set(name, listenerCount + 1)

  const wrapper = (_event: Electron.IpcRendererEvent, ...args: any[]) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(name, '(result)', ...args)
    }
    callback(...args)
  }
  callbackMap.set(callback as object, wrapper)
  ipcRenderer.addListener(formatIpcName(name), wrapper)
}

export const removeExtensionListener = (extensionId: string, name: string, callback: any) => {
  if (listenerMap.has(name)) {
    const listenerCount = listenerMap.get(name) || 0

    if (listenerCount <= 1) {
      listenerMap.delete(name)

      ipcRenderer.send('crx-remove-listener', extensionId, name)
    } else {
      listenerMap.set(name, listenerCount - 1)
    }
  }

  // Use the stored wrapper so we remove the right function reference from ipcRenderer.
  const callbackMap = callbackWrapperMap.get(name)
  const wrapper = callbackMap && callbackMap.get(callback)
  if (wrapper) {
    ipcRenderer.removeListener(formatIpcName(name), wrapper)
    callbackMap!.delete(callback)
  } else {
    ipcRenderer.removeListener(formatIpcName(name), callback)
  }
}
