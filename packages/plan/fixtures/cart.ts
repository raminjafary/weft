import {
  compileFixtures,
  fragmentId,
  KEYED,
  LINES,
  OPAQUE,
  PRIVATE,
  SHELL,
} from '../../kernel/fixtures/cart-route.ts'
import { factsFrom } from '../src/facts.ts'
import { and, every, guard, plan, shell, slot, when, type Plan } from '../src/dsl.ts'
import type { SlotFacts } from '../src/validate.ts'

/**
 * Plans over fragments the compiler actually produced.
 *
 * `SlotFacts` are derived from the compiled entry rather than written down, which is the whole
 * claim of this layer: the plan is checked against what was inferred, so a fixture asserting a
 * build error has to earn it from real effect inference. Change what `private.tsx` reads and
 * `contradictions.publicOnPrivate` stops failing — which is exactly the coupling you want a
 * fixture to have.
 *
 * Fragments are named the way the compiler names them, `module#export`, because that is what a
 * generated plan would emit and a second naming scheme is a second thing to keep in sync.
 */
export const FIXTURES = [SHELL, KEYED, PRIVATE, OPAQUE, LINES] as const

export const SHELL_ID = fragmentId(SHELL)
export const KEYED_ID = fragmentId(KEYED)
export const PRIVATE_ID = fragmentId(PRIVATE)
export const OPAQUE_ID = fragmentId(OPAQUE)
export const LINES_ID = fragmentId(LINES)

export async function facts(): Promise<Record<string, SlotFacts>> {
  const compiled = await compileFixtures(FIXTURES)
  return factsFrom(Object.values(compiled).map((fixture) => ({ fragments: [{ entry: fixture.entry }] })))
}

/**
 * The design's `/cart`. `shell.tsx` leaves exactly two boundaries — `cartLines` and `recs` —
 * so the plan fills exactly those two. Naming a third, or leaving one of them out, is a build
 * error rather than an empty region in production.
 */
export const cart: Plan = plan(
  '/cart',
  [
    shell(SHELL_ID),
    guard('session.required', { redirect: '/login' }),

    slot('cartLines')
      .fragment(KEYED_ID)
      .stream({ prio: 1 })
      // keyed.tsx reads the clock, so a policy without a ttl would be a build error
      .cache('public', { ttl: '60s', swr: '5m', tags: ['prices'] })
      .refresh(every('30s'), { when: and(when.visible, when.focused) })
      .form({ prefer: 'html', fallback: 'html' }),

    slot('recs').fragment(PRIVATE_ID).cache('private'),
  ],
  { maxConcurrency: 4 },
)

/**
 * A second route, so the router has something to choose between and a param has somewhere to
 * come from. `route:sku` becomes a key component without the plan mentioning keys at all.
 */
export const product: Plan = plan('/product/:sku', [
  shell(SHELL_ID),
  slot('cartLines').fragment(LINES_ID).stream({ prio: 1 }).form({ prefer: 'delta', fallback: 'html' }),
  slot('recs').fragment(OPAQUE_ID).buffered(),
])

/** Every slot buffers, so this lowers to `in-order` and costs no fill mechanism. */
export const quiet: Plan = plan('/quiet', [
  shell(SHELL_ID),
  slot('cartLines').fragment(LINES_ID).buffered(),
  slot('recs').fragment(LINES_ID).buffered(),
])

/**
 * One plan per refusal. These are fixtures for the errors, because a layer whose value is what
 * it refuses has to make refusal reproducible — every one of these is a line somebody will
 * plausibly write.
 */
export const contradictions: Record<string, Plan> = {
  /** The promise the design makes in its strongest terms. */
  publicOnPrivate: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(KEYED_ID).cache('public', { ttl: '60s' }),
    slot('recs').fragment(PRIVATE_ID).cache('public', { ttl: '60s' }),
  ]),

  /** keyed.tsx reads the clock, so a policy with no ttl never expires. */
  policyWithoutTtl: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(KEYED_ID).cache('public'),
    slot('recs').fragment(LINES_ID),
  ]),

  /** The shell has slot holes, so it cannot be projected from values a client holds. */
  deltaOnAShell: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(SHELL_ID).form({ prefer: 'delta' }),
    slot('recs').fragment(LINES_ID),
  ]),

  /** `ctx.raw()` leaves tracking, so there is no key and no honest public policy. */
  publicOnOpaque: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(OPAQUE_ID).cache('public', { ttl: '60s' }),
    slot('recs').fragment(LINES_ID),
  ]),

  strongOnEventual: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).cache('public', { ttl: '60s', consistency: 'strong' }),
    slot('recs').fragment(LINES_ID),
  ]),

  unknownExecutor: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).executor('magic'),
    slot('recs').fragment(LINES_ID),
  ]),

  unknownDependency: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).needs('nothing-declares-this'),
    slot('recs').fragment(LINES_ID),
  ]),

  missingFragment: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment('packages/compiler/fixtures/nope.tsx#default'),
    slot('recs').fragment(LINES_ID),
  ]),

  cycle: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).needs('recs'),
    slot('recs').fragment(LINES_ID).needs('cartLines'),
  ]),

  /** A plan with slots and no document for them to fill. */
  noShell: plan('/cart', [slot('cartLines').fragment(LINES_ID), slot('recs').fragment(LINES_ID)]),

  /** A boundary the shell does not leave. Naming a hole is not the same as having one. */
  slotNotInShell: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID),
    slot('recs').fragment(LINES_ID),
    slot('sidebar').fragment(LINES_ID),
  ]),

  /** A boundary the shell leaves and nothing fills. */
  holeUnfilled: plan('/cart', [shell(SHELL_ID), slot('cartLines').fragment(LINES_ID)]),

  /** A public document over a private region. */
  publicDocument: plan(
    '/cart',
    [shell(SHELL_ID), slot('cartLines').fragment(LINES_ID), slot('recs').fragment(PRIVATE_ID)],
    { cache: { class: 'public', ttl: '60s' } },
  ),
}

/** Warnings, which are not failures and still have to be produced. */
export const complaints: Record<string, Plan> = {
  /** A cpu budget on inline, where nothing can preempt a synchronous render. */
  inlineCpuBudget: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).budget({ cpu: '120ms' }),
    slot('recs').fragment(LINES_ID),
  ]),

  /** Reads the clock and declares nothing, so nothing is cached and nothing expires. */
  clockWithoutPolicy: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(KEYED_ID),
    slot('recs').fragment(LINES_ID),
  ]),

  /**
   * A ttl on a slot that reads nothing, which is a ttl with nothing to expire.
   *
   * Worth a warning rather than an error: it is harmless, and the author probably meant it for a
   * different slot. `LINES` reads nothing, so its class is static and the declaration is inert.
   */
  ttlOnStatic: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).cache('public', { ttl: '1h' }),
    slot('recs').fragment(LINES_ID),
  ]),

  /** Memoisation with no derived values to memoize is pure input hashing. */
  incrementalWithoutGraph: plan('/cart', [
    shell(SHELL_ID),
    slot('cartLines').fragment(PRIVATE_ID).incremental(),
    slot('recs').fragment(LINES_ID),
  ]),

  /** Two independent slots against a ceiling of one: they queue rather than melt anything. */
  tooWide: plan(
    '/cart',
    [shell(SHELL_ID), slot('cartLines').fragment(LINES_ID), slot('recs').fragment(LINES_ID)],
    { maxConcurrency: 1 },
  ),
}
