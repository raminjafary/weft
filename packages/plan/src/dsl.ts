import type { WireForm } from '@weftjs/ir'
import { type ExceedPolicy, type PolicyClass, type RegionContract } from '@weftjs/kernel'

/** The plan: a declaration about placement, never a cache key. See `spec/plan/plan.md`. */
export type ExecutorTarget = string

/** Conditions a refresh waits for, all of which must hold. Order-free, so `and` can sort. */
export type Condition = { all: string[] }

/** The condition vocabulary a refresh may wait for — names rather than predicates, since only the client can evaluate them. */
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

/** Two conditions as one. Sorted, so `and(visible, focused)` and its reverse are the same value. */
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

/** `'8kb'` and `8192` are the same ceiling. A bad spelling is refused rather than coerced to zero. */
export function bytes(spec: string | number): number {
  if (typeof spec === 'number') return spec
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i.exec(spec.trim())
  if (!match) throw new PlanError('E_BAD_SIZE', `${spec} is not a size like '40kb'`)
  const value = Number(match[1])
  const unit = (match[2] as string).toLowerCase() as 'b' | 'kb' | 'mb'
  return value * { b: 1, kb: 1024, mb: 1024 * 1024 }[unit]
}

/** A plan refusal, carrying the code so a caller can branch on it rather than on the text. */
export class PlanError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'PlanError'
    this.code = code
  }
}

/** A slot's ceilings, already parsed. `SlotBuilder.budget` takes the human spellings. */
export interface SlotBudgetSpec {
  cpuMs?: number
  jsBytes?: number
  /** A cap on regression against the base branch. A ceiling alone produces permanent silence at 39.8 KB. */
  growBytes?: number
  onExceed?: ExceedPolicy
}

/** What a slot's cache entry is: its class, how long it lives, and what invalidates it. */
export interface CacheSpec {
  class: PolicyClass
  ttlMs?: number
  staleWhileRevalidateMs?: number
  tags?: string[]
  /** Checked against the store's declared consistency at build time. */
  consistency?: 'eventual' | 'strong'
}

/** How often a live region re-renders, and the conditions under which the interval applies. */
export interface RefreshSpec {
  everyMs: number
  when?: Condition
}

/**
 * Which wire form a slot would rather send, and what it falls back to.
 *
 * A preference, never a guarantee: the form actually used is the smallest one the client can prove
 * it can apply, and every form of a fragment produces identical bytes anyway.
 */
export interface FormSpec {
  prefer?: WireForm
  fallback?: WireForm
}

/**
 * One slot, fully resolved: what renders it, when its bytes arrive, where it runs, what it may
 * spend, and what may be done to it later. This is what `lowerPlan` reads and `weft why` prints.
 */
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
  /** Set when this slot is a region: a fragment that may live on another deployment. */
  region?: RegionDecl
}

/** What a shell declares about a region — everything except where it runs, which is the registry's. See `spec/kernel/composition.md`. */
export interface RegionDecl {
  locus: 'local' | 'remote'
  /** What this shell was built expecting the region to serve. */
  contract?: RegionContract
  /** Directives this region needs, merged into the document's policy and refused when they conflict. */
  csp?: Record<string, readonly string[]>
  /** Exposed signals this region consumes. Checked against what the shell exposes. */
  consumes?: readonly string[]
  /** A fragment rendered in this region's place when it fails. The design's `fallback('static:…')`. */
  fallback?: string
  /** Failure is invisible: an empty hole and nobody paged. `placeholder` with no placeholder. */
  optional?: boolean
  /** Ours, and in the first flush. A region that is `critical` may not be remote. */
  critical?: boolean
}

/** A guard by name, and what a refusal does: a real redirect or a real status, both in phase A. */
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
  /** Layouts nested inside it, outermost first: `[{ at: 'body', fragment: 'layout:dashboard' }]`. See `spec/kernel/routing.md`. */
  nested?: readonly ShellNesting[]
}

/** One link in a chain: the layout, and the hole of the enclosing one it fills. */
export interface ShellNesting {
  /** The slot hole of the enclosing layout this one fills. */
  at: string
  /** The fragment that fills it, which is itself a layout with holes of its own. */
  fragment: string
}

/** A route's placement, delivery and policy, resolved. Generated from the file convention, not a build configuration. */
export interface Plan {
  route: string
  /** The outermost fragment of the document. Absent only for a plan with no slots. */
  shell?: string
  /** Layouts nested inside `shell`, outermost first. Absent for the single-document case. See `spec/kernel/routing.md`. */
  shellChain?: readonly ShellNesting[]
  guards: GuardSpec[]
  slots: SlotSpec[]
  /** Signals the shell offers its regions, by name — deliberately the only channel between them. See `spec/kernel/composition.md`. */
  exposes: string[]
  /** The document's own policy: what the response advertises, checked against the strictest class among the shell and its slots. */
  cache?: CacheSpec
  /** Per-request ceiling. Forty concurrent queries from one page request will melt a database. */
  maxConcurrency: number
}

/** The chained form of a `SlotSpec`. A builder, not a literal, because every call has a rule checked elsewhere attached to it. */
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

/** A slot by the name of the hole it fills. Every other property is chained onto it. */
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

/** The region builder. A region is a slot — the whole implementation strategy, not a shortcut. See `spec/kernel/composition.md`. */
export interface RegionBuilder {
  readonly spec: SlotSpec
  /** This process renders it, from the named fragment. The monolith, and the default. */
  local(fragment?: string): RegionBuilder
  /** It crosses a deployment boundary. Which one is the registry's answer, not the shell's. */
  remote(contract?: RegionContract): RegionBuilder
  contract(id: string, version: string, reads?: readonly string[]): RegionBuilder
  /** Rendered in its place when it fails. */
  fallback(fragment: string): RegionBuilder
  /** Failure is invisible. An empty hole, and nobody is paged. */
  optional(): RegionBuilder
  /** Directives this region needs. Merged into the document's, and refused when they contradict. */
  csp(directives: Record<string, readonly string[]>): RegionBuilder
  /** Exposed signals this region reads. Checked against what the shell exposes. */
  consumes(...signals: string[]): RegionBuilder
  /** Ours, and in the first flush. A remote region cannot be critical. */
  critical(): RegionBuilder
  fragment(id: string): RegionBuilder
  stream(options?: { prio?: number }): RegionBuilder
  buffered(): RegionBuilder
  budget(spec: {
    cpu?: string | number
    js?: string | number
    grow?: string | number
    onExceed?: ExceedPolicy
  }): RegionBuilder
  cache(
    cls: PolicyClass,
    options?: {
      ttl?: string | number
      swr?: string | number
      tags?: string[]
      consistency?: 'eventual' | 'strong'
    },
  ): RegionBuilder
  refresh(everyMs: number, options?: { when?: Condition }): RegionBuilder
  form(spec: FormSpec): RegionBuilder
  needs(...slots: string[]): RegionBuilder
  incremental(): RegionBuilder
  speculate(mode?: boolean | 'profile'): RegionBuilder
}

/** The reserved executor name meaning "the registry decides". */
export const REGION_EXECUTOR = 'region'

/** A slot whose renderer may live on another deployment. Which one is the registry's answer. */
export function region(name: string): RegionBuilder {
  const base = slot(name)
  const spec = base.spec
  spec.executor = REGION_EXECUTOR
  const decl: RegionDecl = { locus: 'local' }
  spec.region = decl

  const b: RegionBuilder = {
    spec,
    local(fragment) {
      decl.locus = 'local'
      if (fragment) base.fragment(fragment)
      return b
    },
    remote(contract) {
      decl.locus = 'remote'
      if (contract) decl.contract = contract
      return b
    },
    contract(id, version, reads) {
      decl.contract = { id, version, ...(reads ? { reads: [...reads].sort() } : {}) }
      return b
    },
    fallback(fragment) {
      decl.fallback = fragment
      return b
    },
    optional() {
      decl.optional = true
      return b
    },
    csp(directives) {
      decl.csp = { ...decl.csp, ...directives }
      return b
    },
    consumes(...signals) {
      decl.consumes = [...new Set([...(decl.consumes ?? []), ...signals])].sort()
      return b
    },
    critical() {
      decl.critical = true
      return b
    },
    fragment: (id) => (base.fragment(id), b),
    stream: (options) => (base.stream(options), b),
    buffered: () => (base.buffered(), b),
    budget: (input) => (base.budget(input), b),
    cache: (cls, options) => (base.cache(cls, options), b),
    refresh: (everyMs, options) => (base.refresh(everyMs, options), b),
    form: (input) => (base.form(input), b),
    needs: (...slots) => (base.needs(...slots), b),
    incremental: () => (base.incremental(), b),
    speculate: (mode) => (base.speculate(mode), b),
  }
  return b
}

/** A plan-level declaration that runs in phase A by construction. See `spec/plan/plan.md`. */
export function guard(name: string, options: { redirect?: string; status?: number } = {}): GuardSpec {
  return { name, ...options }
}

/** The document a route renders into, optionally a chain of layouts nested inside it. */
export function shell(fragment: string, nested: readonly ShellNesting[] = []): ShellSpec {
  return { shell: fragment, ...(nested.length ? { nested } : {}) }
}

/** Anything that can go in a plan: a slot, a region, a guard, or the document itself. */
export type PlanEntry = SlotBuilder | RegionBuilder | GuardSpec | ShellSpec

/** What belongs to the plan rather than to any one slot: concurrency, the exposed set, the document's policy. */
export interface PlanOptions {
  maxConcurrency?: number
  /** Signals the shell exposes to its regions. The only channel between them. */
  exposes?: readonly string[]
  /** The document's `Cache-Control`, validated against what the shell and its slots read. */
  cache?: {
    class: PolicyClass
    ttl?: string | number
    swr?: string | number
    tags?: string[]
    consistency?: 'eventual' | 'strong'
  }
}

/** A plan from its entries. Refuses two shells and a duplicated slot name here, since neither needs the compiler's facts to answer. */
export function plan(route: string, entries: readonly PlanEntry[] = [], options: PlanOptions = {}): Plan {
  const guards: GuardSpec[] = []
  const slots: SlotSpec[] = []
  let shellFragment: string | undefined
  let shellChain: readonly ShellNesting[] | undefined
  for (const entry of entries) {
    if ('spec' in entry) {
      slots.push(entry.spec)
    } else if ('shell' in entry) {
      if (shellFragment) throw new PlanError('E_DUPLICATE_SHELL', `${route} declares two shells`)
      shellFragment = entry.shell
      if (entry.nested?.length) shellChain = entry.nested
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
    exposes: [...new Set(options.exposes ?? [])].sort(),
    maxConcurrency: options.maxConcurrency ?? 6,
    ...(shellFragment ? { shell: shellFragment } : {}),
    ...(shellChain ? { shellChain } : {}),
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
