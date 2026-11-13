import { EventEmitter } from 'node:events'

/**
 * A fake ExtensionContext for the settings APIs (privacy, proxy,
 * fontSettings, contentSettings, browsingData): handlers are kept by name,
 * events and session calls are recorded, and the state store is a plain
 * object that a second context can share, as a restart would.
 */
export function settingsHarness(state: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function>()
  const events: Array<{ extensionId: string; name: string; args: any[] }> = []
  const emitted: Array<{ name: string; payload: any }> = []
  const proxyCalls: any[] = []
  const clearDataCalls: any[] = []
  const clearStorageCalls: any[] = []
  const removedCookies: Array<{ url: string; name: string }> = []
  let cookieJar: Electron.Cookie[] = []

  const loaded = new Map<string, any>()
  const sessionExtensions: any = new EventEmitter()
  sessionExtensions.getAllExtensions = () => [...loaded.values()]
  sessionExtensions.getExtension = (id: string) => loaded.get(id) ?? null

  const cookies: any = new EventEmitter()
  cookies.get = async () => cookieJar
  cookies.remove = async (url: string, name: string) => {
    removedCookies.push({ url, name })
    cookieJar = cookieJar.filter((c) => c.name !== name)
  }

  const store: any = new EventEmitter()
  store.impl = {}
  store.tabs = new Set()

  const ctx: any = {
    router: {
      apiHandler: () => (name: string, fn: Function) => handlers.set(name, fn),
      sendEvent: (extensionId: string, name: string, ...args: any[]) => events.push({ extensionId, name, args }),
    },
    session: {
      extensions: sessionExtensions,
      cookies,
      setProxy: async (config: any) => {
        proxyCalls.push(config)
      },
      clearData: async (options: any) => {
        clearDataCalls.push(options)
      },
      clearCache: async () => {
        clearDataCalls.push('clearCache')
      },
      clearStorageData: async (options: any) => {
        clearStorageCalls.push(options)
      },
    },
    store,
    stateStore: {
      whenHydrated: async () => {},
      getNamespace: (name: string, fallback: any) => (name in state ? JSON.parse(JSON.stringify(state[name])) : fallback),
      setNamespace: (name: string, value: unknown) => {
        state[name] = JSON.parse(JSON.stringify(value))
      },
      flush: async () => {},
    },
    permissions: {
      has: (extension: any, permission: string) => {
        const ext = typeof extension === 'string' ? loaded.get(extension) : extension
        return !!ext?.manifest?.permissions?.includes(permission)
      },
    },
    emit: (name: string, payload: any) => emitted.push({ name, payload }),
  }

  const extension = (id: string, permissions: string[]) => ({
    id,
    name: id,
    url: `chrome-extension://${id}/`,
    manifest: { manifest_version: 3, permissions },
  })

  /** Loads an extension, as the session would, and waits for settings to see it. */
  const load = async (ext: any) => {
    loaded.set(ext.id, ext)
    sessionExtensions.emit('extension-loaded', {}, ext)
    await tick()
  }
  const unload = async (ext: any) => {
    loaded.delete(ext.id)
    sessionExtensions.emit('extension-unloaded', {}, ext)
    await tick()
  }

  /** Calls a handler as `ext` would. */
  const call = (name: string, ext: any, ...args: any[]) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`no handler ${name}`)
    return Promise.resolve().then(() => handler({ extension: ext, type: 'service-worker' }, ...args))
  }

  /** The error message a call fails with, or undefined. */
  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return undefined
    } catch (e) {
      return (e as Error).message
    }
  }

  return {
    ctx,
    state,
    handlers,
    events,
    emitted,
    proxyCalls,
    clearDataCalls,
    clearStorageCalls,
    removedCookies,
    setCookies: (list: Partial<Electron.Cookie>[]) => {
      cookieJar = list as Electron.Cookie[]
    },
    extension,
    load,
    unload,
    call,
    errorOf,
  }
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

export const last = <T>(list: T[]): T => list[list.length - 1]
