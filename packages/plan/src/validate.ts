import { cacheClassOf, requiresTtl, type EffectSet, type WireForm } from '@weft/ir'
import { type Consistency, type DagNode, PlanGraphError, schedule, W_CPU_BUDGET_ADVISORY } from '@weft/kernel'
import { PlanError, REGION_EXECUTOR, type Plan, type RegionDecl, type SlotSpec } from './dsl.ts'

/**
 * The plan is checked against what the compiler inferred, never the other way around.
 *
 * A declaration that contradicts a derivation loses, and it loses at build time with the
 * read that caused it named — because the alternative is a `.cache('public')` on a fragment
 * that reads identity, which is not a caching bug, it is one user's bytes in another user's
 * cache.
 */
export interface SlotFacts {
  /** Module and export, as the compiler names it. */
  id: string
  version: string
  effects: EffectSet
  /** Forms the template can serve, derived by the compiler. */
  forms: readonly WireForm[]
  /**
   * Boundary names this fragment leaves for somebody else to fill: its `slot` holes, and any
   * component instance the compiler isolated. Both are holes this render does not own, which
   * is why they are one list rather than two.
   */
  fillable?: readonly string[]
  /** Derived values a memoized recompute could skip. The design's second memoisation level. */
  derivedCount?: number
  /**
   * Nested templates — list rows and component instances — that a content-addressed memo could
   * reuse. The design's third level, and the one that actually pays on a long list.
   */
  nestedCount?: number
}

export interface Issue {
  code: string
  slot?: string
  message: string
}

export interface Diagnostics {
  errors: Issue[]
  warnings: Issue[]
}

export interface ValidateContext {
  facts: Record<string, SlotFacts>
  /** Executor names the deployment actually binds. `inline` and `client` always exist. */
  executors?: readonly string[]
  store?: { consistency: Consistency; name: string }
  /**
   * How many subrequests one request may make where this is deployed, so a fan-out that is about
   * to hit a platform ceiling is a warning at build time rather than a 500 under load.
   *
   * The default is Workers' documented 50. It is a property of the platform rather than of the
   * plan, which is why it is context and not a plan field.
   */
  subrequestCeiling?: number
}

const EXECUTOR_PREFIXES = ['pool:', 'binding:', 'svc:']
const BARE_EXECUTORS = new Set(['inline', 'client', 'isolate'])

export function validatePlan(plan: Plan, context: ValidateContext): Diagnostics {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const known = new Set(plan.slots.map((s) => s.name))

  for (const spec of plan.slots) {
    const facts = context.facts[spec.fragment ?? spec.name]
    for (const need of spec.needs) {
      if (!known.has(need)) {
        errors.push({
          code: 'E_UNKNOWN_SLOT',
          slot: spec.name,
          message: `needs '${need}', which is not a slot in ${plan.route}`,
        })
      }
    }

    checkExecutor(spec, context, errors)
    checkBudget(spec, warnings)
    if (facts) checkRenderLocation(spec, facts, errors)
    if (spec.region) checkRegion(spec, spec.region, plan, errors)

    // A remote region's fragment is not this build's to have. Its reads, its version and its holes
    // are on the other side, and what stands in for them is the contract plus the check on arrival
    // — so the absence is expected here rather than a plan naming something that does not exist.
    if (!facts && spec.region?.locus === 'remote') continue

    if (!facts) {
      errors.push({
        code: 'E_NO_SUCH_FRAGMENT',
        slot: spec.name,
        message: `renders '${spec.fragment ?? spec.name}', which the compiler did not produce`,
      })
      continue
    }

    checkCache(spec, facts, context, errors, warnings)
    checkForms(spec, facts, errors)
    checkIncremental(spec, facts, warnings)
  }

  // Only worth asking about waves once every `needs` names a real slot; otherwise the
  // graph would report the same missing slot a second time under a different code.
  if (!errors.some((e) => e.code === 'E_UNKNOWN_SLOT'))
    try {
      const nodes: DagNode[] = plan.slots.map((s) => ({ name: s.name, needs: s.needs, prio: s.prio }))
      const { width } = schedule(nodes)
      if (width > plan.maxConcurrency) {
        warnings.push({
          code: 'W_WAVE_WIDTH',
          message: `the widest wave dispatches ${width} slots against a ceiling of ${plan.maxConcurrency}; the extra slots queue`,
        })
      }
    } catch (error) {
      if (error instanceof PlanGraphError) errors.push({ code: error.code, message: error.message })
      else throw error
    }

  const fan = hopsOf(plan)
  const ceiling = context.subrequestCeiling ?? 50
  if (fan.hops >= ceiling * 0.8) {
    warnings.push({
      code: 'W_HOP_COUNT',
      message:
        `${plan.route} crosses ${fan.hops} deployment boundaries on one request against a ceiling of ` +
        `${ceiling}, and a region that fans out further adds its own`,
    })
  }
  cspOf(plan, errors)

  // Last, so a whole-plan complaint never masks the specific slot that is wrong.
  const shell = checkShell(plan, context, errors)
  checkDocument(plan, shell, context, errors)

  return { errors, warnings }
}

/**
 * What a region may declare, and the three combinations that contradict themselves.
 *
 * All three are the same mistake in different clothes: a declaration about a region that could only
 * be true if the region were somewhere other than where it says it is.
 */
function checkRegion(spec: SlotSpec, decl: RegionDecl, plan: Plan, errors: Issue[]): void {
  if (decl.critical && decl.locus === 'remote') {
    errors.push({
      code: 'E_REGION_CRITICAL_REMOTE',
      slot: spec.name,
      message:
        'is critical and remote. Critical means it is in the first flush, and the first flush is ' +
        'the thing a gateway can do without a hop — that is the whole reason the shells live there',
    })
  }
  if (decl.locus === 'local' && decl.contract) {
    errors.push({
      code: 'E_REGION_CONTRACT_LOCAL',
      slot: spec.name,
      message:
        'is local and declares a contract. A contract is what stands in for a compiler this build ' +
        'does not have; here it does have one, and a second description of the same fragment can ' +
        'only ever disagree with it',
    })
  }
  for (const signal of decl.consumes ?? []) {
    if (!plan.exposes.includes(signal)) {
      errors.push({
        code: 'E_NOT_EXPOSED',
        slot: spec.name,
        message: `consumes '${signal}', which ${plan.route} does not expose (it exposes ${plan.exposes.join(', ') || 'nothing'})`,
      })
    }
  }
}

/**
 * The fan-out, as a number the build states rather than a number a deployment discovers.
 *
 * Every hop is latency, and the design is blunt about it: a naive split of a page full of cheap
 * fragments loses to a monolith. So the count is reported for every plan and warned about when it
 * approaches the platform's subrequest ceiling — before it approaches it, because the request that
 * finds the ceiling is a 500 rather than a slow page.
 *
 * What this can and cannot see is worth being exact about. It counts the boundaries *this* plan
 * crosses. A region that fans out further is one this build has no view of — its own plan counts
 * its own — and the composite reports the real total at runtime from what each region announces.
 * The build-time number is therefore a floor, and it is a floor rather than an estimate.
 */
export interface HopCount {
  regions: number
  remote: number
  /** Boundaries this plan crosses on one request. A floor: a region that fans out further adds its own. */
  hops: number
}

export function hopsOf(plan: Plan): HopCount {
  const regions = plan.slots.filter((s) => s.region)
  const remote = regions.filter((s) => s.region?.locus === 'remote')
  return { regions: regions.length, remote: remote.length, hops: remote.length }
}

/**
 * The regions' CSP directives, merged, and the one shape of disagreement that is not a union.
 *
 * A policy is per document — there is one header — so a shell composing regions has to reconcile
 * what each of them needs. Two regions naming different hosts for the same directive is a union and
 * not a conflict. `'none'` beside anything else is the conflict, because it is the one value that
 * means *and nothing else*, and merging it by union would silently turn a region's refusal to load
 * anything into permission to load somebody else's host.
 */
export function cspOf(plan: Plan, errors: Issue[] = []): Record<string, string[]> {
  const merged: Record<string, Set<string>> = {}
  const sources: Record<string, string[]> = {}
  for (const spec of plan.slots) {
    for (const [directive, values] of Object.entries(spec.region?.csp ?? {})) {
      merged[directive] ??= new Set()
      sources[directive] ??= []
      sources[directive].push(spec.name)
      for (const value of values) merged[directive].add(value)
    }
  }
  const out: Record<string, string[]> = {}
  // Sorted by directive, so the header two builds produce for one plan is the same string and a
  // policy change is a legible diff rather than a reordering.
  for (const [directive, values] of Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const list = [...values].sort()
    if (list.length > 1 && list.some((v) => v === "'none'")) {
      errors.push({
        code: 'E_CSP_CONFLICT',
        message:
          `${directive} is declared as 'none' and as ${list.filter((v) => v !== "'none'").join(', ')} ` +
          `by ${(sources[directive] as string[]).join(', ')}. There is one header, and 'none' means and nothing else`,
      })
    }
    out[directive] = list
  }
  return out
}

/**
 * The plan's slots and the shell's holes have to agree exactly. Both sides are already
 * written down — one by an author, one by the compiler — so a disagreement is a build error
 * rather than a region that renders empty in production.
 */
function checkShell(plan: Plan, context: ValidateContext, errors: Issue[]): SlotFacts | undefined {
  if (!plan.shell) {
    if (plan.slots.length) {
      errors.push({
        code: 'E_NO_SHELL',
        message: `${plan.route} declares slots but no shell, so there is no document for them to fill`,
      })
    }
    return undefined
  }

  const facts = context.facts[plan.shell]
  if (!facts) {
    errors.push({
      code: 'E_NO_SUCH_FRAGMENT',
      message: `${plan.route} names shell '${plan.shell}', which the compiler did not produce`,
    })
    return undefined
  }

  // Absent rather than empty means the caller did not derive it, and inventing an answer
  // from that would turn a missing input into a confident refusal.
  if (!facts.fillable) return facts

  const holes = new Set(facts.fillable)
  const declared = new Set(plan.slots.map((s) => s.name))
  for (const spec of plan.slots) {
    if (!holes.has(spec.name)) {
      errors.push({
        code: 'E_SLOT_NOT_IN_SHELL',
        slot: spec.name,
        message: `is not a boundary in ${plan.shell} (it leaves ${[...holes].sort().join(', ') || 'none'})`,
      })
    }
  }
  for (const hole of facts.fillable) {
    if (!declared.has(hole)) {
      errors.push({
        code: 'E_SHELL_HOLE_UNFILLED',
        message: `${plan.shell} leaves a boundary '${hole}' that no slot in ${plan.route} fills`,
      })
    }
  }
  return facts
}

/**
 * The document contains everything, so it may only advertise what the strictest region among
 * them allows. Catching it here rather than at the first request is the difference between a
 * build error and an identity leak.
 */
function checkDocument(
  plan: Plan,
  shell: SlotFacts | undefined,
  context: ValidateContext,
  errors: Issue[],
): void {
  const policy = plan.cache
  if (!policy || policy.class !== 'public') return

  const offenders: string[] = []
  for (const spec of plan.slots) {
    // A remote region has no facts here by construction, and its reads are the contract's. An
    // undeclared one reads `opaque`, which is private — so a public document containing a region
    // nobody described is refused rather than advertised on the strength of a silence.
    if (spec.region?.locus === 'remote') {
      const reads = spec.region.contract?.reads
      if (!reads || reads.includes('identity') || reads.includes('opaque')) offenders.push(spec.name)
      continue
    }
    const facts = context.facts[spec.fragment ?? spec.name]
    if (facts && cacheClassOf(facts.effects) === 'private') offenders.push(spec.name)
  }
  if (shell && cacheClassOf(shell.effects) === 'private') offenders.push('the shell')

  if (offenders.length) {
    errors.push({
      code: 'E_DOCUMENT_POLICY_CONFLICT',
      message:
        `${plan.route} declares a public document while ${offenders.join(', ')} ` +
        `${offenders.length === 1 ? 'is' : 'are'} private`,
    })
  }
  if (shell && requiresTtl(shell.effects) && policy.ttlMs === undefined) {
    errors.push({
      code: 'E_TTL_REQUIRED',
      message: `${plan.route}: the shell reads the clock, so a document policy without a ttl never expires`,
    })
  }
}

function checkExecutor(spec: SlotSpec, context: ValidateContext, errors: Issue[]): void {
  const target = spec.executor
  // The two ways of saying where a render happens may not both be in play for one slot: a region's
  // executor is the registry's answer, and a slot naming the sentinel without being a region has
  // named an executor nothing will ever bind.
  if (target === REGION_EXECUTOR || spec.region) {
    if (!spec.region) {
      errors.push({
        code: 'E_UNKNOWN_EXECUTOR',
        slot: spec.name,
        message: `names the reserved executor '${REGION_EXECUTOR}', which only a region may use`,
      })
    } else if (target !== REGION_EXECUTOR) {
      errors.push({
        code: 'E_REGION_EXECUTOR',
        slot: spec.name,
        message: `is a region and names executor '${target}'. Where a region runs is the registry's answer, so the two would disagree`,
      })
    }
    return
  }
  const bound = new Set(['inline', 'client', ...(context.executors ?? [])])
  if (bound.has(target)) return
  if (
    BARE_EXECUTORS.has(target) ||
    EXECUTOR_PREFIXES.some((p) => target.startsWith(p) && target.length > p.length)
  ) {
    if (context.executors && !bound.has(target)) {
      errors.push({
        code: 'E_UNKNOWN_EXECUTOR',
        slot: spec.name,
        message: `executor '${target}' is not bound by this deployment (bound: ${[...bound].sort().join(', ')})`,
      })
    }
    return
  }
  errors.push({
    code: 'E_UNKNOWN_EXECUTOR',
    slot: spec.name,
    message: `executor '${target}' is not one of inline, client, isolate, pool:*, binding:*, svc:*`,
  })
}

/**
 * Where a slot's render actually happens, coarsely, and it is the only distinction that changes
 * what the render can *read*: this process, the browser, or another deployment.
 *
 * Not the same question as a crash domain. `pool:` is a separate crash domain and the same
 * process's view of the request; `client` is neither.
 */
export type RenderLocus = 'process' | 'client' | 'remote'

export function locusOf(target: string): RenderLocus {
  if (target === 'client') return 'client'
  if (target.startsWith('binding:') || target.startsWith('svc:')) return 'remote'
  return 'process'
}

/**
 * Per-slot render-location enforcement: a slot may not be sent somewhere its reads cannot be
 * resolved.
 *
 * The executor already decides where a render runs, and until now nothing checked that against
 * what the compiler saw the fragment read. `executor('client')` on a fragment that reads identity
 * is not a slow page or a cache mistake — it is an island shipped to a browser that has no session
 * to resolve, and the failure arrives at request time, per reader, as an empty region.
 *
 * Both rules are derived from facts that already exist, which is why this is a build error rather
 * than a convention:
 *
 * - **The browser has no request.** A `cookie:` read is refused there whether or not the cookie is
 *   `HttpOnly`, because which one it is is a runtime property and this is a build check — and the
 *   one that matters is exactly the one a session uses. Route params, locale, device and the clock
 *   all exist in a browser and are left alone.
 * - **A closure cannot cross a crash domain**, which is the constraint that made `JobAddress`
 *   necessary in the first place. `ctx.raw()` is a function over the whole request, so a fragment
 *   using the escape hatch cannot render on a `binding:` or `svc:` executor at all.
 *
 * What this deliberately does *not* decide: whether a private fragment may render on another
 * deployment. That is a trust boundary, and only the deployment knows where its own boundaries
 * are — a framework guessing would either refuse a legitimate internal service or wave through a
 * third-party one, and both are worse than saying so.
 */
const NOT_IN_A_BROWSER: Record<string, string> = {
  identity: 'the session is resolved from a request the browser cannot see',
  opaque: 'ctx.raw() is a function over the request, and there is no request in a browser',
}

function unreadableIn(locus: RenderLocus, read: string): string | undefined {
  if (locus === 'remote') {
    return read === 'opaque'
      ? 'ctx.raw() is a closure over the request, and a closure cannot cross a crash domain'
      : undefined
  }
  if (locus !== 'client') return undefined
  if (NOT_IN_A_BROWSER[read]) return NOT_IN_A_BROWSER[read]
  if (read.startsWith('cookie:'))
    return 'a request cookie is not readable in a browser, and an HttpOnly one never will be'
  if (read.startsWith('header:')) return 'request headers do not exist in a browser'
  return undefined
}

function checkRenderLocation(spec: SlotSpec, facts: SlotFacts, errors: Issue[]): void {
  const locus = locusOf(spec.executor)
  if (locus === 'process') return
  const offending = facts.effects.reads
    .map((read) => ({ read, why: unreadableIn(locus, read) }))
    .filter((entry): entry is { read: string; why: string } => entry.why !== undefined)
  if (!offending.length) return
  errors.push({
    code: 'E_RENDER_LOCATION',
    slot: spec.name,
    message:
      `renders on '${spec.executor}' and reads ${offending.map((o) => o.read).join(', ')}: ` +
      offending.map((o) => o.why).join('; '),
  })
}

/**
 * Which executor targets are a separate crash domain, derived from the target rather than
 * declared. `isolate`, `pool:`, `binding:` and `svc:` name one by definition; `inline`,
 * `deferred` and anything else on the request thread do not.
 */
function isCrashDomain(target: string): boolean {
  return target === 'isolate' || CRASH_DOMAIN_PREFIXES.some((p) => target.startsWith(p))
}

const CRASH_DOMAIN_PREFIXES = ['pool:', 'binding:', 'svc:']

/**
 * A cpu budget outside a crash domain is advisory, and this used to warn only when the target
 * was the literal string `inline`. A slot on `deferred` — a macrotask on the request thread —
 * got a budget, no warning, and a synchronous render that ran to completion anyway.
 */
function checkBudget(spec: SlotSpec, warnings: Issue[]): void {
  if (spec.budget?.cpuMs === undefined) return
  if (isCrashDomain(spec.executor)) return
  warnings.push({
    code: 'W_CPU_BUDGET_ADVISORY',
    slot: spec.name,
    message: `${W_CPU_BUDGET_ADVISORY} (this slot is on '${spec.executor}')`,
  })
}

function checkCache(
  spec: SlotSpec,
  facts: SlotFacts,
  context: ValidateContext,
  errors: Issue[],
  warnings: Issue[],
): void {
  const cls = cacheClassOf(facts.effects)
  const policy = spec.cache
  if (!policy) {
    if (facts.effects.reads.includes('time')) {
      warnings.push({
        code: 'W_TTL_UNDECLARED',
        slot: spec.name,
        message: 'reads the clock but declares no cache policy, so nothing is cached and nothing expires',
      })
    }
    return
  }

  if (policy.class === 'public' && cls === 'private') {
    const cause = facts.effects.reads.filter((r) => r === 'identity' || r === 'opaque')
    errors.push({
      code: 'E_CACHE_POLICY_CONFLICT',
      slot: spec.name,
      message: `.cache('public') on a fragment the compiler classified private. The read that caused it: ${cause.join(', ')}`,
    })
  }

  if (requiresTtl(facts.effects) && policy.ttlMs === undefined) {
    errors.push({
      code: 'E_TTL_REQUIRED',
      slot: spec.name,
      message: 'reads the clock, so a cache policy without a ttl would never expire',
    })
  }

  if (cls === 'static' && policy.ttlMs !== undefined) {
    warnings.push({
      code: 'W_TTL_ON_STATIC',
      slot: spec.name,
      message: 'reads nothing, so it resolves at build time and the ttl has nothing to expire',
    })
  }

  if (policy.consistency === 'strong' && context.store?.consistency === 'eventual') {
    errors.push({
      code: 'E_CONSISTENCY_MISMATCH',
      slot: spec.name,
      message: `declares strong consistency against '${context.store.name}', which is eventual`,
    })
  }
}

function checkForms(spec: SlotSpec, facts: SlotFacts, errors: Issue[]): void {
  for (const [which, form] of [
    ['prefer', spec.form?.prefer],
    ['fallback', spec.form?.fallback],
  ] as const) {
    if (!form) continue
    if (!facts.forms.includes(form)) {
      errors.push({
        code: 'E_FORM_UNAVAILABLE',
        slot: spec.name,
        message: `${which}s '${form}', which this template cannot serve (it can serve ${facts.forms.join(', ')})`,
      })
    }
  }
}

function checkIncremental(spec: SlotSpec, facts: SlotFacts, warnings: Issue[]): void {
  if (!spec.incremental) return
  // Two levels can pay: derived values a change cannot reach, and nested templates a memo can
  // return. A fragment with neither is hashing its inputs for nothing.
  if ((facts.derivedCount ?? 0) === 0 && (facts.nestedCount ?? 0) === 0) {
    warnings.push({
      code: 'W_INCREMENTAL_NO_GRAPH',
      slot: spec.name,
      message:
        'declares .incremental() but has neither derived values nor nested templates to memoize, so the input hashing is pure overhead',
    })
  }
}

export function assertPlan(plan: Plan, context: ValidateContext): Plan {
  const { errors } = validatePlan(plan, context)
  if (errors.length) {
    const lines = errors.map((e) => `  ${e.code}${e.slot ? ` [${e.slot}]` : ''}: ${e.message}`)
    throw new PlanError('E_PLAN_INVALID', `${plan.route}\n${lines.join('\n')}`)
  }
  return plan
}
