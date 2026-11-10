export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type CopyLimits = {
  maxDepth: number
  maxNodes: number
  maxBytes: number
}
export const DESCRIPTOR_LIMITS: CopyLimits = {
  maxDepth: 16,
  maxNodes: 10_000,
  maxBytes: 256 * 1024,
}
export const RESULT_LIMITS: CopyLimits = {
  maxDepth: 16,
  maxNodes: 50_000,
  maxBytes: 4 * 1024 * 1024,
}

export class UnsafeValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeValueError'
  }
}

/**
 * Reads a member without running provider code: own or inherited data
 * properties only, never an accessor. This avoids getters; it cannot detect a
 * Proxy, which is outside what an in-process host can contain.
 */
export function readDataMember(
  object: object,
  key: string | symbol,
  maxPrototypeDepth = 8,
): unknown {
  let current: object | null = object
  for (let depth = 0; current && depth <= maxPrototypeDepth; depth++) {
    if (current === Object.prototype || current === Function.prototype) break
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      if (!('value' in descriptor))
        throw new UnsafeValueError(`accessor member: ${String(key)}`)
      return descriptor.value
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

/**
 * Lossless plain-JSON copy. Rejects anything that is not exactly JSON:
 * accessors, Symbol keys, functions (including toJSON), class instances,
 * cycles, sparse arrays, non-finite numbers, and values over the limits.
 * Nothing is truncated or substituted, so the copy is safe to digest.
 */
export function copyJson(value: unknown, limits: CopyLimits): JsonValue {
  let nodes = 0
  let bytes = 0
  const seen = new Set<object>()
  const spend = (amount: number) => {
    bytes += amount
    if (++nodes > limits.maxNodes) throw new UnsafeValueError('too many nodes')
    if (bytes > limits.maxBytes) throw new UnsafeValueError('value too large')
  }
  const copy = (input: unknown, depth: number): JsonValue => {
    if (depth > limits.maxDepth) throw new UnsafeValueError('value too deep')
    if (input === null || typeof input === 'boolean') {
      spend(5)
      return input
    }
    if (typeof input === 'string') {
      spend(input.length * 3 + 2)
      return input
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new UnsafeValueError('non-finite number')
      spend(24)
      return input
    }
    if (typeof input !== 'object')
      throw new UnsafeValueError(`unsupported ${typeof input} value`)
    if (seen.has(input)) throw new UnsafeValueError('cyclic value')
    seen.add(input)
    spend(2)
    const keys = Reflect.ownKeys(input)
    let result: JsonValue
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype)
        throw new UnsafeValueError('array subclass')
      const length = input.length
      if (keys.length !== length + 1)
        throw new UnsafeValueError('sparse or decorated array')
      const items: JsonValue[] = []
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index)
        if (!descriptor || !('value' in descriptor))
          throw new UnsafeValueError('array accessor or hole')
        items.push(copy(descriptor.value, depth + 1))
      }
      result = items
    } else {
      const prototype = Object.getPrototypeOf(input) as object | null
      if (prototype !== Object.prototype && prototype !== null)
        throw new UnsafeValueError('non-plain object')
      const record: Record<string, JsonValue> = {}
      for (const key of keys) {
        if (typeof key !== 'string') throw new UnsafeValueError('symbol key')
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (!descriptor || !('value' in descriptor))
          throw new UnsafeValueError(`accessor property: ${key}`)
        if (!descriptor.enumerable)
          throw new UnsafeValueError(`hidden property: ${key}`)
        spend(key.length * 3 + 3)
        Object.defineProperty(record, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      result = record
    }
    seen.delete(input)
    return result
  }
  return copy(value, 0)
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
