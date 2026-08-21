import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheClassOf } from '../../ir/src/index.ts'
import { KEYED, LINES, OPAQUE, PRIVATE, SHELL } from '../../kernel/fixtures/cart-route.ts'
import { cart, complaints, contradictions, facts } from '../fixtures/cart.ts'
import { assertPlan, validatePlan, why } from '../src/index.ts'

/**
 * The plan layer against real compiler output rather than hand-written effect sets. A fixture
 * that asserts a build error has to earn it from real effect inference, so changing what
 * `private.tsx` reads breaks this file instead of quietly agreeing with a stale copy.
 */
const store = { consistency: 'eventual' as const, name: 'workers-kv' }

test('the compiler classifies the fixtures the way the plan fixtures assume', async () => {
  const f = await facts()
  assert.equal(cacheClassOf(f[KEYED]!.effects), 'shared')
  assert.equal(cacheClassOf(f[PRIVATE]!.effects), 'private')
  assert.equal(cacheClassOf(f[OPAQUE]!.effects), 'private')

  // The reads that make the refusals below refusals.
  assert.ok(f[KEYED]!.effects.reads.includes('time'))
  assert.ok(f[PRIVATE]!.effects.reads.includes('identity'))
  assert.ok(f[OPAQUE]!.effects.reads.includes('opaque'))

  // Derived rather than declared: a shell has slot holes, so it cannot serve `delta`.
  assert.ok(!f[SHELL]!.forms.includes('delta'))
  assert.ok(f[LINES]!.forms.includes('delta'))
})

test('the cart plan is valid against what the compiler inferred', async () => {
  const diagnostics = validatePlan(cart, { facts: await facts() })
  assert.deepEqual(diagnostics.errors, [])
  assert.deepEqual(diagnostics.warnings, [])
})

test('every contradiction fixture is refused, and by the code it exists for', async () => {
  const f = await facts()
  const expected: Record<string, string> = {
    publicOnPrivate: 'E_CACHE_POLICY_CONFLICT',
    policyWithoutTtl: 'E_TTL_REQUIRED',
    deltaOnAShell: 'E_FORM_UNAVAILABLE',
    publicOnOpaque: 'E_CACHE_POLICY_CONFLICT',
    strongOnEventual: 'E_CONSISTENCY_MISMATCH',
    unknownExecutor: 'E_UNKNOWN_EXECUTOR',
    unknownDependency: 'E_UNKNOWN_SLOT',
    missingFragment: 'E_NO_SUCH_FRAGMENT',
    cycle: 'E_PLAN_CYCLE',
  }

  for (const [name, plan] of Object.entries(contradictions)) {
    const { errors } = validatePlan(plan, { facts: f, store })
    const codes = errors.map((e) => e.code)
    assert.ok(codes.includes(expected[name] as string), `${name}: got ${codes.join(', ') || 'nothing'}`)
  }
})

test('the private refusal names the read that caused it, from real inference', async () => {
  const { errors } = validatePlan(contradictions.publicOnPrivate!, { facts: await facts() })
  const conflict = errors.find((e) => e.code === 'E_CACHE_POLICY_CONFLICT')
  assert.match(conflict?.message ?? '', /The read that caused it: identity/)
})

test('the opaque refusal names its own read, not identity', async () => {
  const { errors } = validatePlan(contradictions.publicOnOpaque!, { facts: await facts() })
  const conflict = errors.find((e) => e.code === 'E_CACHE_POLICY_CONFLICT')
  assert.match(conflict?.message ?? '', /The read that caused it: opaque/)
})

test('the shell is told which forms it can actually serve', async () => {
  const { errors } = validatePlan(contradictions.deltaOnAShell!, { facts: await facts() })
  const unavailable = errors.find((e) => e.code === 'E_FORM_UNAVAILABLE')
  assert.match(unavailable?.message ?? '', /it can serve html, bundle, split, patch/)
})

test('every complaint fixture warns and none of them fails the build', async () => {
  const f = await facts()
  const expected: Record<string, string> = {
    inlineCpuBudget: 'W_CPU_BUDGET_INLINE',
    clockWithoutPolicy: 'W_TTL_UNDECLARED',
    incrementalWithoutGraph: 'W_INCREMENTAL_NO_GRAPH',
    tooWide: 'W_WAVE_WIDTH',
  }
  for (const [name, plan] of Object.entries(complaints)) {
    const { errors, warnings } = validatePlan(plan, { facts: f })
    assert.deepEqual(errors, [], `${name} should warn, not fail`)
    assert.ok(
      warnings.some((w) => w.code === expected[name]),
      `${name}: got ${warnings.map((w) => w.code).join(', ') || 'nothing'}`,
    )
  }
})

test('assertPlan reports every error in one throw', async () => {
  const f = await facts()
  assert.throws(() => assertPlan(contradictions.publicOnPrivate!, { facts: f }), /E_PLAN_INVALID/)
  assert.equal(assertPlan(cart, { facts: f }), cart)
})

test('weft why over the cart plan explains each slot from its real effect set', async () => {
  const report = why({ plan: cart, facts: await facts() })
  assert.equal(report.measured, false)
  assert.deepEqual(report.criticalPath, ['prices', 'lines'])
  assert.match(report.text, /prices .* shared . reads cookie:currency/)
  assert.match(report.text, /greeting .* private . reads cookie:currency, identity/)
  assert.match(report.text, /banner .* private . reads opaque/)
  assert.match(report.text, /needs a TTL/)
})
