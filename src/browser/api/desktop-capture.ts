import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const CHOOSE_SIGNATURE =
  'desktopCapture.chooseDesktopMedia(array sources, optional tabs.Tab targetTab, optional object options, function callback)'
const SOURCE_TYPES = ['audio', 'screen', 'tab', 'window']
const OPTION_ENUMS: Record<string, string[]> = {
  selfBrowserSurface: ['exclude', 'include'],
  systemAudio: ['exclude', 'include'],
  windowAudio: ['exclude', 'system', 'window'],
}

// Pickers one extension may have open at once.
const MAX_PENDING = 4

type Answer = [string, { canRequestAudioTrack: boolean }]
const CANCELLED: Answer = ['', { canRequestAudioTrack: false }]

const fail = (detail: string) => new Error(`Error in invocation of ${CHOOSE_SIGNATURE}: ${detail}`)

/** Chrome's checks of the sources and options, with its messages. */
export function validateChooseArgs(sources: unknown, options: unknown) {
  if (!Array.isArray(sources) || sources.length > SOURCE_TYPES.length * 4) throw fail('No matching signature.')
  sources.forEach((source, i) => {
    if (typeof source !== 'string' || !SOURCE_TYPES.includes(source)) {
      throw fail(`Error at parameter 'sources': Error at index ${i}: Value must be one of ${SOURCE_TYPES.join(', ')}.`)
    }
  })
  if (options != null) {
    if (typeof options !== 'object' || Array.isArray(options)) throw fail('No matching signature.')
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) continue
      if (key === 'suppressLocalAudioPlaybackIntended') {
        if (typeof value !== 'boolean') {
          throw fail(`Error at parameter 'options': Error at property '${key}': Invalid type: expected boolean, found ${typeof value}.`)
        }
      } else if (OPTION_ENUMS[key]) {
        if (!OPTION_ENUMS[key].includes(value as string)) {
          throw fail(`Error at parameter 'options': Error at property '${key}': Value must be one of ${OPTION_ENUMS[key].join(', ')}.`)
        }
      } else {
        throw fail(`Error at parameter 'options': Unexpected property: '${key}'.`)
      }
    }
  }
  return [...new Set(sources as string[])] as Array<'screen' | 'window' | 'tab' | 'audio'>
}

/** Origins Chrome counts as secure for a stream: https, and the machine itself. */
const isSecureOrigin = (url: URL) => {
  if (url.protocol === 'https:' || url.protocol === 'wss:' || url.protocol === 'file:') return true
  if (url.protocol === 'chrome-extension:') return true
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return (
    (url.protocol === 'http:' || url.protocol === 'ws:') &&
    (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1')
  )
}

/**
 * chrome.desktopCapture: the person picks a screen or window to share. The
 * picker is the host's (ChromeExtensionImpl.chooseDesktopMedia); without one
 * every request is answered as Chrome answers a cancelled picker.
 */
export class DesktopCaptureAPI {
  private pending = new Map<string, { extensionId: string; controller: AbortController; answer: (a: Answer) => void }>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('desktopCapture.chooseDesktopMedia', this.chooseDesktopMedia)
    handle('desktopCapture.cancelChooseDesktopMedia', this.cancelChooseDesktopMedia)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      for (const request of [...this.pending.values()]) {
        if (request.extensionId === extension.id) request.answer(CANCELLED)
      }
    })
  }

  private targetTab(targetTab: unknown) {
    if (!targetTab || typeof targetTab !== 'object' || Array.isArray(targetTab)) throw fail('No matching signature.')
    const { id, url } = targetTab as { id?: unknown; url?: unknown }
    if (id == null || id === -1) throw new Error("targetTab doesn't have id field set.")
    if (!Number.isInteger(id)) {
      throw fail(`Error at parameter 'targetTab': Error at property 'id': Invalid type: expected integer, found ${typeof id}.`)
    }
    if (url == null) throw new Error("targetTab doesn't have URL field set.")
    if (typeof url !== 'string') {
      throw fail(`Error at parameter 'targetTab': Error at property 'url': Invalid type: expected string, found ${typeof url}.`)
    }
    const tab = this.ctx.store.getTabById(id as number)
    if (!tab) throw new Error('Invalid tab specified.')
    let origin: URL
    try {
      origin = new URL(url)
    } catch {
      throw new Error('URL scheme for the specified tab is not secure.')
    }
    if (!isSecureOrigin(origin)) throw new Error('URL scheme for the specified tab is not secure.')
    let current: URL | undefined
    try {
      current = new URL(tab.getURL())
    } catch {}
    if (!current || current.origin !== origin.origin) throw new Error('URL for the specified tab has changed.')
    return tab
  }

  private chooseDesktopMedia = async (
    event: ExtensionEvent,
    requestId: unknown,
    sources: unknown,
    targetTab?: unknown,
    options?: unknown,
  ): Promise<Answer> => {
    if (!Number.isInteger(requestId)) throw fail('No matching signature.')
    const kinds = validateChooseArgs(sources, options)
    if (targetTab == null && event.type === 'service-worker') {
      throw new Error('A target tab is required when called from a service worker context.')
    }
    if (kinds.length === 0) throw new Error('At least one source type must be specified.')
    // Without a target tab the stream is for the extension itself.
    const tab = targetTab == null ? undefined : this.targetTab(targetTab)

    const { extension } = event
    const key = `${extension.id} ${requestId}`
    const mine = [...this.pending.values()].filter((r) => r.extensionId === extension.id).length
    if (this.pending.has(key) || mine >= MAX_PENDING) throw new Error('Too many pickers are open.')

    const pick = this.ctx.store.impl.chooseDesktopMedia
    if (typeof pick !== 'function') return CANCELLED

    const controller = new AbortController()
    return new Promise<Answer>((resolve) => {
      let done = false
      const onTabGone = () => answer(CANCELLED)
      const answer = (value: Answer) => {
        if (done) return
        done = true
        this.pending.delete(key)
        tab?.removeListener('destroyed', onTabGone)
        if (!controller.signal.aborted) controller.abort()
        resolve(value)
      }
      this.pending.set(key, { extensionId: extension.id, controller, answer })
      tab?.once('destroyed', onTabGone)
      Promise.resolve()
        .then(() => pick({ extension, sources: kinds, tab, signal: controller.signal }))
        .then(
          (choice) => {
            if (!choice || typeof choice.id !== 'string' || !choice.id || choice.id.length > 256) return answer(CANCELLED)
            answer([choice.id, { canRequestAudioTrack: choice.audio === true && kinds.includes('audio') }])
          },
          (error) => {
            console.error('chooseDesktopMedia failed', error)
            answer(CANCELLED)
          },
        )
    })
  }

  /** Closes the picker; the request is answered as cancelled, as in Chrome. */
  private cancelChooseDesktopMedia = ({ extension }: ExtensionEvent, requestId: unknown) => {
    if (!Number.isInteger(requestId)) {
      throw new Error(
        'Error in invocation of desktopCapture.cancelChooseDesktopMedia(integer desktopMediaRequestId): No matching signature.',
      )
    }
    this.pending.get(`${extension.id} ${requestId}`)?.answer(CANCELLED)
  }
}
