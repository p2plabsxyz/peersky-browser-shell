import vm from 'node:vm'

// Extensions' regular expressions run in the main process. Chrome uses RE2,
// which cannot backtrack; JavaScript's engine can, without end, and the whole
// browser waits while it does. A guarded expression is tested under a time
// limit, and each extension has a budget of regex time per window: past it,
// its expressions match nothing until the next window. One that hits the limit
// once turns them all off for good.
const REGEX_TIMEOUT_MS = 50
const REGEX_BUDGET_MS = 200
const REGEX_WINDOW_MS = 10_000

const regexContext = vm.createContext({})
const testScript = new vm.Script('__re.test(__input)')
const execScript = new vm.Script('__re.exec(__input)')

/** How much regex time one extension has used. */
export interface RegexBudget {
  windowStart: number
  spentMs: number
  dead: boolean
}

export const newRegexBudget = (): RegexBudget => ({ windowStart: Date.now(), spentMs: 0, dead: false })

/** A regular expression from an extension, tested under a time limit. */
export class GuardedRegExp {
  constructor(
    private re: RegExp,
    private budget: RegexBudget,
    private api = 'An extension',
  ) {}

  get source() {
    return this.re.source
  }

  test(input: string): boolean {
    return this.run(testScript, input) === true
  }

  /** Like RegExp#exec, null when it does not match or ran out of time. */
  exec(input: string): RegExpExecArray | null {
    return (this.run(execScript, input) as RegExpExecArray | null | undefined) ?? null
  }

  private run(script: vm.Script, input: string): unknown {
    const budget = this.budget
    if (budget.dead) return undefined
    const now = Date.now()
    if (now - budget.windowStart > REGEX_WINDOW_MS) {
      budget.windowStart = now
      budget.spentMs = 0
    }
    const left = REGEX_BUDGET_MS - budget.spentMs
    if (left <= 0) return undefined
    const ctx = regexContext as any
    ctx.__re = this.re
    ctx.__input = input
    const started = process.hrtime.bigint()
    try {
      return script.runInContext(regexContext, { timeout: Math.max(1, Math.min(REGEX_TIMEOUT_MS, Math.ceil(left))) })
    } catch {
      if (left >= REGEX_TIMEOUT_MS) {
        budget.dead = true
        console.warn(`${this.api}: the regular expression ${this.re.source} took too long; this extension's are no longer tested`)
      }
      return undefined
    } finally {
      budget.spentMs += Number(process.hrtime.bigint() - started) / 1e6
      ctx.__re = undefined
      ctx.__input = undefined
    }
  }
}

const isRepeat = (quantifier: string) => quantifier !== '?' && !/^\{(\d+)(,\1)?\}$/.test(quantifier) && !/^\{[01]\}$/.test(quantifier)

/**
 * Whether a pattern could backtrack for long: a repeated group that holds a
 * repetition or an alternative, as in (a+)+ or (a|aa)*, or many unbounded
 * repetitions in a row, as in .*a.*b.*c.*d. Testing each one under a time
 * limit costs about a tenth of a millisecond, too much for every request, so
 * only these are.
 */
export function mayBacktrackBadly(source: string): boolean {
  // For each open group: whether its body repeats or branches.
  const groups: boolean[] = []
  let unbounded = 0
  let lastGroupRisky: boolean | null = null
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    let atom: 'group' | 'other' = 'other'
    if (c === '\\') {
      i++
    } else if (c === '[') {
      // A class is one atom; skip to its end.
      i++
      if (source[i] === '^') i++
      if (source[i] === ']') i++
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++
        i++
      }
    } else if (c === '(') {
      groups.push(false)
      lastGroupRisky = null
      continue
    } else if (c === ')') {
      const risky = groups.pop() ?? false
      lastGroupRisky = risky
      atom = 'group'
    } else if (c === '|') {
      if (groups.length) groups[groups.length - 1] = true
      continue
    }
    // A quantifier after this atom?
    const rest = source.slice(i + 1)
    const q = rest.match(/^(\*|\+|\?|\{\d+(?:,\d*)?\})\??/)
    if (!q) {
      if (atom !== 'group') lastGroupRisky = null
      continue
    }
    const quantifier = q[1]
    i += q[0].length
    const repeats = isRepeat(quantifier)
    if (quantifier === '*' || quantifier === '+' || /^\{\d+,\}$/.test(quantifier)) unbounded++
    if (atom === 'group' && repeats && lastGroupRisky) return true
    if (repeats && groups.length) groups[groups.length - 1] = true
    if (atom === 'group' && lastGroupRisky && groups.length) groups[groups.length - 1] = true
  }
  return unbounded >= 4
}
