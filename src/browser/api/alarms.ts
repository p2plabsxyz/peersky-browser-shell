import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { installTypeOf } from './management'

type PersistedAlarm = {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

type AlarmMap = Map<string, PersistedAlarm>

const ALARMS_STATE_NS = 'alarms'

/** `setTimeout` delay is a signed 32-bit value in browsers and Node; larger values overflow. */
const MAX_SET_TIMEOUT_MS = 2147483647

/** Chrome's limit on alarms one extension may have at once. */
const MAX_ALARMS = 500

/** Chrome's shortest delay and period for an extension that is not unpacked. */
const RELEASE_MINIMUM_MINUTES = 0.5

/**
 * A repeating alarm never fires more often than this, whatever it asks for,
 * so a tiny period cannot flood the main process with events.
 */
const MIN_REPEAT_MS = 1000

const SIGNATURE =
  'alarms.create(optional string name, alarms.AlarmCreateInfo alarmInfo, optional function callback)'

/** The type name Chrome's argument checks report, as in "found integer". */
export const chromeTypeName = (value: unknown) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

const invocationError = (signature: string, detail: string) =>
  new Error(`Error in invocation of ${signature}: ${detail}`)

export class AlarmsAPI {
  private alarmsByExtension = new Map<string, AlarmMap>()
  private timers = new Map<string, NodeJS.Timeout>()
  private restoreReady: Promise<void>

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('alarms.create', this.create, { permission: 'alarms' })
    handle('alarms.get', this.get, { permission: 'alarms' })
    handle('alarms.getAll', this.getAll, { permission: 'alarms' })
    handle('alarms.clear', this.clear, { permission: 'alarms' })
    handle('alarms.clearAll', this.clearAll, { permission: 'alarms' })

    this.restoreReady = this.restoreFromState()

    const sessionExtensions = ctx.session.extensions || ctx.session
    // Unloading (a disable, a reload, the host quitting) keeps the saved
    // alarms, as Chrome does, and they come back when the extension loads
    // again. Only an uninstall forgets them.
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.clearExtension(extension.id, false)
    })
    sessionExtensions.on('extension-loaded', (_event, extension) => {
      void this.restoreReady.then(() => this.restoreExtension(extension.id))
    })
    this.ctx.store.on('extension-uninstalled', (extensionId: string) => {
      this.clearExtension(extensionId, false)
      const state = { ...this.getState() }
      if (extensionId in state) {
        delete state[extensionId]
        this.ctx.stateStore.setNamespace(ALARMS_STATE_NS, state)
        void this.ctx.stateStore.flush().catch(() => {})
      }
    })
  }

  private getState(): Record<string, PersistedAlarm[]> {
    return this.ctx.stateStore.getNamespace<Record<string, PersistedAlarm[]>>(ALARMS_STATE_NS, {})
  }

  private saveExtension(extensionId: string) {
    const nextState = { ...this.getState() }
    const alarms = this.alarmsByExtension.get(extensionId)
    if (alarms && alarms.size) nextState[extensionId] = Array.from(alarms.values())
    else delete nextState[extensionId]
    this.ctx.stateStore.setNamespace(ALARMS_STATE_NS, nextState)
    void this.ctx.stateStore.flush().catch(() => {})
  }

  private isLoaded(extensionId: string) {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    return !!sessionExtensions.getExtension(extensionId)
  }

  private async restoreFromState() {
    await this.ctx.stateStore.whenHydrated()
    for (const extensionId of Object.keys(this.getState())) {
      if (this.isLoaded(extensionId)) this.restoreExtension(extensionId)
    }
  }

  private restoreExtension(extensionId: string) {
    if (this.alarmsByExtension.has(extensionId)) return
    const alarms = this.getState()[extensionId]
    if (!Array.isArray(alarms) || alarms.length === 0) return
    const map: AlarmMap = new Map()
    for (const alarm of alarms.slice(0, MAX_ALARMS)) {
      if (!alarm || typeof alarm.scheduledTime !== 'number' || !Number.isFinite(alarm.scheduledTime)) continue
      const name = typeof alarm.name === 'string' ? alarm.name : ''
      map.set(name, {
        name,
        scheduledTime: alarm.scheduledTime,
        periodInMinutes:
          typeof alarm.periodInMinutes === 'number' && alarm.periodInMinutes > 0
            ? alarm.periodInMinutes
            : undefined,
      })
    }
    if (map.size === 0) return
    this.alarmsByExtension.set(extensionId, map)
    // One that came due while the extension was not loaded fires now, once.
    for (const alarm of map.values()) this.scheduleAlarm(extensionId, alarm)
  }

  private key(extensionId: string, alarmName: string) {
    return `${extensionId}:${alarmName}`
  }

  private toChromeAlarm(alarm: PersistedAlarm): chrome.alarms.Alarm {
    const out: chrome.alarms.Alarm & { persistAcrossSessions: boolean } = {
      name: alarm.name,
      scheduledTime: alarm.scheduledTime,
      persistAcrossSessions: true,
    }
    if (typeof alarm.periodInMinutes === 'number') {
      out.periodInMinutes = alarm.periodInMinutes
    }
    return out
  }

  private scheduleAlarm(extensionId: string, alarm: PersistedAlarm) {
    const timerKey = this.key(extensionId, alarm.name)
    this.clearTimer(extensionId, alarm.name)

    const fireAt = alarm.scheduledTime
    const tick = () => {
      const remaining = fireAt - Date.now()
      if (remaining <= 0) {
        this.timers.delete(timerKey)
        this.fireAlarm(extensionId, alarm.name)
        return
      }
      const timer = setTimeout(tick, Math.min(remaining, MAX_SET_TIMEOUT_MS))
      this.timers.set(timerKey, timer)
    }
    // Never fire inside the call that created the alarm.
    const timer = setTimeout(tick, 0)
    this.timers.set(timerKey, timer)
  }

  private fireAlarm(extensionId: string, alarmName: string) {
    const alarmMap = this.alarmsByExtension.get(extensionId)
    const alarm = alarmMap?.get(alarmName)
    if (!alarmMap || !alarm) return

    // The worker may not be running, or (after a restart) may not have added
    // its listener yet: the event waits for it.
    this.ctx.router.sendEventWhenListening(extensionId, 'alarms.onAlarm', [this.toChromeAlarm(alarm)])

    if (typeof alarm.periodInMinutes === 'number' && alarm.periodInMinutes > 0) {
      const period = Math.max(alarm.periodInMinutes * 60_000, MIN_REPEAT_MS)
      alarm.scheduledTime = Date.now() + period
      this.scheduleAlarm(extensionId, alarm)
      this.saveExtension(extensionId)
      return
    }

    this.clearForExtension(extensionId, alarmName)
  }

  private clearTimer(extensionId: string, alarmName: string) {
    const timerKey = this.key(extensionId, alarmName)
    const existing = this.timers.get(timerKey)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(timerKey)
    }
  }

  private clearForExtension(extensionId: string, alarmName: string) {
    this.clearTimer(extensionId, alarmName)
    const alarmMap = this.alarmsByExtension.get(extensionId)
    if (!alarmMap) return false

    const didDelete = alarmMap.delete(alarmName)
    if (alarmMap.size === 0) {
      this.alarmsByExtension.delete(extensionId)
    }
    if (didDelete) {
      this.saveExtension(extensionId)
    }
    return didDelete
  }

  private clearExtension(extensionId: string, persist: boolean) {
    const alarmMap = this.alarmsByExtension.get(extensionId)
    if (!alarmMap) return
    for (const name of alarmMap.keys()) {
      this.clearTimer(extensionId, name)
    }
    this.alarmsByExtension.delete(extensionId)
    if (persist) {
      this.saveExtension(extensionId)
    }
  }

  /** Reads create()'s arguments as Chrome's bindings would, with their errors. */
  private parseCreateArgs(args: unknown[]): { name: string; info: Record<string, unknown> } {
    let name = ''
    let info: unknown
    if (args.length >= 2 && args[1] !== undefined) {
      if (args[0] !== undefined && args[0] !== null && typeof args[0] !== 'string') {
        throw invocationError(SIGNATURE, 'No matching signature.')
      }
      name = typeof args[0] === 'string' ? args[0] : ''
      info = args[1]
    } else if (typeof args[0] === 'string') {
      throw invocationError(SIGNATURE, 'No matching signature.')
    } else {
      info = args[0]
    }
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      throw invocationError(SIGNATURE, 'No matching signature.')
    }
    const record = info as Record<string, unknown>
    for (const key of ['when', 'delayInMinutes', 'periodInMinutes']) {
      const value = record[key]
      if (value === undefined || value === null) continue
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invocationError(
          SIGNATURE,
          `Error at parameter 'alarmInfo': Error at property '${key}': Invalid type: expected number, found ${chromeTypeName(value)}.`,
        )
      }
    }
    if (name.length > 1024) name = name.slice(0, 1024)
    return { name, info: record }
  }

  private create = async ({ extension }: ExtensionEvent, ...args: unknown[]) => {
    await this.restoreReady
    const { name: alarmName, info } = this.parseCreateArgs(args)
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
    const when = num(info.when)
    let delayInMinutes = num(info.delayInMinutes)
    let periodInMinutes = num(info.periodInMinutes)

    if (when === undefined && delayInMinutes === undefined && periodInMinutes === undefined) {
      throw new Error('Must set at least one of when, delayInMinutes, or periodInMinutes.')
    }
    if (when !== undefined && delayInMinutes !== undefined) {
      throw new Error('Cannot set both when and delayInMinutes.')
    }

    // Chrome lets an unpacked extension use any delay, and holds others to
    // thirty seconds.
    if (installTypeOf(this.ctx, extension) !== 'development') {
      if (delayInMinutes !== undefined) delayInMinutes = Math.max(delayInMinutes, RELEASE_MINIMUM_MINUTES)
      if (periodInMinutes !== undefined) periodInMinutes = Math.max(periodInMinutes, RELEASE_MINIMUM_MINUTES)
    }

    let scheduledTime: number
    if (when !== undefined) scheduledTime = when
    else if (delayInMinutes !== undefined) scheduledTime = Date.now() + delayInMinutes * 60_000
    else scheduledTime = Date.now() + (periodInMinutes as number) * 60_000

    const extensionId = extension.id
    const alarmMap = this.alarmsByExtension.get(extensionId) || new Map()
    if (!alarmMap.has(alarmName) && alarmMap.size >= MAX_ALARMS) {
      throw new Error(`An extension cannot have more than ${MAX_ALARMS} active alarms.`)
    }

    const next: PersistedAlarm = {
      name: alarmName,
      scheduledTime,
      periodInMinutes: periodInMinutes !== undefined && periodInMinutes > 0 ? periodInMinutes : undefined,
    }
    alarmMap.set(alarmName, next)
    this.alarmsByExtension.set(extensionId, alarmMap)
    this.scheduleAlarm(extensionId, next)
    this.saveExtension(extensionId)
  }

  private get = async (
    { extension }: ExtensionEvent,
    name?: unknown,
  ): Promise<chrome.alarms.Alarm | undefined> => {
    await this.restoreReady
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw invocationError('alarms.get(optional string name, optional function callback)', 'No matching signature.')
    }
    const alarm = this.alarmsByExtension.get(extension.id)?.get(typeof name === 'string' ? name : '')
    return alarm ? this.toChromeAlarm(alarm) : undefined
  }

  private getAll = async ({ extension }: ExtensionEvent): Promise<chrome.alarms.Alarm[]> => {
    await this.restoreReady
    const alarmMap = this.alarmsByExtension.get(extension.id)
    if (!alarmMap) return []
    return Array.from(alarmMap.values()).map((alarm) => this.toChromeAlarm(alarm))
  }

  private clear = async ({ extension }: ExtensionEvent, name?: unknown): Promise<boolean> => {
    await this.restoreReady
    if (name !== undefined && name !== null && typeof name !== 'string') {
      throw invocationError('alarms.clear(optional string name, optional function callback)', 'No matching signature.')
    }
    return this.clearForExtension(extension.id, typeof name === 'string' ? name : '')
  }

  /** Chrome 157 resolves clearAll with nothing, whatever its docs say. */
  private clearAll = async ({ extension }: ExtensionEvent): Promise<void> => {
    await this.restoreReady
    this.clearExtension(extension.id, true)
  }
}
