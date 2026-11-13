import { WebContentsView } from 'electron'
import debug from 'debug'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const d = debug('electron-chrome-extensions:tts')

const SIGNATURE = 'tts.speak(string utterance, optional tts.TtsOptions options, optional function callback)'

// What one call may hand the speaker. Chrome's own limit on text is lower
// (Blink refuses more than 32,767 characters with a text-too-long error).
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_WAITING = 100
const MAX_VOICES = 1000
// The hidden page that speaks closes this long after the last utterance.
const IDLE_CLOSE_MS = 15_000
const VOICES_TTL_MS = 60_000

const FINAL_EVENTS = new Set(['end', 'interrupted', 'cancelled', 'error'])

// The event types Chrome lists for the system's voices on each platform.
const PLATFORM_EVENT_TYPES: Record<string, string[]> = {
  darwin: ['start', 'end', 'word', 'interrupted', 'cancelled', 'error', 'pause', 'resume'],
  win32: ['start', 'end', 'word', 'sentence', 'marker', 'interrupted', 'cancelled', 'error', 'pause', 'resume'],
  linux: ['start', 'end', 'interrupted', 'cancelled', 'error', 'pause', 'resume'],
}

interface Utterance {
  id: number
  extensionId: string
  text: string
  enqueue: boolean
  rate: number
  pitch: number
  volume: number
  lang?: string
  voiceName?: string
  /** Set by the renderer when the call passed onEvent: only then are events sent. */
  srcId: number
  desiredEventTypes?: string[]
}

const typeName = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

const invocationError = (detail: string) => new Error(`Error in invocation of ${SIGNATURE}: ${detail}`)

type OptionSpec = { type: 'boolean' | 'string' | 'number' | 'list'; min?: number; max?: number; enum?: string[] }

// TtsOptions as Chrome's schema has it, in the order Chrome checks them.
const OPTION_SPECS: Record<string, OptionSpec> = {
  desiredEventTypes: { type: 'list' },
  enqueue: { type: 'boolean' },
  extensionId: { type: 'string' },
  gender: { type: 'string', enum: ['female', 'male'] },
  lang: { type: 'string' },
  pitch: { type: 'number', min: 0, max: 2 },
  rate: { type: 'number', max: 10 },
  requiredEventTypes: { type: 'list' },
  voiceName: { type: 'string' },
  volume: { type: 'number', min: 0, max: 1 },
}

/**
 * Chrome's checks of speak's arguments, with its messages. `internal` allows
 * srcId, which only the renderer's own code adds.
 */
export function validateSpeakArgs(utterance: unknown, options: unknown, internal = false) {
  if (typeof utterance !== 'string') throw invocationError('No matching signature.')
  if (options == null) return {}
  if (typeof options !== 'object' || Array.isArray(options)) throw invocationError('No matching signature.')
  const opts = options as Record<string, unknown>
  for (const [key, spec] of Object.entries(OPTION_SPECS)) {
    const value = opts[key]
    if (value === undefined || value === null) continue
    const at = (detail: string) => invocationError(`Error at parameter 'options': Error at property '${key}': ${detail}`)
    if (spec.type === 'list') {
      if (!Array.isArray(value)) throw at(`Invalid type: expected array, found ${typeName(value)}.`)
      value.forEach((item, i) => {
        if (typeof item !== 'string') {
          throw invocationError(
            `Error at parameter 'options': Error at property '${key}': Error at index ${i}: Invalid type: expected string, found ${typeName(item)}.`,
          )
        }
      })
      continue
    }
    const ok = spec.type === 'number' ? typeof value === 'number' && !Number.isNaN(value) : typeof value === spec.type
    if (!ok) throw at(`Invalid type: expected ${spec.type}, found ${typeName(value)}.`)
    if (spec.enum && !spec.enum.includes(value as string)) throw at(`Value must be one of ${spec.enum.join(', ')}.`)
    if (spec.min !== undefined && (value as number) < spec.min) throw at(`Value must be at least ${spec.min}.`)
    if (spec.max !== undefined && (value as number) > spec.max) throw at(`Value must be at most ${spec.max}.`)
  }
  for (const key of Object.keys(opts)) {
    if (key in OPTION_SPECS || key === 'onEvent' || (internal && key === 'srcId')) continue
    throw invocationError(`Error at parameter 'options': Unexpected property: '${key}'.`)
  }
  return opts
}

// Runs in the hidden page. It speaks one utterance at a time for the main
// process, which keeps the queue as Chrome's TtsController does, and hands
// back what speechSynthesis reports through next().
const SPEAKER_SCRIPT = `(() => {
  if (window.__tts) return
  const events = []
  let wake = null
  let speaking = null
  const push = (event) => {
    events.push(event)
    if (wake) {
      const w = wake
      wake = null
      w()
    }
  }
  speechSynthesis.onvoiceschanged = () => push({ type: 'voiceschanged' })
  window.__tts = {
    next: () => new Promise((resolve) => {
      if (events.length) return resolve(events.splice(0))
      const timer = setTimeout(() => { wake = null; resolve([]) }, 20000)
      wake = () => { clearTimeout(timer); resolve(events.splice(0)) }
    }),
    voices: () => new Promise((resolve) => {
      const read = () => speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, local: v.localService }))
      if (read().length) return resolve(read())
      const timer = setTimeout(() => resolve(read()), 1500)
      speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(timer); resolve(read()) }, { once: true })
    }),
    speak: (o) => {
      const u = new SpeechSynthesisUtterance(o.text)
      u.rate = Math.min(10, Math.max(0.1, o.rate))
      u.pitch = o.pitch
      u.volume = o.volume
      if (o.lang) u.lang = o.lang
      const voices = speechSynthesis.getVoices()
      const voice = (o.voiceName && voices.find((v) => v.name === o.voiceName)) ||
        (o.lang && voices.find((v) => v.lang === o.lang))
      if (voice) u.voice = voice
      const id = o.id
      u.onstart = () => push({ id, type: 'start' })
      u.onend = () => push({ id, type: 'end' })
      u.onerror = (e) => push({ id, type: 'error', error: e.error })
      u.onpause = (e) => push({ id, type: 'pause', charIndex: e.charIndex })
      u.onresume = (e) => push({ id, type: 'resume', charIndex: e.charIndex })
      u.onmark = (e) => push({ id, type: 'marker', charIndex: e.charIndex })
      u.onboundary = (e) => push({ id, type: e.name === 'sentence' ? 'sentence' : 'word', charIndex: e.charIndex, length: e.charLength })
      // Held so the utterance is not collected while it speaks.
      speaking = u
      speechSynthesis.speak(u)
    },
    cancel: () => { speaking = null; speechSynthesis.cancel(); speechSynthesis.resume() },
    pause: () => speechSynthesis.pause(),
    resume: () => speechSynthesis.resume(),
  }
})()`

/**
 * The main process has no speech of its own, so a hidden page speaks with
 * speechSynthesis. It is a view in no window, so it never shows and never
 * keeps the app from quitting, and it closes when there is nothing to say.
 */
class Speaker {
  private view: WebContentsView
  private closed = false
  readonly ready: Promise<void>

  constructor(
    session: Electron.Session,
    private onEvents: (events: any[]) => void,
    private onGone: () => void,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        disableDialogs: true,
        spellcheck: false,
      },
    })
    const wc = this.view.webContents
    wc.once('destroyed', () => this.gone())
    wc.on('render-process-gone', () => this.gone())
    this.ready = wc
      .loadURL('about:blank')
      .then(() => wc.executeJavaScript(SPEAKER_SCRIPT))
      .then(() => {
        void this.pump()
      })
    // A page that would not load is dropped; the next utterance makes another.
    this.ready.catch(() => {
      this.close()
      this.onGone()
    })
  }

  private gone() {
    if (this.closed) return
    this.closed = true
    this.onGone()
  }

  private async pump() {
    const wc = this.view.webContents
    while (!this.closed && !wc.isDestroyed()) {
      try {
        const events = await wc.executeJavaScript('__tts.next()')
        if (Array.isArray(events) && events.length) this.onEvents(events)
      } catch (error) {
        d('speaker stopped answering: %o', error)
        this.close()
        this.onGone()
        return
      }
    }
  }

  async call(code: string) {
    await this.ready
    const wc = this.view.webContents
    if (this.closed || wc.isDestroyed()) throw new Error('The speaker is closed.')
    return wc.executeJavaScript(code)
  }

  close() {
    if (this.closed && this.view.webContents.isDestroyed()) return
    this.closed = true
    const wc = this.view.webContents
    if (!wc.isDestroyed()) wc.close()
  }
}

/**
 * chrome.tts: speech with Chrome's queue. Utterances wait their turn; one that
 * does not enqueue cuts off what is speaking ('interrupted') and drops what
 * waits ('cancelled'). Events go to the extension only for utterances that
 * asked for them with onEvent, as in Chrome.
 */
export class TtsAPI {
  private queue: Utterance[] = []
  private current?: Utterance
  private paused = false
  private speaker?: Speaker
  private idleTimer?: NodeJS.Timeout
  private nextId = 1
  private voices?: chrome.tts.TtsVoice[]
  private voicesAt = 0

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('tts.speak', this.speak)
    handle('tts.stop', this.stop)
    handle('tts.pause', this.pause)
    handle('tts.resume', this.resume)
    handle('tts.isSpeaking', this.isSpeaking)
    handle('tts.getVoices', this.getVoices)

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      // Its speech ends with it, with no one left to tell.
      this.queue = this.queue.filter((u) => u.extensionId !== extension.id)
      if (this.current?.extensionId === extension.id) {
        this.current = undefined
        void this.speaker?.call('__tts.cancel()').catch(() => {})
        this.speakNext()
      }
    })
  }

  private ensureSpeaker() {
    if (!this.speaker) {
      const speaker: Speaker = new Speaker(
        this.ctx.session,
        (events) => this.onSpeakerEvents(events),
        () => {
          if (this.speaker !== speaker) return
          this.speaker = undefined
          const current = this.current
          if (current) {
            this.current = undefined
            this.send(current, 'error', undefined, undefined, 'The speech engine stopped.')
            this.speakNext()
          }
        },
      )
      this.speaker = speaker
    }
    return this.speaker
  }

  private scheduleIdleClose() {
    if (this.idleTimer || !this.speaker) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.current || this.queue.length) return
      this.speaker?.close()
      this.speaker = undefined
    }, IDLE_CLOSE_MS)
    this.idleTimer.unref?.()
  }

  private cancelIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Sends a TtsEvent as Chrome builds it, to the extension that spoke. */
  private send(u: Utterance, type: string, charIndex?: number, length?: number, errorMessage?: string) {
    if (u.srcId < 0) return
    if (u.desiredEventTypes && u.desiredEventTypes.length && !u.desiredEventTypes.includes(type)) return
    const event: Record<string, unknown> = { type }
    if (typeof charIndex === 'number' && charIndex >= 0) event.charIndex = charIndex
    if (typeof length === 'number' && length >= 0) event.length = length
    if (type === 'error') event.errorMessage = errorMessage || ''
    event.srcId = u.srcId
    event.isFinalEvent = FINAL_EVENTS.has(type)
    this.ctx.router.sendEvent(u.extensionId, 'tts.onEvent', event)
  }

  private speakNext() {
    if (this.current || this.paused) return
    const next = this.queue.shift()
    if (!next) {
      this.scheduleIdleClose()
      return
    }
    this.cancelIdleClose()
    this.current = next
    const { id, text, rate, pitch, volume, lang, voiceName } = next
    this.ensureSpeaker()
      .call(`__tts.speak(${JSON.stringify({ id, text, rate, pitch, volume, lang, voiceName })})`)
      .catch((error) => {
        d('speak failed: %o', error)
        if (this.current !== next) return
        this.current = undefined
        this.send(next, 'error', undefined, undefined, 'The speech engine could not speak.')
        this.speakNext()
      })
  }

  private onSpeakerEvents(events: any[]) {
    for (const e of events) {
      if (!e || typeof e !== 'object') continue
      if (e.type === 'voiceschanged') {
        if (this.voices) {
          this.voices = undefined
          this.ctx.router.broadcastEvent('tts.onVoicesChanged')
        }
        continue
      }
      const u = this.current
      // Events of an utterance that was cut off come late; they are not news.
      if (!u || e.id !== u.id) continue
      const charIndex = Number.isInteger(e.charIndex) ? e.charIndex : undefined
      const length = Number.isInteger(e.length) ? e.length : undefined
      switch (e.type) {
        case 'start':
          this.send(u, 'start', 0)
          break
        case 'word':
        case 'sentence':
          this.send(u, e.type, charIndex, length)
          break
        case 'marker':
        case 'pause':
        case 'resume':
          this.send(u, e.type, charIndex)
          break
        case 'end':
          this.current = undefined
          this.send(u, 'end', u.text.length)
          this.speakNext()
          break
        case 'error':
          this.current = undefined
          this.send(u, 'error', undefined, undefined, typeof e.error === 'string' ? e.error : 'synthesis-failed')
          this.speakNext()
          break
      }
    }
  }

  /** Cuts off what is speaking and drops what waits, for the extensions `which` names. */
  private clear(which: (u: Utterance) => boolean) {
    const current = this.current
    if (current && which(current)) {
      this.current = undefined
      void this.speaker?.call('__tts.cancel()').catch(() => {})
      this.send(current, 'interrupted')
    }
    const dropped = this.queue.filter(which)
    this.queue = this.queue.filter((u) => !which(u))
    for (const u of dropped) this.send(u, 'cancelled')
  }

  private speak = ({ extension }: ExtensionEvent, utterance: unknown, options: unknown) => {
    const opts = validateSpeakArgs(utterance, options, true) as Record<string, any>
    const text = utterance as string
    const srcId = Number.isInteger(opts.srcId) ? (opts.srcId as number) : -1
    const u: Utterance = {
      id: this.nextId++,
      extensionId: extension.id,
      text,
      enqueue: opts.enqueue === true,
      rate: typeof opts.rate === 'number' ? opts.rate : 1,
      pitch: typeof opts.pitch === 'number' ? opts.pitch : 1,
      volume: typeof opts.volume === 'number' ? opts.volume : 1,
      lang: typeof opts.lang === 'string' && opts.lang.length < 64 ? opts.lang : undefined,
      voiceName: typeof opts.voiceName === 'string' && opts.voiceName.length < 512 ? opts.voiceName : undefined,
      srcId,
      desiredEventTypes: Array.isArray(opts.desiredEventTypes) ? opts.desiredEventTypes.slice(0, 20) : undefined,
    }
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
      this.send(u, 'error', undefined, undefined, 'text-too-long')
      return
    }
    // Chrome's queue is shared by every extension: a speak that does not
    // enqueue cuts off whoever is speaking.
    if (!u.enqueue) this.clear(() => true)
    if (this.queue.filter((q) => q.extensionId === extension.id).length >= MAX_WAITING) {
      this.send(u, 'error', undefined, undefined, 'Too many utterances are waiting.')
      return
    }
    this.queue.push(u)
    this.speakNext()
  }

  /**
   * Chrome stops only speech from the caller: another extension's utterance
   * keeps speaking. Of what waits, only the caller's is dropped here.
   */
  private stop = ({ extension }: ExtensionEvent) => {
    if (this.current && this.current.extensionId !== extension.id) return
    this.clear((u) => u.extensionId === extension.id)
    if (this.paused) {
      this.paused = false
      void this.speaker?.call('__tts.resume()').catch(() => {})
    }
    this.speakNext()
  }

  private pause = () => {
    if (this.paused) return
    this.paused = true
    if (this.current) void this.speaker?.call('__tts.pause()').catch(() => {})
  }

  private resume = () => {
    if (!this.paused) return
    this.paused = false
    if (this.current) void this.speaker?.call('__tts.resume()').catch(() => {})
    else this.speakNext()
  }

  private isSpeaking = () => !!this.current

  private getVoices = async (): Promise<chrome.tts.TtsVoice[]> => {
    // Voices change rarely (a new system voice); the list is read again after a while.
    if (this.voices && Date.now() - this.voicesAt < VOICES_TTL_MS) {
      return this.voices.map((v) => ({ ...v, eventTypes: [...(v.eventTypes || [])] }))
    }
    const speaker = this.ensureSpeaker()
    let list: Array<{ name?: unknown; lang?: unknown; local?: unknown }> = []
    try {
      const result = await speaker.call('__tts.voices()')
      if (Array.isArray(result)) list = result.slice(0, MAX_VOICES)
    } catch (error) {
      d('could not list voices: %o', error)
    }
    if (!this.current && !this.queue.length) this.scheduleIdleClose()
    const eventTypes = PLATFORM_EVENT_TYPES[process.platform] || PLATFORM_EVENT_TYPES.linux
    this.voicesAt = Date.now()
    this.voices = list
      .filter((v) => typeof v?.name === 'string')
      .map((v) => {
        const voice: chrome.tts.TtsVoice = { voiceName: v.name as string, remote: v.local === false }
        if (typeof v.lang === 'string' && v.lang) voice.lang = v.lang
        voice.eventTypes = [...eventTypes] as any
        return voice
      })
    return this.voices.map((v) => ({ ...v, eventTypes: [...(v.eventTypes || [])] }))
  }
}
