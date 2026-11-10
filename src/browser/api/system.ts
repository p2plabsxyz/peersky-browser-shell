import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { screen } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const CHROMEOS_ONLY = 'Function available only on ChromeOS.'

/** Chrome's id for a storage unit: a stable hash of where it is mounted. */
const unitId = (mountPoint: string) => createHash('sha256').update(mountPoint).digest('hex').slice(0, 32)

/**
 * chrome.system.cpu, memory, display and storage. Electron declares these
 * bindings but has nothing behind them, and calling one crashes the browser
 * process, so the shell serves them from Node and Electron instead.
 */
export class SystemAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('system.cpu.getInfo', this.cpuInfo)
    handle('system.memory.getInfo', this.memoryInfo)
    handle('system.display.getInfo', this.displayInfo)
    for (const name of [
      'getDisplayLayout',
      'setDisplayLayout',
      'setDisplayProperties',
      'enableUnifiedDesktop',
      'overscanCalibrationStart',
      'overscanCalibrationAdjust',
      'overscanCalibrationReset',
      'overscanCalibrationComplete',
      'showNativeTouchCalibration',
      'startCustomTouchCalibration',
      'completeCustomTouchCalibration',
      'clearTouchCalibration',
      'setMirrorMode',
    ]) {
      handle(`system.display.${name}`, this.chromeOsOnly)
    }
    handle('system.storage.getInfo', this.storageInfo)
    handle('system.storage.getAvailableCapacity', this.availableCapacity)
    handle('system.storage.ejectDevice', this.ejectDevice)

    const onDisplays = () => this.ctx.router.broadcastEvent('system.display.onDisplayChanged')
    screen.on('display-added', onDisplays)
    screen.on('display-removed', onDisplays)
    screen.on('display-metrics-changed', onDisplays)
  }

  private chromeOsOnly = () => {
    throw new Error(CHROMEOS_ONLY)
  }

  private cpuInfo = () => {
    const cpus = os.cpus()
    return {
      archName: process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : process.arch,
      features: [] as string[],
      modelName: cpus[0]?.model?.trim() || '',
      numOfProcessors: cpus.length,
      processors: cpus.map((cpu) => {
        const t = cpu.times
        const kernel = t.sys + t.irq
        const user = t.user + t.nice
        return { usage: { user, kernel, idle: t.idle, total: user + kernel + t.idle } }
      }),
      temperatures: [] as number[],
    }
  }

  private memoryInfo = () => ({
    capacity: os.totalmem(),
    availableCapacity: os.freemem(),
  })

  private displayInfo = () => {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((d) => {
      const rect = (r: Electron.Rectangle) => ({ left: r.x, top: r.y, width: r.width, height: r.height })
      return {
        id: String(d.id),
        name: d.label || '',
        mirroringSourceId: '',
        mirroringDestinationIds: [] as string[],
        isPrimary: d.id === primary.id,
        isInternal: !!d.internal,
        isEnabled: true,
        isUnified: false,
        dpiX: 96 * d.scaleFactor,
        dpiY: 96 * d.scaleFactor,
        rotation: d.rotation,
        bounds: rect(d.bounds),
        overscan: { left: 0, top: 0, right: 0, bottom: 0 },
        workArea: rect(d.workArea),
        modes: [] as unknown[],
        hasTouchSupport: d.touchSupport === 'available',
        hasAccelerometerSupport: d.accelerometerSupport === 'available',
        availableDisplayZoomFactors: [] as number[],
        displayZoomFactor: 1,
        activeState: 'active',
      }
    })
  }

  /** The system volume, plus whatever is mounted under /Volumes or /media. */
  private async mountPoints(): Promise<{ mountPoint: string; type: 'fixed' | 'removable' }[]> {
    const root = process.platform === 'win32' ? path.parse(os.homedir()).root : '/'
    const points: { mountPoint: string; type: 'fixed' | 'removable' }[] = [{ mountPoint: root, type: 'fixed' }]
    const dirs = process.platform === 'darwin' ? ['/Volumes'] : process.platform === 'linux' ? [`/media/${os.userInfo().username}`, '/mnt'] : []
    for (const dir of dirs) {
      let names: string[] = []
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const full = path.join(dir, name)
        try {
          // macOS links the system volume into /Volumes too.
          if ((await fs.realpath(full)) === root) continue
          if (!(await fs.stat(full)).isDirectory()) continue
        } catch {
          continue
        }
        points.push({ mountPoint: full, type: 'removable' })
      }
    }
    return points
  }

  private storageInfo = async () => {
    const units = []
    for (const point of await this.mountPoints()) {
      try {
        const stat = await fs.statfs(point.mountPoint)
        units.push({
          id: unitId(point.mountPoint),
          name: point.mountPoint === '/' ? 'System' : path.basename(point.mountPoint),
          type: point.type,
          capacity: stat.bsize * stat.blocks,
        })
      } catch {}
    }
    return units
  }

  private availableCapacity = async (_event: ExtensionEvent, id: string) => {
    for (const point of await this.mountPoints()) {
      if (unitId(point.mountPoint) !== id) continue
      try {
        const stat = await fs.statfs(point.mountPoint)
        return { id, availableCapacity: stat.bsize * stat.bavail }
      } catch {
        break
      }
    }
    throw new Error('Error occurred when querying available capacity.')
  }

  /** Ejecting is left to the system; Chrome answers the same for a busy unit. */
  private ejectDevice = async (_event: ExtensionEvent, id: string) => {
    const known = (await this.mountPoints()).some((p) => unitId(p.mountPoint) === id)
    return known ? 'in_use' : 'no_such_device'
  }
}
