import { ipcRenderer } from 'electron'

const formatIpcName = (name: string) => `crx-${name}`

/** How many listeners each event has in this context. */
const listenerCounts = new Map<string, number>()

/**
 * The ipcRenderer wrapper for each listener, by event name and the listener's
 * id. The id comes from the page's world: a function crossing the context
 * bridge arrives as a new proxy every time, so the function itself cannot be
 * the key, or removeListener would never find the one addListener added.
 */
const wrappers = new Map<string, Map<number, (...args: any[]) => void>>()

export const addExtensionListener = (
  extensionId: string,
  name: string,
  callback: Function,
  listenerId: number,
) => {
  let byId = wrappers.get(name)
  if (!byId) wrappers.set(name, (byId = new Map()))
  if (byId.has(listenerId)) return

  const count = listenerCounts.get(name) || 0
  if (count === 0) {
    ipcRenderer.send('crx-add-listener', extensionId, name)
  }
  listenerCounts.set(name, count + 1)

  const wrapper = (_event: Electron.IpcRendererEvent, ...args: any[]) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(name, '(result)', ...args)
    }
    callback(...args)
  }
  byId.set(listenerId, wrapper)
  ipcRenderer.addListener(formatIpcName(name), wrapper)
}

export const removeExtensionListener = (extensionId: string, name: string, listenerId: number) => {
  const byId = wrappers.get(name)
  const wrapper = byId?.get(listenerId)
  if (!byId || !wrapper) return

  ipcRenderer.removeListener(formatIpcName(name), wrapper)
  byId.delete(listenerId)

  const count = listenerCounts.get(name) || 0
  if (count <= 1) {
    listenerCounts.delete(name)
    ipcRenderer.send('crx-remove-listener', extensionId, name)
  } else {
    listenerCounts.set(name, count - 1)
  }
}
