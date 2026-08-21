import type { WireForm } from '../../ir/src/index.ts'
import type { ExceedPolicy } from '../../kernel/src/executor.ts'
import type { PolicyClass } from '../../kernel/src/cache.ts'

/**
 * The plan.
 *
 * Everything here is a declaration about *placement* — where a slot renders, when it
 * refreshes, what it may cost, which form it prefers. Nothing here can state a cache key,
 * and that absence is the enforcement: the moment a key can be hand-set it can drift from
 * what the code reads, which is the bug the whole design exists to remove. Keys are derived
 * from effects and only from effects.
 *
 * A plan is also data. It is not a function that runs, so it can be diffed in review,
 * generated from a profile, and reordered by a scheduler at runtime.
 */
export type ExecutorTarget = string

export type Condition = { all: string[] }

export const when = {
  get visible(): Condition {
    return condition('visible')
  },
  get focused(): Condition {
    return condition('focused')
  },
  get idle(): Condition {
    return condition('idle')
  },
  get always(): Condition {
    return condition('always')
  },
  hover(selector: string): Condition {
    return condition(`hover(${selector})`)
  },
}

function condition(first: string): Condition {
  return { all: [first] }
}

export function and(a: Condition, b: Condition): Condition {
  return { all: [...new Set([...a.all, ...b.all])].sort() }
}

/** `every('30s')` in milliseconds. A bare number is already milliseconds. */
export function every(spec: string | number): number {
  if (typeof spec === 'number') return spec
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(spec.trim())
  if (!match) throw new PlanError('E_BAD_DURATION', `${spec} is not a duration like '30s' or '250ms'`)
  const value = Number(match[1])
  const unit = match[2] as 'ms' | 's' | 'm' | 'h'
  return value * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]
}

export function bytes(spec: string | number): number {
  if (typeof spec === 'number') return spec
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i.exec(spec.trim())
  if (!match) throw new PlanError('E_BAD_SIZE', `${spec} is not a size like '40kb'`)
  const value = Number(match[1])
  const unit = (match[2] as string).toLowerCase() as 'b' | 'kb' | 'mb'
  return value * { b: 1, kb: 1024, mb: 1024 * 1024 }[unit]
}

export class PlanError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'PlanError'
    this.code = code
  }
}

export interface SlotBudgetSpec {
  cpuMs?: number
  jsBytes?: number
  /** A cap on regression against the base branch. A ceiling alone produces permanent silence at 39.8 KB. */
  growBytes?: number
  onExceed?: ExceedPolicy
}

export interface CacheSpec {
  class: PolicyClass
  ttlMs?: number
  staleWhileRevalidateMs?: number
  tags?: string[]
  /** Checked against the store's declared consistency at build time. */
  consistency?: 'eventual' | 'strong'
}

export interface RefreshSpec {
  everyMs: number
  when?: Condition
}

export interface FormSpec {
  prefer?: WireForm
  fallback?: WireForm
}

export interface SlotSpec {
  name: string
  /** The compiled fragment this slot renders: module and export, as the compiler names it. */
  fragment?: string
  delivery: 'stream' | 'buffered'
  prio: number
  executor: ExecutorTarget
  needs: string[]
  budget?: SlotBudgetSpec
  cache?: CacheSpec
  refresh?: RefreshSpec
  form?: FormSpec
  incremental: boolean
  speculate: boolean | 'profile'
}

export interface GuardSpec {
  name: string
  redirect?: string
  status?: number
}

/**
 * Which fragment is the document. Its slot holes are the boundaries the plan's slots fill,
 * and the two sets have to agree exactly — a declaration naming a hole the shell does not
 * have, or a hole nothing fills, is a build error rather than an empty region in production.
 */
export interface ShellSpec {
  shell: string
}

export interface Plan {
  route: string
  /** The fragment that is the document. Absent only for a plan with no slots. */
  shell?: string
  guards: GuardSpec[]
  slots: SlotSpec[]
  /**
   * The document's own policy. Per-slot `.cache()` decides what is stored; this decides what
   * the response advertises, and it is checked against the strictest class among the shell and
   * its slots rather than trusted.
   */
  cache?: CacheSpec
  /** Per-request ceiling. Forty concurrent queries from one page request will melt a database. */
  maxConcurrency: number
}

export interface SlotBuilder {
  readonly spec: SlotSpec
  fragment(id: string): SlotBuilder
  stream(options?: { prio?: number }): SlotBuilder
  buffered(): SlotBuilder
  executor(target: ExecutorTarget): SlotBuilder
  budget(spec: {
    cpu?: string | number
    js?: string | number
    grow?: string | number
    onExceed?: ExceedPolicy
  }): SlotBuilder
  cache(
    cls: PolicyClass,
    options?: {
      ttl?: string | number
      swr?: string | number
      tags?: string[]
      consistency?: 'eventual' | 'strong'
    },
  ): SlotBuilder
  refresh(everyMs: number, options?: { when?: Condition }): SlotBuilder
  form(spec: FormSpec): SlotBuilder
  /** Data dependency only. A slot that merely sits inside another does not declare this. */
  needs(...slots: string[]): SlotBuilder
  incremental(): SlotBuilder
  speculate(mode?: boolean | 'profile'): SlotBuilder
}

export function slot(name: string): SlotBuilder {
  const spec: SlotSpec = {
    name,
    delivery: 'stream',
    prio: 0,
    executor: 'inline',
    needs: [],
    incremental: false,
    speculate: false,
  }
  const builder: SlotBuilder = {
    spec,
    fragment(id) {
      spec.fragment = id
      return builder
    },
    stream(options) {
      spec.delivery = 'stream'
      if (options?.prio !== undefined) spec.prio = options.prio
      return builder
    },
    buffered() {
      spec.delivery = 'buffered'
      return builder
    },
    executor(target) {
      spec.executor = target
      return builder
    },
    budget(input) {
      spec.budget = {
        ...(input.cpu !== undefined ? { cpuMs: every(input.cpu) } : {}),
        ...(input.js !== undefined ? { jsBytes: bytes(input.js) } : {}),
        ...(input.grow !== undefined ? { growBytes: bytes(input.grow) } : {}),
        ...(input.onExceed ? { onExceed: input.onExceed } : {}),
      }
      return builder
    },
    cache(cls, options) {
      spec.cache = {
        class: cls,
        ...(options?.ttl !== undefined ? { ttlMs: every(options.ttl) } : {}),
        ...(options?.swr !== undefined ? { staleWhileRevalidateMs: every(options.swr) } : {}),
        ...(options?.tags ? { tags: options.tags } : {}),
        ...(options?.consistency ? { consistency: options.consistency } : {}),
      }
      return builder
    },
    refresh(everyMs, options) {
      spec.refresh = { everyMs, ...(options?.when ? { when: options.when } : {}) }
      return builder
    },
    form(input) {
      spec.form = input
      return builder
    },
    needs(...slots) {
      spec.needs = [...new Set([...spec.needs, ...slots])]
      return builder
    },
    incremental() {
      spec.incremental = true
      return builder
    },
    speculate(mode = true) {
      spec.speculate = mode
      return builder
    },
  }
  return builder
}

/**
 * A guard is a plan-level declaration and it runs in phase A by construction. Nearly every
 * real instance of "I need to set a cookie mid-stream" is actually "I discovered too late
 * that I needed a guard", so moving guards to where the envelope is still open removes the
 * problem rather than working around it.
 */
export function guard(name: string, options: { redirect?: string; status?: number } = {}): GuardSpec {
  return { name, ...options }
}

export function shell(fragment: string): ShellSpec {
  return { shell: fragment }
}

export type PlanEntry = SlotBuilder | GuardSpec | ShellSpec

export interface PlanOptions {
  maxConcurrency?: number
  /** The document's `Cache-Control`, validated against what the shell and its slots read. */
  cache?: {
    class: PolicyClass
    ttl?: string | number
    swr?: string | number
    tags?: string[]
    consistency?: 'eventual' | 'strong'
  }
}

export function plan(route: string, entries: readonly PlanEntry[] = [], options: PlanOptions = {}): Plan {
  const guards: GuardSpec[] = []
  const slots: SlotSpec[] = []
  let shellFragment: string | undefined
  for (const entry of entries) {
    if ('spec' in entry) {
      slots.push(entry.spec)
    } else if ('shell' in entry) {
      if (shellFragment) throw new PlanError('E_DUPLICATE_SHELL', `${route} declares two shells`)
      shellFragment = entry.shell
    } else {
      guards.push(entry)
    }
  }
  const names = new Set<string>()
  for (const s of slots) {
    if (names.has(s.name)) throw new PlanError('E_DUPLICATE_SLOT', `${s.name} is declared twice in ${route}`)
    names.add(s.name)
  }
  return {
    route,
    guards,
    slots,
    maxConcurrency: options.maxConcurrency ?? 6,
    ...(shellFragment ? { shell: shellFragment } : {}),
    ...(options.cache
      ? {
          cache: {
            class: options.cache.class,
            ...(options.cache.ttl !== undefined ? { ttlMs: every(options.cache.ttl) } : {}),
            ...(options.cache.swr !== undefined ? { staleWhileRevalidateMs: every(options.cache.swr) } : {}),
            ...(options.cache.tags ? { tags: options.cache.tags } : {}),
            ...(options.cache.consistency ? { consistency: options.cache.consistency } : {}),
          },
        }
      : {}),
  }
}
