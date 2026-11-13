/**
 * Checks the arguments of a call the way Chrome's bindings do, with Chrome's
 * messages ("Error in invocation of ...: Error at parameter 'x': ..."). Chrome
 * checks in the renderer; the shell checks again in the main process, since
 * nothing a page sends can be trusted.
 */
export type ArgSpec = (
  | { type: 'string'; minLength?: number; maxLength?: number; enum?: readonly string[] }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'number'; minimum?: number }
  | { type: 'boolean' }
  | {
      type: 'object'
      properties?: Record<string, ArgSpec>
      additionalProperties?: boolean
      /** Chrome's name for the type, as in "expected omnibox.SuggestResult". */
      ref?: string
    }
  | { type: 'array'; items: ArgSpec; minItems?: number; maxItems?: number }
  | { type: 'any' }
  | { choices: ArgSpec[] }
) & { optional?: boolean }

export interface ParamSpec {
  name: string
  spec: ArgSpec
}

const isInt32 = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647

/** Chrome's name for the type of a value, as in "found integer". */
export const typeName = (v: unknown): string => {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (isInt32(v)) return 'integer'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'string') return 'string'
  if (Array.isArray(v)) return 'array'
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return 'binary'
  if (typeof v === 'function') return 'function'
  return 'object'
}

const specTypeName = (spec: ArgSpec) =>
  'choices' in spec ? 'choices' : spec.type === 'object' && spec.ref ? spec.ref : spec.type

/** The quick check Chrome makes to pair arguments with parameters. */
const isCorrectType = (spec: ArgSpec, v: unknown): boolean => {
  if ('choices' in spec) return spec.choices.some((c) => isCorrectType(c, v))
  switch (spec.type) {
    case 'integer':
      return isInt32(v) || Object.is(v, -0)
    case 'number':
      return typeof v === 'number'
    case 'boolean':
      return typeof v === 'boolean'
    case 'string':
      return typeof v === 'string'
    case 'object':
      return !!v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)
    case 'array':
      return Array.isArray(v)
    case 'any':
      return v !== undefined
  }
}

/** Returns Chrome's message for a value that does not fit, or undefined. */
export const checkValue = (spec: ArgSpec, v: unknown): string | undefined => {
  if ('choices' in spec) {
    return spec.choices.some((c) => checkValue(c, v) === undefined)
      ? undefined
      : 'Value did not match any choice.'
  }
  if (!isCorrectType(spec, v)) {
    return `Invalid type: expected ${specTypeName(spec)}, found ${typeName(v)}.`
  }
  switch (spec.type) {
    case 'string': {
      const s = v as string
      if (spec.enum && !spec.enum.includes(s)) return `Value must be one of ${spec.enum.join(', ')}.`
      if (spec.minLength !== undefined && s.length < spec.minLength) {
        return `String must have at least ${spec.minLength} characters; found ${s.length}.`
      }
      if (spec.maxLength !== undefined && s.length > spec.maxLength) {
        return `String must have at most ${spec.maxLength} characters; found ${s.length}.`
      }
      return undefined
    }
    case 'integer':
    case 'number': {
      const n = v as number
      if (spec.minimum !== undefined && n < spec.minimum) return `Value must be at least ${spec.minimum}.`
      if (spec.type === 'integer' && spec.maximum !== undefined && n > spec.maximum) {
        return `Value must be at most ${spec.maximum}.`
      }
      return undefined
    }
    case 'array': {
      const list = v as unknown[]
      if (spec.minItems !== undefined && list.length < spec.minItems) {
        return `Array must have at least ${spec.minItems} items; found ${list.length}.`
      }
      if (spec.maxItems !== undefined && list.length > spec.maxItems) {
        return `Array must have at most ${spec.maxItems} items; found ${list.length}.`
      }
      for (let i = 0; i < list.length; i++) {
        const error = checkValue(spec.items, list[i])
        if (error) return `Error at index ${i}: ${error}`
      }
      return undefined
    }
    case 'object': {
      if (!spec.properties) return undefined
      const obj = v as Record<string, unknown>
      const seen = new Set<string>()
      // Own properties first, in the object's order, then the required ones
      // missing, in name order: the order Chrome reports them in.
      for (const key of Object.keys(obj)) {
        const prop = Object.prototype.hasOwnProperty.call(spec.properties, key) ? spec.properties[key] : undefined
        if (!prop) {
          if (spec.additionalProperties) continue
          return `Unexpected property: '${key}'.`
        }
        seen.add(key)
        const value = obj[key]
        if (value === null || value === undefined) {
          if (!prop.optional) return `Missing required property '${key}'.`
          continue
        }
        const error = checkValue(prop, value)
        if (error) return `Error at property '${key}': ${error}`
      }
      for (const key of Object.keys(spec.properties).sort()) {
        if (!spec.properties[key].optional && !seen.has(key)) return `Missing required property '${key}'.`
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Pairs arguments with parameters, skipping optional ones whose type does not
 * fit, as Chrome's bindings do. Returns the argument for each parameter, or
 * undefined when no pairing works ("No matching signature.").
 */
const resolve = (params: ParamSpec[], args: unknown[], pi = 0, ai = 0): unknown[] | undefined => {
  if (pi === params.length) {
    // Extra arguments match only if they are all undefined.
    return args.slice(ai).every((a) => a === undefined) ? [] : undefined
  }
  const param = params[pi]
  const arg = args[ai]
  if (ai < args.length && arg !== undefined && arg !== null && isCorrectType(param.spec, arg)) {
    const rest = resolve(params, args, pi + 1, ai + 1)
    if (rest) return [arg, ...rest]
  }
  if (param.spec.optional) {
    // An undefined or null argument stands for the optional parameter.
    const skip = ai < args.length && (arg === undefined || arg === null) ? 1 : 0
    const rest = resolve(params, args, pi + 1, ai + skip)
    if (rest) return [undefined, ...rest]
  }
  return undefined
}

/**
 * Throws Chrome's invocation error when the arguments do not fit, and
 * returns them paired with the parameters otherwise.
 *
 * @param signature as Chrome prints it, e.g.
 *   'history.addUrl(history.UrlDetails details, optional function callback)'
 */
export function checkArgs(signature: string, params: ParamSpec[], args: unknown[]): unknown[] {
  const fail = (message: string): never => {
    throw new Error(`Error in invocation of ${signature}: ${message}`)
  }
  const resolved = resolve(params, args)
  if (!resolved) return fail('No matching signature.')
  params.forEach((param, i) => {
    const value = resolved[i]
    if (value === undefined) return
    const error = checkValue(param.spec, value)
    if (error) fail(`Error at parameter '${param.name}': ${error}`)
  })
  return resolved
}

/** Sends an event to every loaded extension that holds `permission`. */
export function sendToPermitted(
  ctx: {
    session: Electron.Session
    router: { sendEvent(extensionId: string, eventName: string, ...args: any[]): void }
    permissions: { has(extension: Electron.Extension, permission: string): boolean }
  },
  permission: string | string[],
  eventName: string,
  ...args: any[]
) {
  const anyOf = Array.isArray(permission) ? permission : [permission]
  const sessionExtensions: any = ctx.session.extensions || ctx.session
  const list: Electron.Extension[] = sessionExtensions.getAllExtensions?.() || []
  for (const extension of list) {
    if (anyOf.some((p) => ctx.permissions.has(extension, p))) {
      ctx.router.sendEvent(extension.id, eventName, ...args)
    }
  }
}

/** URL parse that never throws. */
export const tryParseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/** Chrome refuses URLs longer than this anywhere a URL crosses processes. */
export const MAX_URL_LENGTH = 2 * 1024 * 1024
