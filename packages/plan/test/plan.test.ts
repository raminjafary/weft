import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EffectSet } from '@weft/ir'
import {
  and,
  assertPlan,
  every,
  guard,
  plan,
  shell,
  slot,
  validatePlan,
  when,
  why,
  type PlanOptions,
  type SlotBuilder,
  type SlotFacts,
} from '../src/index.ts'

function effects(reads: string[]): EffectSet {
  return { reads: [...reads].sort(), writes: [], envelope: [], residency: reads.length ? 'server' : 'either' }
}

function facts(reads: string[], extra: Partial<SlotFacts> = {}): SlotFacts {
  return {
    id: 'fragment',
    version: 'v1',
    effects: effects(reads),
    forms: ['html', 'bundle', 'split', 'patch', 'delta'],
    ...extra,
  }
}

const SHELL = 'shell.tsx#default'

/**
 * A plan is only complete with a document to fill, so these unit tests build one: a shell
 * whose boundaries are exactly the slots declared. Anything else is a different error, and
 * there are tests for those below.
 */
function route(
  entries: SlotBuilder[],
  f: Record<string, SlotFacts> = {},
  options: PlanOptions = {},
): { plan: ReturnType<typeof plan>; facts: Record<string, SlotFacts> } {
  const names = entries.map((entry) => entry.spec.name)
  return {
    plan: plan('/cart', [shell(SHELL), ...entries], options),
    facts: { ...f, [SHELL]: facts([], { fillable: names }) },
  }
}

test('a duration is parsed, and a bad one is refused rather than coerced', () => {
  assert.equal(every('30s'), 30_000)
  assert.equal(every('250ms'), 250)
  assert.equal(every(1500), 1500)
  assert.throws(() => every('soon'), /E_BAD_DURATION/)
})

test('conditions compose without order mattering', () => {
  assert.deepEqual(and(when.visible, when.focused), { all: ['focused', 'visible'] })
  assert.deepEqual(and(when.focused, when.visible), { all: ['focused', 'visible'] })
})

test('the design’s own declaration builds', () => {
  const p = plan('/checkout', [
    guard('session.required', { redirect: '/login' }),
    slot('feed').stream({ prio: 1 }),
    slot('report').executor('pool:heavy').budget({ cpu: '120ms', onExceed: 'placeholder' }),
    slot('prices')
      .stream({ prio: 1 })
      .refresh(every('30s'), { when: and(when.visible, when.focused) })
      .form({ prefer: 'delta', fallback: 'html' }),
  ])
  assert.deepEqual(
    p.slots.map((s) => s.name),
    ['feed', 'report', 'prices'],
  )
  assert.deepEqual(p.guards, [{ name: 'session.required', redirect: '/login' }])
  assert.equal(p.slots[1]?.budget?.cpuMs, 120)
  assert.equal(p.slots[2]?.refresh?.everyMs, 30_000)
})

test('a slot declared twice is caught at build', () => {
  assert.throws(() => plan('/x', [slot('a'), slot('a')]), /E_DUPLICATE_SLOT/)
})

test('a public policy on a slot that reads identity fails the build, naming the read', () => {
  const r = route([slot('summary').cache('public', { ttl: '60s' })], {
    summary: facts(['identity', 'cookie:currency']),
  })
  const { errors } = validatePlan(r.plan, { facts: r.facts })
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.code, 'E_CACHE_POLICY_CONFLICT')
  assert.match(errors[0]?.message ?? '', /The read that caused it: identity/)
})

test('a private policy on the same slot is fine', () => {
  const r = route([slot('summary').cache('private', { ttl: '60s' })], { summary: facts(['identity']) })
  assert.deepEqual(validatePlan(r.plan, { facts: r.facts }).errors, [])
})

test('a policy with no ttl on a slot that reads the clock fails the build', () => {
  const r = route([slot('feed').cache('public')], { feed: facts(['time']) })
  const { errors } = validatePlan(r.plan, { facts: r.facts })
  assert.deepEqual(
    errors.map((e) => e.code),
    ['E_TTL_REQUIRED'],
  )
})

test('a strong policy against an eventual store is a build error, not a surprise', () => {
  const r = route([slot('feed').cache('public', { ttl: '60s', consistency: 'strong' })], {
    feed: facts([]),
  })
  const { errors } = validatePlan(r.plan, {
    facts: r.facts,
    store: { consistency: 'eventual', name: 'workers-kv' },
  })
  assert.equal(errors[0]?.code, 'E_CONSISTENCY_MISMATCH')
  assert.match(errors[0]?.message ?? '', /workers-kv/)
})

test('preferring a form the template cannot serve is refused', () => {
  const r = route([slot('feed').form({ prefer: 'delta' })], {
    feed: facts([], { forms: ['html', 'bundle', 'split', 'patch'] }),
  })
  const { errors } = validatePlan(r.plan, { facts: r.facts })
  assert.equal(errors[0]?.code, 'E_FORM_UNAVAILABLE')
})

test('a cpu budget on an inline slot is a warning that names the fix', () => {
  const r = route([slot('report').budget({ cpu: '120ms' })], { report: facts([]) })
  const { errors, warnings } = validatePlan(r.plan, { facts: r.facts })
  assert.deepEqual(errors, [])
  assert.equal(warnings[0]?.code, 'W_CPU_BUDGET_ADVISORY')
  assert.match(warnings[0]?.message ?? '', /pool:, isolate, binding:, or svc:/)
})

test('the same budget on a preemptible executor is silent', () => {
  const r = route([slot('report').executor('pool:heavy').budget({ cpu: '120ms' })], {
    report: facts([]),
  })
  assert.deepEqual(validatePlan(r.plan, { facts: r.facts }).warnings, [])
})

test('an executor this deployment does not bind is named', () => {
  const r = route([slot('reviews').executor('svc:reviews')], { reviews: facts([]) })
  const { errors } = validatePlan(r.plan, { facts: r.facts, executors: ['pool:heavy'] })
  assert.equal(errors[0]?.code, 'E_UNKNOWN_EXECUTOR')
  assert.match(errors[0]?.message ?? '', /pool:heavy/)
})

test('a nonsense executor is refused whether or not a binding list was supplied', () => {
  const r = route([slot('reviews').executor('magic')], { reviews: facts([]) })
  assert.equal(validatePlan(r.plan, { facts: r.facts }).errors[0]?.code, 'E_UNKNOWN_EXECUTOR')
})

test('a dependency on a slot outside the plan is refused', () => {
  const r = route([slot('buy').needs('price-box')], { buy: facts([]) })
  const { errors } = validatePlan(r.plan, { facts: r.facts })
  assert.deepEqual(errors.map((e) => e.code).sort(), ['E_UNKNOWN_SLOT'])
})

test('a plan referencing a fragment the compiler never produced is refused', () => {
  const r = route([slot('ghost')])
  assert.equal(validatePlan(r.plan, { facts: r.facts }).errors[0]?.code, 'E_NO_SUCH_FRAGMENT')
})

test('a wave wider than the ceiling warns rather than melting a database quietly', () => {
  const p = plan(
    '/wide',
    Array.from({ length: 9 }, (_, i) => slot(`s${i}`)),
    { maxConcurrency: 4 },
  )
  const f = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, facts([])]))
  const { warnings } = validatePlan(p, { facts: f })
  assert.equal(warnings[0]?.code, 'W_WAVE_WIDTH')
})

test('incremental recompute on a slot with no graph to memoize is called out as overhead', () => {
  const r = route([slot('feed').incremental()], { feed: facts([], { derivedCount: 0 }) })
  const { warnings } = validatePlan(r.plan, { facts: r.facts })
  assert.equal(warnings[0]?.code, 'W_INCREMENTAL_NO_GRAPH')
})

test('assertPlan throws with every error listed at once', () => {
  const r = route([slot('a').cache('public'), slot('b').executor('magic')], {
    a: facts(['identity', 'time']),
    b: facts([]),
  })
  assert.throws(
    () => assertPlan(r.plan, { facts: r.facts }),
    /E_PLAN_INVALID[\s\S]*E_CACHE_POLICY_CONFLICT[\s\S]*E_TTL_REQUIRED[\s\S]*E_UNKNOWN_EXECUTOR/,
  )
})

test('weft why reports waves, the critical path, and that timings are estimates', () => {
  const slots = [
    slot('masthead'),
    slot('product-core'),
    slot('price-box').needs('product-core'),
    slot('buy-panel').needs('price-box'),
  ]
  const { plan: p, facts: f } = route(slots, {
    masthead: facts([]),
    'product-core': facts(['route:sku']),
    'price-box': facts(['cookie:currency']),
    'buy-panel': facts([]),
  })

  const unmeasured = why({ plan: p, facts: f })
  assert.equal(unmeasured.measured, false)
  assert.match(unmeasured.text, /timings are unmeasured/)

  const measured = why({
    plan: p,
    facts: f,
    timings: { masthead: 0.2, 'product-core': 28.4, 'price-box': 12.1, 'buy-panel': 2.2 },
  })
  assert.equal(measured.measured, true)
  assert.deepEqual(measured.criticalPath, ['product-core', 'price-box', 'buy-panel'])
  assert.equal(Number(measured.criticalMs.toFixed(1)), 42.7)
  assert.match(measured.text, /critical path   product-core -> price-box -> buy-panel/)
  assert.match(measured.text, /sequential root-to-leaf walk would have been 42.9ms/)
  assert.match(measured.text, /price-box.*shared . reads cookie:currency/)
  assert.doesNotMatch(measured.text, /unmeasured/)
})

test('weft why prints resolved keys when it is asked at request time', () => {
  const r = route([slot('summary')], { summary: facts(['cookie:currency']) })
  const report = why({
    plan: r.plan,
    facts: r.facts,
    resolved: {
      summary: {
        key: 'deadbeef',
        class: 'shared',
        components: { 'cookie:currency': 'IQD' },
        axes: {},
        vary: ['Cookie'],
        ttlRequired: false,
        reason: 'shared | keyed by cookie:currency=IQD',
      },
    },
  })
  assert.match(report.text, /summary\s+deadbeef\s+shared \| keyed by cookie:currency=IQD/)
})
