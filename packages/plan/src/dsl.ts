import type { WireForm } from '@weft/ir'
import { type ExceedPolicy, type PolicyClass, type RegionContract } from '@weft/kernel'

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
  /** Set when this slot is a region: a fragment that may live on another deployment. */
  region?: RegionDecl
}

/**
 * What a shell declares about a region, which is everything except where it runs.
 *
 * Where it runs is the registry's, and the omission is deliberate rather than an oversight in
 * transcribing the design — whose sketch writes `.remote('svc:search', contract.search)`. A shell
 * naming the tier would make rolling that region a redeploy of every shell that names it, which is
 * the property the registry port exists to provide. So the plan declares the one thing a *build*
 * needs to know — whether this region crosses a boundary — and the deployment decides which one.
 *
 * `locus` is therefore not a target and not a hint. It is what the hop count is computed from, what
 * the render-location check runs against, and what a startup check compares the registry with: a
 * region declared `remote` whose registry entry says `inline` is a misconfiguration somebody should
 * be told about rather than a silently faster page.
 */
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
  /**
   * Layouts nested inside it, outermost first: `[{ at: 'body', fragment: 'layout:dashboard' }]`.
   *
   * A chain's boundaries are the union of every layer's holes, minus the holes the chain itself
   * fills — so `at` is named here rather than inferred. Inferring it would mean deciding that
   * `body` is special in the plan layer, and `body` is a convention of the file layout above it.
   */
  nested?: readonly ShellNesting[]
}

export interface ShellNesting {
  /** The slot hole of the enclosing layout this one fills. */
  at: string
  /** The fragment that fills it, which is itself a layout with holes of its own. */
  fragment: string
}

export interface Plan {
  route: string
  /** The outermost fragment of the document. Absent only for a plan with no slots. */
  shell?: string
  /**
   * Layouts nested inside `shell`, outermost first. Absent for the single-document case.
   *
   * The document a route renders is the whole chain, so every check that used to read `shell`
   * alone reads this too: the boundaries a slot may fill, the reads that decide the cache class,
   * and the identity two routes have to share before they can share a region.
   */
  shellChain?: readonly ShellNesting[]
  guards: GuardSpec[]
  slots: SlotSpec[]
  /**
   * Signals the shell offers its regions, by name — the design's `expose({ locale, cartCount })`,
   * and deliberately the only channel between them.
   *
   * Declared here rather than discovered because the value of a single channel is that it can be
   * checked: a region consuming a signal the shell does not expose is a build error, where the
   * alternative is a region reading a global that happens to exist on one page and not on another.
   */
  exposes: string[]
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
 * The region builder: the design's `shell(({ region }) => …)`, as an entry in the same plan
 * everything else is in.
 *
 * A region is a slot. That is the whole implementation strategy and it is not a shortcut — a region
 * fills a hole in the shell, is dispatched in a wave, may be cached, may be refreshed, and degrades
 * on a policy, and every one of those is a slot's behaviour. What a region adds is where its code
 * lives and what happens when the other end is having a bad afternoon, which is exactly what
 * `RegionDecl` holds.
 *
 * The executor is the reserved name `region`, meaning *the registry decides*. A region slot with any
 * other executor, and a non-region slot claiming this one, are both build errors: the point of the
 * sentinel is that the two ways of saying where a render happens cannot both be in play for one
 * slot.
 */
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

/**
 * A guard is a plan-level declaration and it runs in phase A by construction. Nearly every
 * real instance of "I need to set a cookie mid-stream" is actually "I discovered too late
 * that I needed a guard", so moving guards to where the envelope is still open removes the
 * problem rather than working around it.
 */
export function guard(name: string, options: { redirect?: string; status?: number } = {}): GuardSpec {
  return { name, ...options }
}

export function shell(fragment: string, nested: readonly ShellNesting[] = []): ShellSpec {
  return { shell: fragment, ...(nested.length ? { nested } : {}) }
}

export type PlanEntry = SlotBuilder | RegionBuilder | GuardSpec | ShellSpec

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
