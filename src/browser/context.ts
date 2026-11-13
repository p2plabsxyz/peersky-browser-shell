import { EventEmitter } from 'node:events'
import { ExtensionRouter } from './router'
import { ExtensionStore } from './store'
import { ExtensionStateStore } from './state-store'
import { ExtensionPermissions } from './permissions'

/** Shared context for extensions in a session. */
export interface ExtensionContext {
  emit: (typeof EventEmitter)['prototype']['emit']
  router: ExtensionRouter
  session: Electron.Session
  store: ExtensionStore
  stateStore: ExtensionStateStore
  permissions: ExtensionPermissions
}
