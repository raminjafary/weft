import { compileFixtures, KEYED, LINES, OPAQUE, PRIVATE, SHELL } from '../../kernel/fixtures/cart-route.ts'
import { and, every, guard, plan, slot, when, type Plan } from '../src/dsl.ts'
import type { SlotFacts } from '../src/validate.ts'

/**
 * Plans over fragments the compiler actually produced.
 *
 * `SlotFacts` are derived from the compiled entry rather than written down, which is the
 * whole claim of this layer: the plan is checked against what was inferred, so a fixture
 * asserting a build error has to earn it from real effect inference. Change what
 * `private.tsx` reads and `contradictions.publicOnPrivate` stops failing — which is exactly
 * the coupling you want a fixture to have.
 */
export const FIXTURES = [SHELL, KEYED, PRIVATE, OPAQUE, LINES] as const

export async function facts(): Promise<Record<string, SlotFacts>> {
  const compiled = await compileFixtures(FIXTURES)
  const out: Record<string, SlotFacts> = {}
  for (const [file, fixture] of Object.entries(compiled)) {
    out[file] = {
      id: fixture.entry.id,
      version: fixture.entry.version,
      effects: fixture.entry.effects,
      forms: fixture.entry.forms,
      derivedCount: fixture.entry.derived.length,
    }
  }
  return out
}

/**
 * The design's `/cart`, expressed over those fixtures. Every declaration here is about
 * placement, and none of it states a key.
 */
export const cart: Plan = plan(
  '/cart',
  [
    guard('session.required', { redirect: '/login' }),

    slot('prices')
      .fragment(KEYED)
      .stream({ prio: 1 })
      // keyed.tsx reads the clock, so a policy without a ttl would be a build error
      .cache('public', { ttl: '60s', swr: '5m', tags: ['prices'] })
      .refresh(every('30s'), { when: and(when.visible, when.focused) })
      .form({ prefer: 'html', fallback: 'html' }),

    slot('greeting').fragment(PRIVATE).cache('private'),

    slot('banner').fragment(OPAQUE),

    slot('lines')
      .fragment(LINES)
      .stream({ prio: 2 })
      // lines.tsx is value-projectable throughout, so delta is derivable rather than declared
      .form({ prefer: 'delta', fallback: 'html' })
      .needs('prices'),
  ],
  { maxConcurrency: 4 },
)

/**
 * One plan per refusal. These are fixtures for the errors, because a compiler whose value is
 * what it refuses has to make refusal reproducible — every one of these is a line somebody
 * will plausibly write.
 */
export const contradictions: Record<string, Plan> = {
  /** The promise the design makes in its strongest terms. */
  publicOnPrivate: plan('/cart', [slot('greeting').fragment(PRIVATE).cache('public', { ttl: '60s' })]),

  /** keyed.tsx reads the clock, so a policy with no ttl never expires. */
  policyWithoutTtl: plan('/cart', [slot('prices').fragment(KEYED).cache('public')]),

  /** The shell has slot holes, so it cannot be projected from values a client holds. */
  deltaOnAShell: plan('/cart', [slot('shell').fragment(SHELL).form({ prefer: 'delta' })]),

  /** `ctx.raw()` leaves tracking, so there is no key and no honest public policy. */
  publicOnOpaque: plan('/cart', [slot('banner').fragment(OPAQUE).cache('public', { ttl: '60s' })]),

  strongOnEventual: plan('/cart', [
    slot('lines').fragment(LINES).cache('public', { ttl: '60s', consistency: 'strong' }),
  ]),

  unknownExecutor: plan('/cart', [slot('lines').fragment(LINES).executor('magic')]),

  unknownDependency: plan('/cart', [slot('lines').fragment(LINES).needs('nothing-declares-this')]),

  missingFragment: plan('/cart', [slot('ghost').fragment('packages/compiler/fixtures/nope.tsx')]),

  cycle: plan('/cart', [slot('a').fragment(LINES).needs('b'), slot('b').fragment(LINES).needs('a')]),
}

/** Warnings, which are not failures and still have to be produced. */
export const complaints: Record<string, Plan> = {
  /** A cpu budget on inline, where nothing can preempt a synchronous render. */
  inlineCpuBudget: plan('/cart', [slot('lines').fragment(LINES).budget({ cpu: '120ms' })]),

  /** Reads the clock and declares nothing, so nothing is cached and nothing expires. */
  clockWithoutPolicy: plan('/cart', [slot('prices').fragment(KEYED)]),

  /** Memoisation with no derived values to memoize is pure input hashing. */
  incrementalWithoutGraph: plan('/cart', [slot('greeting').fragment(PRIVATE).incremental()]),

  /** Nine independent slots against a ceiling of four. */
  tooWide: plan(
    '/cart',
    Array.from({ length: 9 }, (_, i) => slot(`s${i}`).fragment(LINES)),
    { maxConcurrency: 4 },
  ),
}
