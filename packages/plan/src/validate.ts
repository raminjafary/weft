import { cacheClassOf, requiresTtl, type EffectSet, type WireForm } from '@weft/ir'
import { type Consistency, type DagNode, PlanGraphError, schedule, W_CPU_BUDGET_ADVISORY } from '@weft/kernel'
import { PlanError, type Plan, type SlotSpec } from './dsl.ts'

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

  // Last, so a whole-plan complaint never masks the specific slot that is wrong.
  const shell = checkShell(plan, context, errors)
  checkDocument(plan, shell, context, errors)

  return { errors, warnings }
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
