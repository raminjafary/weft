import type { FlagPort, FlagValue, RequestFacts } from '@weftjs/kernel'

/** A flag is a graph partition rather than a runtime `if`. See `spec/kernel/ports.md`: `axes()` is not optional. */
export interface StaticFlagsOptions {
  /** Flag to every value it can take. The first entry is the default. */
  axes: Record<string, FlagValue[]>
  /** Optional per-request bucketing. Whatever it returns must be one of the declared values. */
  bucket?(flag: string, request: RequestFacts): FlagValue | undefined
}

/** A flag refusal: an undeclared flag, or a bucket that returned a value off the axis. */
export class FlagError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'FlagError'
    this.code = code
  }
}

/** Flags from a declared axis set: an undeclared flag is a build error, not a silent dead branch. */
export function staticFlags(options: StaticFlagsOptions): FlagPort {
  return {
    name: 'static',
    axes: () => options.axes,
    resolve(flag, request) {
      const values = options.axes[flag]
      if (!values?.length) {
        throw new FlagError(
          'E_UNKNOWN_FLAG',
          `${flag} has no declared axis, so its variants cannot be enumerated`,
        )
      }
      const chosen = options.bucket?.(flag, request)
      if (chosen === undefined) return values[0] as FlagValue
      if (!values.includes(chosen)) {
        throw new FlagError(
          'E_FLAG_OFF_AXIS',
          `${flag} resolved to ${String(chosen)}, which is not one of its declared values (${values.join(', ')})`,
        )
      }
      return chosen
    },
  }
}

/** Every reachable combination of the declared axes. What the plan is partitioned over. */
export function permutations(axes: Record<string, FlagValue[]>): Record<string, FlagValue>[] {
  const names = Object.keys(axes).sort()
  let out: Record<string, FlagValue>[] = [{}]
  for (const name of names) {
    const values = axes[name] ?? []
    const next: Record<string, FlagValue>[] = []
    for (const base of out) {
      for (const value of values) next.push(Object.assign({}, base, { [name]: value }))
    }
    out = next
  }
  return out
}
