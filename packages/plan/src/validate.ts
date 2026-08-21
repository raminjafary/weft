import { cacheClassOf, requiresTtl, type EffectSet, type WireForm } from '../../ir/src/index.ts'
import { W_CPU_BUDGET_INLINE } from '../../kernel/src/executor.ts'
import { schedule, PlanGraphError, type DagNode } from '../../kernel/src/waves.ts'
import type { Consistency } from '../../kernel/src/ports.ts'
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
  /** Whether the fragment has anything a memoized recompute could skip. */
  derivedCount?: number
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

  return { errors, warnings }
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

function checkBudget(spec: SlotSpec, warnings: Issue[]): void {
  if (spec.budget?.cpuMs === undefined) return
  if (spec.executor === 'inline') {
    warnings.push({ code: 'W_CPU_BUDGET_INLINE', slot: spec.name, message: W_CPU_BUDGET_INLINE })
  }
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
  if ((facts.derivedCount ?? 0) === 0) {
    warnings.push({
      code: 'W_INCREMENTAL_NO_GRAPH',
      slot: spec.name,
      message:
        'declares .incremental() but has no derived values to memoize, so the input hashing is pure overhead',
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
