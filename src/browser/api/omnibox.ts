import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ArgSpec, checkArgs } from './lib/arg-spec'

export type OmniboxStyleType = 'url' | 'match' | 'dim'

export interface OmniboxDescriptionStyle {
  offset: number
  length: number
  type: OmniboxStyleType
}

/** A suggestion an extension gave, ready for a host's address bar. */
export interface OmniboxSuggestion {
  /** What goes in the address bar, and to onInputEntered, when it is picked. */
  content: string
  /** The description as plain text, its markup taken out. */
  description: string
  /** The parts of the description in <url>, <match> or <dim>. */
  descriptionStyles: OmniboxDescriptionStyle[]
  /** The person may delete it (the host then calls omniboxDeleteSuggestion). */
  deletable: boolean
}

export interface OmniboxKeyword {
  extensionId: string
  /** The manifest's omnibox.keyword, which starts the extension's input mode. */
  keyword: string
  name: string
}

export type OmniboxDisposition = 'currentTab' | 'newForegroundTab' | 'newBackgroundTab'

// ---------------------------------------------------------------- XML

/**
 * Chrome reads a description as XML, with libxml2, and refuses it with
 * libxml2's own messages. This reads the same small language (text, the
 * five entities, character references, elements, comments, CDATA) and gives
 * the same messages for the mistakes people make.
 */
interface XmlError {
  message: string
  pos: number
}

class XmlStop extends Error {
  constructor(public kind: 'bad content' | 'unbalanced elements') {
    super(kind)
  }
}

const NAME_START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}'
const NAME_CHAR = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040'
const NAME_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy')
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' }
const STYLE_TAGS = new Set(['url', 'match', 'dim'])

const isBlank = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
const isXmlChar = (cp: number) =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff)

/** libxml2's report of one error: the message, the line of input, and a caret under the place. */
function formatXmlError(source: Buffer, line: number, message: string, bytePos: number) {
  const nl = (b: number | undefined) => b === 0x0a || b === 0x0d
  let cur = bytePos
  while (cur > 0 && nl(source[cur])) cur--
  let n = 0
  while (n < 80 && cur > 0 && !nl(source[cur])) {
    cur--
    n++
  }
  if (n > 0 && nl(source[cur])) cur++
  else while (cur < bytePos && (source[cur] & 0xc0) === 0x80) cur++
  const col = bytePos - cur
  const start = cur
  let end = start
  while (end < source.length && !nl(source[end]) && end - start < 80) end++
  // Never cut a character in two.
  while (end > start && end < source.length && (source[end] & 0xc0) === 0x80) end--
  const content = source.subarray(start, end).toString('utf8')
  const contentBytes = source.subarray(start, end)
  let caret = ''
  for (let i = 0; i < col && i < 79 && i < contentBytes.length; i++) caret += contentBytes[i] === 0x09 ? '\t' : ' '
  caret += '^'
  return `Entity: line ${line}: parser error : ${message}\n${content}\n${caret}\n`
}

interface ParsedDescription {
  text: string
  styles: OmniboxDescriptionStyle[]
}

/**
 * Parses an omnibox description as Chrome does, wrapped in <fragment>.
 * Throws Chrome's "Invalid XML: ..." message when it is not well formed.
 */
export function parseOmniboxDescription(description: string): ParsedDescription {
  // V8 hands Chrome a lone surrogate as U+FFFD.
  const s = `<fragment>${description.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')}</fragment>`
  const errors: XmlError[] = []
  let pos = 0
  let text = ''
  const styles: OmniboxDescriptionStyle[] = []
  const stack: { name: string; line: number; textStart: number }[] = []
  let rootClosed = false

  const lineAt = (p: number) => {
    let line = 1
    for (let i = 0; i < p && i < s.length; i++) if (s[i] === '\n') line++
    return line
  }
  const err = (message: string, at = pos) => errors.push({ message, pos: at })
  const readName = () => {
    NAME_RE.lastIndex = pos
    const m = NAME_RE.exec(s)
    if (!m) return undefined
    pos += m[0].length
    return m[0]
  }
  const skipBlanks = () => {
    const from = pos
    while (isBlank(s[pos])) pos++
    return pos - from
  }

  /** One reference: '&...;'. Returns its text, or stops the parse. */
  const readReference = (): string => {
    if (s[pos + 1] === '#') {
      const hex = s[pos + 2] === 'x'
      pos += hex ? 3 : 2
      let val = 0
      let bad = false
      while (pos < s.length && s[pos] !== ';') {
        const c = s[pos]
        const digit = hex ? parseInt(c, 16) : c >= '0' && c <= '9' ? Number(c) : NaN
        if (Number.isNaN(digit) || (hex && !/[0-9a-fA-F]/.test(c))) {
          err(hex ? 'CharRef: invalid hexadecimal value' : 'CharRef: invalid decimal value')
          val = 0
          bad = true
          break
        }
        val = Math.min(val * (hex ? 16 : 10) + digit, 0x110000)
        pos++
      }
      if (s[pos] === ';') pos++
      if (val >= 0x110000) err('xmlParseCharRef: character reference out of bounds')
      else if (!isXmlChar(val)) err(`xmlParseCharRef: invalid xmlChar value ${val}`)
      else if (!bad) return String.fromCodePoint(val)
      throw new XmlStop('bad content')
    }
    pos++
    const name = readName()
    if (!name) {
      err('xmlParseEntityRef: no name')
      throw new XmlStop('unbalanced elements')
    }
    if (s[pos] !== ';') {
      err("EntityRef: expecting ';'")
      throw new XmlStop('unbalanced elements')
    }
    pos++
    if (name in PREDEFINED) return PREDEFINED[name]
    err(`Entity '${name}' not defined`)
    throw new XmlStop('bad content')
  }

  const readStartTag = () => {
    const tagStart = pos
    pos++
    const name = readName()
    if (!name) {
      err('StartTag: invalid element name')
      throw new XmlStop('bad content')
    }
    const seen = new Set<string>()
    let failed = false
    skipBlanks()
    while (pos < s.length && s[pos] !== '>' && !(s[pos] === '/' && s[pos + 1] === '>')) {
      const attr = readName()
      if (!attr) {
        err('error parsing attribute name')
        err('attributes construct error')
        failed = true
        break
      }
      skipBlanks()
      if (s[pos] !== '=') {
        err(`Specification mandates value for attribute ${attr}`)
        failed = true
      } else {
        pos++
        skipBlanks()
        const quote = s[pos]
        let ok = false
        if (quote !== '"' && quote !== "'") {
          err('AttValue: " or \' expected')
        } else {
          pos++
          while (pos < s.length && s[pos] !== quote) {
            if (s[pos] === '<') {
              err("Unescaped '<' not allowed in attributes values")
              break
            }
            if (s[pos] === '&') readReference()
            else pos++
          }
          if (s[pos] === quote) {
            pos++
            ok = true
          } else if (pos >= s.length) {
            err("AttValue: ' expected")
          }
        }
        if (!ok) {
          err('attributes construct error')
          failed = true
          break
        }
        if (seen.has(attr)) {
          err(`Attribute ${attr} redefined`)
          failed = true
        }
        seen.add(attr)
      }
      if (s[pos] === '>' || (s[pos] === '/' && s[pos + 1] === '>')) break
      if (skipBlanks() === 0) {
        err('attributes construct error')
        failed = true
        break
      }
    }
    if (s[pos] === '/' && s[pos + 1] === '>') {
      pos += 2
    } else if (s[pos] === '>') {
      pos++
      stack.push({ name, line: lineAt(tagStart), textStart: text.length })
    } else {
      err(`Couldn't find end of Start Tag ${name}`)
      failed = true
    }
    if (failed) throw new XmlStop('bad content')
  }

  const readEndTag = () => {
    pos += 2
    const open = stack[stack.length - 1]
    let name: string | undefined
    if (open && s.startsWith(open.name, pos) && (s[pos + open.name.length] === '>' || isBlank(s[pos + open.name.length]))) {
      pos += open.name.length
      name = open.name
    } else {
      name = readName()
    }
    skipBlanks()
    let failed = false
    if (s[pos] !== '>') {
      err("expected '>'")
      failed = true
    } else {
      pos++
    }
    if (name !== open?.name) {
      err(`Opening and ending tag mismatch: ${open?.name} line ${open?.line} and ${name ?? 'unparsable'}`)
      failed = true
    }
    if (failed) throw new XmlStop('bad content')
    stack.pop()
    if (STYLE_TAGS.has(name!) && text.length > open!.textStart) {
      styles.push({ type: name as OmniboxStyleType, offset: open!.textStart, length: text.length - open!.textStart })
    }
    if (!stack.length) rootClosed = true
  }

  const readCharData = () => {
    while (pos < s.length && s[pos] !== '<' && s[pos] !== '&') {
      if (s[pos] === ']' && s.startsWith(']]>', pos)) {
        err("Sequence ']]>' not allowed in content", pos + 1)
        throw new XmlStop('bad content')
      }
      const cp = s.codePointAt(pos)!
      if (!isXmlChar(cp)) {
        err(`PCDATA invalid Char value ${cp}`)
        throw new XmlStop('bad content')
      }
      const ch = String.fromCodePoint(cp)
      if (!rootClosed) text += ch
      else if (!isBlank(ch)) {
        err('Extra content at the end of the document')
        throw new XmlStop('bad content')
      }
      pos += ch.length
    }
  }

  let stop: XmlStop | undefined
  try {
    while (pos < s.length) {
      if (s.startsWith('<!--', pos)) {
        const end = s.indexOf('-->', pos + 4)
        if (end < 0) {
          err('Comment not terminated', s.length)
          throw new XmlStop('unbalanced elements')
        }
        pos = end + 3
      } else if (s.startsWith('<![CDATA[', pos)) {
        if (rootClosed) {
          err('Extra content at the end of the document')
          throw new XmlStop('bad content')
        }
        const begin = pos + 9
        const end = s.indexOf(']]>', begin)
        if (end < 0) {
          const rest = s.slice(begin)
          err(`CData section not finished\n${rest.slice(0, Math.max(0, Math.min(50, rest.length - 2)))}`, s.length)
          throw new XmlStop('unbalanced elements')
        }
        text += s.slice(begin, end)
        pos = end + 3
      } else if (s.startsWith('<?', pos)) {
        const end = s.indexOf('?>', pos + 2)
        pos += 2
        const target = readName()
        if (end < 0) {
          err(`ParsePI: PI ${target ?? ''} never end ...`, s.length)
          throw new XmlStop('bad content')
        }
        pos = end + 2
      } else if (s.startsWith('</', pos)) {
        if (rootClosed) {
          err('Extra content at the end of the document')
          throw new XmlStop('bad content')
        }
        readEndTag()
      } else if (s[pos] === '<') {
        if (rootClosed) {
          err('Extra content at the end of the document')
          throw new XmlStop('bad content')
        }
        readStartTag()
      } else if (s[pos] === '&') {
        if (rootClosed) {
          err('Extra content at the end of the document')
          throw new XmlStop('bad content')
        }
        text += readReference()
      } else {
        readCharData()
      }
    }
  } catch (e) {
    if (!(e instanceof XmlStop)) throw e
    stop = e
  }

  if (stop || errors.length) {
    const source = Buffer.from(s, 'utf8')
    const report = errors
      .map((e) => formatXmlError(source, lineAt(e.pos), e.message, Buffer.byteLength(s.slice(0, e.pos), 'utf8')))
      .join('')
      .replace(/[ \n^]+$/, '')
    throw new Error(`Invalid XML: ${stop?.kind ?? 'bad content'}: ${report}`)
  }
  styles.sort((a, b) => a.offset - b.offset)
  return { text, styles }
}

// ---------------------------------------------------------------- API

const DEFAULT_SUGGEST: ArgSpec = {
  type: 'object',
  ref: 'omnibox.DefaultSuggestResult',
  properties: {
    description: { type: 'string', minLength: 1 },
    descriptionStyles: { type: 'array', items: { type: 'object', additionalProperties: true }, optional: true },
  },
}
const SUGGEST: ArgSpec = {
  type: 'object',
  ref: 'omnibox.SuggestResult',
  properties: {
    content: { type: 'string' },
    description: { type: 'string' },
    deletable: { type: 'boolean', optional: true },
    descriptionStyles: { type: 'array', items: { type: 'object', additionalProperties: true }, optional: true },
    actions: { type: 'array', items: { type: 'object', additionalProperties: true }, optional: true },
  },
}
const SET_DEFAULT_SIG =
  'omnibox.setDefaultSuggestion(omnibox.DefaultSuggestResult suggestion, optional function callback)'
const SEND_SIG = 'omnibox.sendSuggestions(integer requestId, array suggestResults)'

const STATE_NS = 'omnibox'
const MAX_SUGGESTIONS = 100
/** Chrome sets none; the description is kept in the session's state file. */
const MAX_DESCRIPTION = 64 * 1024
const DEFAULT_WAIT_MS = 5_000
const DISPOSITIONS: OmniboxDisposition[] = ['currentTab', 'newForegroundTab', 'newBackgroundTab']

interface Pending {
  requestId: number
  resolve: (suggestions: OmniboxSuggestion[]) => void
  timer: NodeJS.Timeout
}

/**
 * chrome.omnibox: an extension's keyword in the host's address bar. The host
 * drives it through ElectronChromeExtensions (getOmniboxKeywords,
 * omniboxInputStarted, omniboxInputChanged, ...), and this sends the
 * extension the events Chrome sends and hands back its suggestions.
 */
export class OmniboxAPI {
  private nextRequestId = 1
  private pending = new Map<string, Pending>()
  private saveTimer?: NodeJS.Timeout
  private queues = new Map<string, Promise<void>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('omnibox.setDefaultSuggestion', this.setDefaultSuggestion.bind(this), { permission: null })
    handle('omnibox.sendSuggestions', this.sendSuggestions.bind(this), { permission: null })
  }

  /** The omnibox API is there only for an extension whose manifest has an omnibox keyword. */
  private keywordOf(extension: Electron.Extension | undefined) {
    const keyword = (extension?.manifest as any)?.omnibox?.keyword
    return typeof keyword === 'string' && keyword.trim() ? keyword.trim() : undefined
  }

  private requireKeyword(event: ExtensionEvent, method: string) {
    if (!this.keywordOf(event.extension as any)) {
      throw new Error(`'omnibox.${method}' requires the 'omnibox' manifest key.`)
    }
  }

  private extension(extensionId: string): Electron.Extension | undefined {
    const sessionExtensions: any = this.ctx.session.extensions || this.ctx.session
    return sessionExtensions.getExtension?.(extensionId) ?? undefined
  }

  private async setDefaultSuggestion(event: ExtensionEvent, ...args: any[]) {
    this.requireKeyword(event, 'setDefaultSuggestion')
    const [suggestion] = checkArgs(SET_DEFAULT_SIG, [{ name: 'suggestion', spec: DEFAULT_SUGGEST }], args) as [
      { description: string },
    ]
    if (suggestion.description.length > MAX_DESCRIPTION) throw new Error('Description is too long.')
    const parsed = parseOmniboxDescription(suggestion.description)
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<Record<string, { description: string }>>(STATE_NS, {})
    if (saved[event.extension.id]?.description !== suggestion.description) {
      this.ctx.stateStore.setNamespace(STATE_NS, { ...saved, [event.extension.id]: { description: suggestion.description } })
      // Extensions often set it on every key press: write it once they stop.
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => {
          this.saveTimer = undefined
          void this.ctx.stateStore.flush().catch((error) => console.error('Failed to save omnibox state:', error))
        }, 1000)
        this.saveTimer.unref?.()
      }
    }
    this.ctx.emit('omnibox-default-suggestion', {
      extensionId: event.extension.id,
      description: parsed.text,
      descriptionStyles: parsed.styles,
    })
  }

  private sendSuggestions(event: ExtensionEvent, ...args: any[]) {
    this.requireKeyword(event, 'sendSuggestions')
    const [requestId, results] = checkArgs(
      SEND_SIG,
      [
        { name: 'requestId', spec: { type: 'integer' } },
        { name: 'suggestResults', spec: { type: 'array', items: SUGGEST } },
      ],
      args,
    ) as [number, Array<{ content: string; description: string; deletable?: boolean }>]
    const pending = this.pending.get(event.extension.id)
    // Suggestions for input the person has moved on from are dropped, as in Chrome.
    if (!pending || pending.requestId !== requestId) return
    const suggestions = results.slice(0, MAX_SUGGESTIONS).map((r) => {
      const parsed = parseOmniboxDescription(r.description)
      return {
        content: r.content,
        description: parsed.text,
        descriptionStyles: parsed.styles,
        deletable: r.deletable === true,
      }
    })
    this.settle(event.extension.id, suggestions)
  }

  private settle(extensionId: string, suggestions: OmniboxSuggestion[]) {
    const pending = this.pending.get(extensionId)
    if (!pending) return
    this.pending.delete(extensionId)
    clearTimeout(pending.timer)
    pending.resolve(suggestions)
  }

  /**
   * Sends an event, in order, once the extension's worker can take it. Right
   * after an extension loads, its worker adds its listeners while it is still
   * installing; the router's delivery then fails to start it and holds every
   * event back for 30 seconds. Waiting until the worker starts avoids that.
   */
  private send(extensionId: string, eventName: string, args: any[]) {
    const previous = this.queues.get(extensionId) ?? Promise.resolve()
    const next = previous
      .then(() => this.whenWorkerReady(extensionId))
      .then(() => this.ctx.router.sendEventWhenListening(extensionId, eventName, args, 10_000))
      .catch(() => {})
    this.queues.set(extensionId, next)
    void next.then(() => {
      if (this.queues.get(extensionId) === next) this.queues.delete(extensionId)
    })
  }

  private async whenWorkerReady(extensionId: string) {
    const background = (this.extension(extensionId)?.manifest as any)?.background
    const workers = (this.ctx.session as any).serviceWorkers
    if (!background?.service_worker || typeof workers?.startWorkerForScope !== 'function') return
    for (let tries = 0; tries < 20; tries++) {
      try {
        // Returns at once for a running worker.
        await workers.startWorkerForScope(`chrome-extension://${extensionId}/`)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  private checkHostExtension(extensionId: string) {
    const extension = this.extension(extensionId)
    if (!extension || !this.keywordOf(extension)) {
      throw new Error(`Extension ${extensionId} has no omnibox keyword`)
    }
    return extension
  }

  // ------------------------------------------------------------ for the host

  getKeywords(): OmniboxKeyword[] {
    const sessionExtensions: any = this.ctx.session.extensions || this.ctx.session
    const list: Electron.Extension[] = sessionExtensions.getAllExtensions?.() || []
    const out: OmniboxKeyword[] = []
    for (const extension of list) {
      const keyword = this.keywordOf(extension)
      if (keyword) out.push({ extensionId: extension.id, keyword, name: extension.name })
    }
    return out
  }

  async getDefaultSuggestion(extensionId: string): Promise<{ description: string; descriptionStyles: OmniboxDescriptionStyle[] } | undefined> {
    this.checkHostExtension(extensionId)
    await this.ctx.stateStore.whenHydrated()
    const saved = this.ctx.stateStore.getNamespace<Record<string, { description: string }>>(STATE_NS, {})[extensionId]
    if (!saved || typeof saved.description !== 'string') return undefined
    try {
      const parsed = parseOmniboxDescription(saved.description)
      return { description: parsed.text, descriptionStyles: parsed.styles }
    } catch {
      return undefined
    }
  }

  inputStarted(extensionId: string) {
    this.checkHostExtension(extensionId)
    this.send(extensionId, 'omnibox.onInputStarted', [])
  }

  /**
   * Sends the text typed after the keyword and resolves with the
   * extension's suggestions: an empty list when it gives none within
   * `timeoutMs`, or when newer input replaces this one.
   */
  inputChanged(extensionId: string, text: string, timeoutMs = DEFAULT_WAIT_MS): Promise<OmniboxSuggestion[]> {
    this.checkHostExtension(extensionId)
    if (typeof text !== 'string') throw new TypeError('text must be a string')
    this.settle(extensionId, [])
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(extensionId, []), Math.max(0, timeoutMs))
      timer.unref?.()
      this.pending.set(extensionId, { requestId, resolve, timer })
      this.send(extensionId, 'omnibox.onInputChanged', [text, requestId])
    })
  }

  inputEntered(extensionId: string, text: string, disposition: OmniboxDisposition = 'currentTab') {
    this.checkHostExtension(extensionId)
    if (typeof text !== 'string') throw new TypeError('text must be a string')
    if (!DISPOSITIONS.includes(disposition)) throw new TypeError(`Unknown disposition: ${disposition}`)
    this.settle(extensionId, [])
    // Pressing Enter is a user gesture for the extension, as in Chrome.
    this.ctx.store.noteUserGesture(extensionId)
    this.send(extensionId, 'omnibox.onInputEntered', [text, disposition])
  }

  inputCancelled(extensionId: string) {
    this.checkHostExtension(extensionId)
    this.settle(extensionId, [])
    this.send(extensionId, 'omnibox.onInputCancelled', [])
  }

  deleteSuggestion(extensionId: string, text: string) {
    this.checkHostExtension(extensionId)
    if (typeof text !== 'string') throw new TypeError('text must be a string')
    this.send(extensionId, 'omnibox.onDeleteSuggestion', [text])
  }
}
