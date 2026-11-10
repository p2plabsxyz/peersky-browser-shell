import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const SIGNATURE = 'pageCapture.saveAsMHTML(object details, optional function callback)'

// Saves run one after another per extension, and only a few may wait, so an
// extension cannot fill the disk or memory with copies of pages.
const MAX_WAITING = 8
// What a save may hand back over IPC; a page past this fails as too big.
const MAX_MHTML_BYTES = 256 * 1024 * 1024

const invocationError = (detail: string) => new Error(`Error in invocation of ${SIGNATURE}: ${detail}`)

const typeName = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

/** Chrome's checks of the details argument, with its messages. */
export function validateSaveDetails(details: unknown): number {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw invocationError('No matching signature.')
  }
  const { tabId } = details as { tabId?: unknown }
  if (tabId === undefined) throw invocationError("Error at parameter 'details': Missing required property 'tabId'.")
  if (!Number.isInteger(tabId)) {
    throw invocationError(
      `Error at parameter 'details': Error at property 'tabId': Invalid type: expected integer, found ${typeName(tabId)}.`,
    )
  }
  for (const key of Object.keys(details)) {
    if (key !== 'tabId') throw invocationError(`Error at parameter 'details': Unexpected property: '${key}'.`)
  }
  return tabId as number
}

/**
 * chrome.pageCapture.saveAsMHTML: the page in a tab as one MHTML file. The
 * page is saved to a temporary file, read and deleted; the extension gets the
 * bytes, as a Blob.
 */
export class PageCaptureAPI {
  private queues = new Map<string, { tail: Promise<unknown>; waiting: number }>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('pageCapture.saveAsMHTML', this.saveAsMHTML)
  }

  /**
   * Chrome saves http and https pages with the pageCapture permission alone,
   * and the extension's own pages. Anything else, such as about:blank, data:,
   * the browser's own pages or another extension's, it refuses.
   */
  private mayCapture(extension: Electron.Extension, url: string) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true
    return parsed.protocol === 'chrome-extension:' && parsed.hostname === extension.id
  }

  private saveAsMHTML = async ({ extension }: ExtensionEvent, details: unknown) => {
    const tabId = validateSaveDetails(details)
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab || tab.isDestroyed()) throw new Error('Cannot find the tab for this request.')
    if (!this.mayCapture(extension, tab.getURL())) {
      throw new Error("Don't have permissions required to capture this page.")
    }

    let queue = this.queues.get(extension.id)
    if (!queue) this.queues.set(extension.id, (queue = { tail: Promise.resolve(), waiting: 0 }))
    if (queue.waiting >= MAX_WAITING) throw new Error('Too many pages are being saved at once.')
    queue.waiting++
    const run = queue.tail.then(() => this.save(extension, tab))
    queue.tail = run.catch(() => {})
    try {
      return await run
    } finally {
      queue.waiting--
      if (queue.waiting === 0 && this.queues.get(extension.id) === queue) this.queues.delete(extension.id)
    }
  }

  private async save(extension: Electron.Extension, tab: Electron.WebContents) {
    // The tab may have closed or moved to a page it may not save while this
    // waited its turn.
    if (tab.isDestroyed()) throw new Error('Cannot find the tab for this request.')
    if (!this.mayCapture(extension, tab.getURL())) {
      throw new Error("Don't have permissions required to capture this page.")
    }
    let dir: string
    try {
      dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'crx-mhtml-'))
    } catch {
      throw new Error('Failed to create a temporary file.')
    }
    const file = path.join(dir, 'page.mhtml')
    try {
      try {
        await tab.savePage(file, 'MHTML')
      } catch {
        throw new Error('Failed to generate MHTML.')
      }
      const { size } = await fs.stat(file).catch(() => {
        throw new Error('Failed to retrieve size of generated MHTML.')
      })
      if (size > MAX_MHTML_BYTES) throw new Error('The page is too big to save as MHTML.')
      return await fs.readFile(file)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
