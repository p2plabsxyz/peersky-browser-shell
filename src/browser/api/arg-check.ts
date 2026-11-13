/**
 * A small copy of how Chrome's bindings check the arguments of an API call
 * against its schema, with Chrome's own error messages. Chrome checks them in
 * the renderer before anything reaches the browser; here the main process
 * checks them, because a page could send anything over IPC.
 */

export type ArgSpec =
  | { type: 'any'; optional?: boolean }
  | { type: 'boolean'; optional?: boolean }
  | { type: 'integer'; optional?: boolean }
  | { type: 'number'; optional?: boolean }
  | { type: 'string'; optional?: boolean; enum?: readonly string[]; ref?: string }
  | { type: 'array'; optional?: boolean; items: ArgSpec; minItems?: number; ref?: string }
  | {
      type: 'object'
      optional?: boolean
      properties?: Record<string, ArgSpec>
      /** Any other property is allowed, as with `additionalProperties`. */
      open?: boolean
      ref?: string
    }

/** The name Chrome gives a value's type in "found X". */
export const typeOf = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) <= 0x7fffffff ? 'integer' : 'number'
  }
  if (typeof value === 'object') {
    // Typed arrays and buffers arrive as binary.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return 'binary'
    return 'object'
  }
  return typeof value
}

const expected = (spec: ArgSpec) => ('ref' in spec && spec.ref) || spec.type

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)

/** Returns Chrome's error for `value`, or undefined when it fits `spec`. */
export function checkValue(spec: ArgSpec, value: unknown, depth = 0): string | undefined {
  // Nothing an extension sends needs to be this deep; refusing keeps a hostile
  // value from costing the main process much.
  if (depth > 32) return 'Invalid invocation'
  const found = typeOf(value)
  const mismatch = () => `Invalid type: expected ${expected(spec)}, found ${found}.`
  switch (spec.type) {
    case 'any':
      return value === undefined ? mismatch() : undefined
    case 'boolean':
      return typeof value === 'boolean' ? undefined : mismatch()
    case 'integer':
      return found === 'integer' ? undefined : mismatch()
    case 'number':
      if (typeof value !== 'number') return mismatch()
      return Number.isFinite(value) ? undefined : 'Value must be a finite number.'
    case 'string':
      if (typeof value !== 'string') return mismatch()
      if (spec.enum && !spec.enum.includes(value)) {
        return `Value must be one of ${[...spec.enum].sort().join(', ')}.`
      }
      return undefined
    case 'array': {
      if (!Array.isArray(value)) return mismatch()
      if (typeof spec.minItems === 'number' && value.length < spec.minItems) {
        return `Array must have at least ${spec.minItems} items; found ${value.length}.`
      }
      for (let i = 0; i < value.length; i++) {
        const error = checkValue(spec.items, value[i], depth + 1)
        if (error) return `Error at index ${i}: ${error}`
      }
      return undefined
    }
    case 'object': {
      if (!isPlainObject(value)) return mismatch()
      const properties = spec.properties || {}
      const seen = new Set<string>()
      for (const key of Object.keys(value)) {
        const propertySpec = Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined
        if (!propertySpec) {
          if (spec.open) continue
          return `Unexpected property: '${key}'.`
        }
        const propertyValue = value[key]
        if (propertyValue === undefined || propertyValue === null) {
          if (!propertySpec.optional) return `Missing required property '${key}'.`
          continue
        }
        seen.add(key)
        const error = checkValue(propertySpec, propertyValue, depth + 1)
        if (error) return `Error at property '${key}': ${error}`
      }
      for (const key of Object.keys(properties).sort()) {
        if (!properties[key].optional && !seen.has(key)) return `Missing required property '${key}'.`
      }
      return undefined
    }
  }
}

export interface ParamSpec {
  name: string
  spec: ArgSpec
}

const describeParam = ({ name, spec }: ParamSpec) =>
  `${spec.optional ? 'optional ' : ''}${expected(spec)} ${name}`

/**
 * The text Chrome puts in front of a bad call, such as
 * "Error in invocation of fontSettings.getFont(object details, optional function callback): ".
 */
export const invocationPrefix = (fullName: string, params: ParamSpec[], hasCallback = true) =>
  `Error in invocation of ${fullName}(${[
    ...params.map(describeParam),
    ...(hasCallback ? ['optional function callback'] : []),
  ].join(', ')}): `

/**
 * Checks a call's arguments (the callback already taken off) and throws
 * Chrome's error when they do not fit.
 */
export function checkArgs(fullName: string, params: ParamSpec[], args: unknown[], hasCallback = true) {
  const error = argsError(params, args)
  if (error) throw new Error(invocationPrefix(fullName, params, hasCallback) + error)
}

/** Chrome's error for a call's arguments, without the prefix. */
export function argsError(params: ParamSpec[], args: unknown[]): string | undefined {
  // Trailing undefined arguments are as if left out.
  let count = args.length
  while (count > 0 && args[count - 1] === undefined) count--
  if (count > params.length) return 'No matching signature.'
  for (let i = 0; i < params.length; i++) {
    const { name, spec } = params[i]
    const value = i < count ? args[i] : undefined
    if (value === undefined || value === null) {
      if (!spec.optional) return 'No matching signature.'
      continue
    }
    // A value of the wrong kind cannot be this parameter at all.
    if (!fitsKind(spec, value)) return 'No matching signature.'
    const error = checkValue(spec, value)
    if (error) return `Error at parameter '${name}': ${error}`
  }
  return undefined
}

const fitsKind = (spec: ArgSpec, value: unknown) => {
  switch (spec.type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
    case 'number':
      return typeof value === 'number'
    default:
      return true
  }
}

/** Caps a string an extension sends, so one call cannot store megabytes. */
export const MAX_STRING = 4096
