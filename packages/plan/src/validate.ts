import { cacheClassOf, requiresTtl, unionEffects, type EffectSet, type WireForm } from '@weftjs/ir'
import {
  type Consistency,
  type DagNode,
  PlanGraphError,
  schedule,
  type Scope,
  W_CPU_BUDGET_ADVISORY,
} from '@weftjs/kernel'
import {
  PlanError,
  REGION_EXECUTOR,
  type Plan,
  type RegionDecl,
  type ShellNesting,
  type SlotSpec,
} from './dsl.ts'

/** The plan is checked against what the compiler inferred, never the other way around. See `spec/plan/plan.md`. */
export interface SlotFacts {
  /** Module and export, as the compiler names it. */
  id: string
  version: string
  effects: EffectSet
  /** Forms the template can serve, derived by the compiler. */
  forms: readonly WireForm[]
  /** Boundary names this fragment leaves for somebody else to fill: `slot` holes and isolated instances. */
  fillable?: readonly string[]
  /** Derived values a memoized recompute could skip. The design's second memoisation level. */
  derivedCount?: number
  /** Nested templates a content-addressed memo could reuse. The design's third level. */
  nestedCount?: number
}

/** One problem with a plan: its code, the slot it is about, and a sentence. */
export interface Issue {
  code: string
  slot?: string
  message: string
}

/** Everything wrong with a plan, split by whether it stops the build. */
export interface Diagnostics {
  errors: Issue[]
  warnings: Issue[]
}

/** What a plan is checked against: the compiler's facts, and what the deployment bound. */
export interface ValidateContext {
  facts: Record<string, SlotFacts>
  /** Executor names the deployment actually binds. `inline` and `client` always exist. */
  executors?: readonly string[]
  store?: { consistency: Consistency; name: string; scope?: Scope }
  /** How many instances of this deployment run at once. Defaults to 1. See `spec/plan/plan.md`. */
  instances?: number
  /** Subrequests one request may make before a platform ceiling. Defaults to Workers' documented 50. */
  subrequestCeiling?: number
}

const EXECUTOR_PREFIXES = ['pool:', 'binding:', 'svc:']
const BARE_EXECUTORS = new Set(['inline', 'client', 'isolate'])

/** Every rule, against one plan. Returns what it found rather than throwing, so a report can print it. */
export function validatePlan(plan: Plan, context: ValidateContext): Diagnostics {
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const known = new Set(plan.slots.map((s) => s.name))

  checkDocumentOutlivesInvalidation(plan, warnings)

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
    if (spec.region) checkRegion(spec, spec.region, plan, errors, warnings)

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

/** What a region may declare, and the combinations that contradict where it says it is. See `spec/kernel/composition.md`. */
function checkRegion(spec: SlotSpec, decl: RegionDecl, plan: Plan, errors: Issue[], warnings: Issue[]): void {
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

  /** Cache tags on a remote region, which nothing on this side can ever fire. See `spec/kernel/composition.md`. */
  if (decl.locus === 'remote' && spec.cache?.tags?.length && !spec.refresh) {
    warnings.push({
      code: 'W_REGION_TAGS_UNREACHABLE',
      slot: spec.name,
      message:
        `is remote and declares the tag${spec.cache.tags.length === 1 ? '' : 's'} ` +
        `${spec.cache.tags.join(', ')}. Push invalidation stops at the boundary — the composite holds ` +
        `a contract, not this region's keys — so nothing here will ever fire ${spec.cache.tags.length === 1 ? 'it' : 'them'}. ` +
        `Declare a refresh interval, which is the design's stated fallback for that tier`,
    })
  }
}

/** The fan-out, as a number the build states rather than a number a deployment discovers — a floor, not an estimate. See `spec/kernel/composition.md`. */
export interface HopCount {
  regions: number
  remote: number
  /** Boundaries this plan crosses on one request. A floor: a region that fans out further adds its own. */
  hops: number
}

/** How many tier boundaries this page crosses. The answer to "how much latency", not "made of what". */
export function hopsOf(plan: Plan): HopCount {
  const regions = plan.slots.filter((s) => s.region)
  const remote = regions.filter((s) => s.region?.locus === 'remote')
  return { regions: regions.length, remote: remote.length, hops: remote.length }
}

/** The regions' CSP directives, merged; `'none'` beside anything else is the one shape that's a conflict, not a union. See `spec/kernel/composition.md`. */
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

/** The document a route renders, as one fact set, however many layouts it is made of. See `spec/kernel/routing.md`. */
function shellFacts(plan: Plan, context: ValidateContext, errors: Issue[]): SlotFacts | undefined {
  const outer = plan.shell ? context.facts[plan.shell] : undefined
  if (!plan.shell) return undefined
  if (!outer) {
    errors.push({
      code: 'E_NO_SUCH_FRAGMENT',
      message: `${plan.route} names shell '${plan.shell}', which the compiler did not produce`,
    })
    return undefined
  }
  const chain = plan.shellChain ?? []
  if (!chain.length) return outer

  const layers: SlotFacts[] = [outer]
  for (const link of chain) {
    const facts = context.facts[link.fragment]
    if (!facts) {
      errors.push({
        code: 'E_NO_SUCH_FRAGMENT',
        message: `${plan.route} nests shell '${link.fragment}', which the compiler did not produce`,
      })
      return undefined
    }
    layers.push(facts)
  }

  // A link's `at` has to be a boundary the layout enclosing it actually leaves, or the nested
  // layout has nowhere to go and the document renders without it.
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i] as ShellNesting
    const enclosing = layers[i] as SlotFacts
    if (enclosing.fillable && !enclosing.fillable.includes(link.at)) {
      errors.push({
        code: 'E_SHELL_LINK_UNPLACED',
        message:
          `${plan.route} nests '${link.fragment}' at '${link.at}', which ${enclosing.id} does not leave ` +
          `(it leaves ${[...enclosing.fillable].sort().join(', ') || 'none'})`,
      })
    }
  }

  // A layer loses exactly one hole: the one the link *inside it* fills. The innermost layer has no
  // link inside it, so it keeps all of them — which is where the page goes.
  const undecided = layers.some((layer) => !layer.fillable)
  const fillable = undecided
    ? undefined
    : [
        ...new Set(
          layers.flatMap((layer, index) => {
            const own = layer.fillable as readonly string[]
            const link = chain[index]
            return link ? own.filter((hole) => hole !== link.at) : own
          }),
        ),
      ]

  return {
    id: [outer.id, ...chain.map((link) => link.fragment)].join('>'),
    version: layers.map((layer) => layer.version).join('+'),
    effects: unionEffects(layers.map((layer) => layer.effects)),
    forms: outer.forms,
    ...(fillable ? { fillable } : {}),
  }
}

/** The plan's slots and the shell's holes have to agree exactly, or the build refuses rather than rendering empty. */
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

  const facts = shellFacts(plan, context, errors)
  if (!facts) return undefined

  // Absent rather than empty means the caller did not derive it, and inventing an answer
  // from that would turn a missing input into a confident refusal.
  if (!facts.fillable) return facts

  const where = plan.shellChain?.length ? `the chain ${facts.id}` : (plan.shell as string)
  const holes = new Set(facts.fillable)
  const declared = new Set(plan.slots.map((s) => s.name))
  for (const spec of plan.slots) {
    if (!holes.has(spec.name)) {
      errors.push({
        code: 'E_SLOT_NOT_IN_SHELL',
        slot: spec.name,
        message: `is not a boundary in ${where} (it leaves ${[...holes].sort().join(', ') || 'none'})`,
      })
    }
  }
  for (const hole of facts.fillable) {
    if (!declared.has(hole)) {
      errors.push({
        code: 'E_SHELL_HOLE_UNFILLED',
        message: `${where} leaves a boundary '${hole}' that no slot in ${plan.route} fills`,
      })
    }
  }
  return facts
}

/** The document may only advertise `public` if every region it contains would too. See `spec/plan/plan.md`. */
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

/** Where a slot's render happens: this process, the browser, or another deployment. Not the same question as a crash domain. See `spec/plan/plan.md`. */
export type RenderLocus = 'process' | 'client' | 'remote'

/** Where an executor target runs: this thread, a deferred slice, a pool, or another deployment. */
export function locusOf(target: string): RenderLocus {
  if (target === 'client') return 'client'
  if (target.startsWith('binding:') || target.startsWith('svc:')) return 'remote'
  return 'process'
}

/** Per-slot render-location enforcement: a slot may not be sent somewhere its reads cannot be resolved. See `spec/plan/plan.md`. */
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

/** Which executor targets are a separate crash domain, derived from the target rather than declared. */
function isCrashDomain(target: string): boolean {
  return target === 'isolate' || CRASH_DOMAIN_PREFIXES.some((p) => target.startsWith(p))
}

const CRASH_DOMAIN_PREFIXES = ['pool:', 'binding:', 'svc:']

/** A CPU budget outside a crash domain is advisory. Checks `isCrashDomain`, not the literal string `inline` — a `deferred` slot used to get a budget and no warning. */
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

  /**
   * Cache tags against a store only this process can read, on a deployment that is not one process.
   *
   * The same bug as the one above and from the other end. There the tag cannot cross a region
   * boundary; here it cannot cross an *instance* boundary, and the reason is a property the store
   * already declares: `scope: 'process'` means no other process can read these bytes, so invalidating
   * a tag drops this instance's copy and leaves every other instance serving what it already had.
   * A reader on one of them is not told, and asks a store that was never purged — so the invalidation
   * appears to work, on one instance out of however many are running.
   *
   * An error rather than a warning, because unlike a remote region there is no other side that might
   * be handling it: a process-scoped store on N instances is N private caches and nothing reconciles
   * them. `instances` defaults to 1, so this fires only for a deployment that has said it runs more
   * than one — which is the deployment that has the problem.
   */
  if ((context.instances ?? 1) > 1 && context.store?.scope === 'process' && spec.cache?.tags?.length) {
    errors.push({
      code: 'E_TAGS_PROCESS_SCOPED',
      slot: spec.name,
      message:
        `declares the tag${spec.cache.tags.length === 1 ? '' : 's'} ${spec.cache.tags.join(', ')} ` +
        `against '${context.store.name}', which is process-scoped, on a deployment running ` +
        `${context.instances ?? 1} instances. Each one holds its own copy and an invalidation reaches ` +
        `only the instance that ran it. Bind a store whose scope is 'shared'`,
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

/** A document held longer than the invalidation that is supposed to reach it. See `spec/plan/plan.md`. */
function checkDocumentOutlivesInvalidation(plan: Plan, warnings: Issue[]): void {
  const held = plan.cache
  if (!held?.ttlMs) return
  const carried = new Set(held.tags ?? [])
  const unreachable = new Set<string>()
  for (const spec of plan.slots) {
    for (const tag of spec.cache?.tags ?? []) if (!carried.has(tag)) unreachable.add(tag)
  }
  if (!unreachable.size) return
  const tags = [...unreachable].sort()
  warnings.push({
    code: 'W_DOCUMENT_OUTLIVES_INVALIDATION',
    slot: 'document',
    message:
      `caches the whole document for ${Math.round(held.ttlMs / 1000)}s, and its slots declare ` +
      `${tags.map((t) => `'${t}'`).join(', ')} — which the document policy does not carry. ` +
      `Invalidating ${tags.length === 1 ? 'it' : 'them'} drops the slot entries and leaves the ` +
      `stored document in place, so a reader is served a body rendered before the write. Add ` +
      `${tags.length === 1 ? 'the tag' : 'the tags'} to this route's cache, or give the document ` +
      `no ttl and let the slots decide`,
  })
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

/** The same rules, as a gate. Throws `E_PLAN_INVALID` with a line per error. */
export function assertPlan(plan: Plan, context: ValidateContext): Plan {
  const { errors } = validatePlan(plan, context)
  if (errors.length) {
    const lines = errors.map((e) => `  ${e.code}${e.slot ? ` [${e.slot}]` : ''}: ${e.message}`)
    throw new PlanError(
      'E_PLAN_INVALID',
      `${plan.route} declares ${errors.length} thing${errors.length === 1 ? '' : 's'} the compiler ` +
        `contradicts. Each line names the rule and the slot:\n${lines.join('\n')}`,
    )
  }
  return plan
}
