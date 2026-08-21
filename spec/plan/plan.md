# The plan, and the things it is not allowed to say

The design calls this layer "the actual product". Everything in it is a declaration about
**placement** — where a slot renders, when it refreshes, what it may cost, which form it
prefers — and the checking runs one way only: the plan is validated against what the compiler
inferred, never the other way around.

## What a plan cannot say

There is no key setter. Not on `slot()`, not on `plan()`, not on the plugin surface. **That
absence is the enforcement.** The moment a key can be hand-set it can drift from what the code
reads, and a plugin may add an axis (`planAxis()`) but never write a key.

## The DSL

```ts
plan('/checkout', [
  shell('routes/checkout.tsx#default'),
  guard('session.required', { redirect: '/login' }),

  slot('feed').stream({ prio: 1 }),

  slot('report').executor('pool:heavy').budget({ cpu: '120ms', onExceed: 'placeholder' }),

  slot('prices')
    .stream({ prio: 1 })
    .refresh(every('30s'), { when: and(when.visible, when.focused) })
    .form({ prefer: 'delta', fallback: 'html' })
    .cache('public', { ttl: '60s', tags: ['prices'] }),

  slot('buy-panel').needs('prices'),
])
```

A plan is data. It is not a function that runs, so it can be diffed in review, generated from
a profile, and reordered by a scheduler at runtime.

`guard()` exists so that the 90% case moves to where it belongs. Nearly every real instance of
"I need to set a cookie mid-stream" is actually "I discovered too late that I needed a guard",
and a guard is phase A by construction — a real 302, not a body the client has to interpret.

## What the build refuses

| Code                            | When                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `E_CACHE_POLICY_CONFLICT`       | `.cache('public')` on a fragment the compiler classified private, **naming the read that caused it** |
| `E_TTL_REQUIRED`                | a policy with no `ttl` on a fragment that reads the clock                                            |
| `E_CONSISTENCY_MISMATCH`        | `consistency: 'strong'` against a store that reports `eventual`, naming it                           |
| `E_FORM_UNAVAILABLE`            | preferring a form this template cannot serve, listing the ones it can                                |
| `E_UNKNOWN_EXECUTOR`            | an executor that is not a known shape, or not bound by this deployment                               |
| `E_UNKNOWN_SLOT`                | `.needs()` naming a slot that is not in the plan                                                     |
| `E_NO_SUCH_FRAGMENT`            | a slot rendering a fragment the compiler did not produce                                             |
| `E_DUPLICATE_SLOT`              | the same slot name twice                                                                             |
| `E_PLAN_CYCLE`                  | slots that depend on each other                                                                      |
| `E_BAD_DURATION` / `E_BAD_SIZE` | `every('soon')`, `budget({ js: 'lots' })`                                                            |

The first one is the promise the design makes in the strongest terms it uses, and it now has
something to fire against:

```
E_PLAN_INVALID — /cart
  E_CACHE_POLICY_CONFLICT [summary]: .cache('public') on a fragment the compiler
    classified private. The read that caused it: identity
```

## What the build warns about

| Code                     | When                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `W_CPU_BUDGET_INLINE`    | a CPU budget on `inline`, naming the executors where it would be real          |
| `W_WAVE_WIDTH`           | the widest wave exceeds the concurrency ceiling; the extra slots queue         |
| `W_TTL_UNDECLARED`       | reads the clock and declares no policy, so nothing is cached                   |
| `W_TTL_ON_STATIC`        | a TTL on a fragment that reads nothing and resolves at build time              |
| `W_INCREMENTAL_NO_GRAPH` | `.incremental()` with no derived values, so the input hashing is pure overhead |

`assertPlan()` reports every error at once. A build that surfaces one problem per run is a
build people stop running.

## Plugins

```ts
definePlugin({
  name: '@weft/i18n',
  role: 'enricher',
  reads: ['cookie:locale'],
  provides: ['ctx.locale'],
  planAxis: () => ({ locale: ['en', 'ar', 'ku'] }),
  onRequest: (ctx) => ({ provided: { 'ctx.locale': ctx.cookie('locale') ?? 'en' } }),
})
```

**Declared reads, enforced reads.** A plugin that touches request state it did not declare
throws `E_PLUGIN_UNDECLARED_READ`. This is the single rule that protects effect tracking:
without it one careless plugin silently makes every fragment uncacheable, which is exactly how
caching dies in real codebases. Providing an undeclared key is refused too.

**The graph is inferred.** `reads` and `provides` give the ordering for free — B reads what A
provides, so the edge exists with nobody writing `after: ['A']`. `before`/`after` remain for
the cases data flow cannot express, like a CSP nonce that must be injected before analytics
adds a script tag. Two plugins providing the same key is `E_PLUGIN_AMBIGUOUS`, caught rather
than resolved by load order. A cycle is `E_PLUGIN_CYCLE`.

**Filters short-circuit; enrichers do not.** A filter runs sequentially in phase A and may
return a `Response`. An enricher runs in parallel waves and may not — one that tries is
`E_ENRICHER_RESPONDED`, told to declare itself a filter. Most of what people write as
middleware is an enricher, so most of what is sequential elsewhere is concurrent here without
anyone opting in.

**Non-critical by default.** A plugin that fails is skipped and reported, never fatal, unless
it declares `critical: true`. A plugin over its `timeoutMs` is skipped rather than allowed to
hold the envelope open.

## `weft why`

```
fragment DAG   4 slots | 3 waves | widest 2 | ceiling 6
               timings are unmeasured; run under the harness for real numbers

wave 0   product-core        28.4ms   shared — reads route:sku
         shell                0.2ms   static — reads nothing, so it resolves at build time
wave 1   price-box           12.1ms   shared — reads cookie:currency · Vary: Cookie
wave 2   buy-panel            2.2ms   static — reads nothing, so it resolves at build time

critical path   product-core -> price-box -> buy-panel   =  42.7ms
                this, not the sum, is the floor for a complete page.
                a sequential root-to-leaf walk would have been 42.9ms.

suggestion      price-box is on the critical path and needs only product-core; hoisting
                that read into wave 0 would shorten it
```

Two rules about what it prints. A timing that was not measured is **labelled** as unmeasured,
because a report that quietly mixes measured and estimated numbers is worse than one with no
numbers. And the only suggestion made is the one derivable without guessing — a slot on the
critical path with exactly one upstream result is a hoisting candidate, and the report says so
without inventing an estimate for the improvement.

Passed `resolved` keys, it prints them too, which is the same function answering the runtime
question instead of the build one.

## Fixtures

`packages/plan/fixtures/cart.ts` is one valid plan over the design's `/cart`, nine plans that
must be refused, and four that must warn. `SlotFacts` are **derived from the compiled entry**
rather than written down, so a fixture asserting `E_CACHE_POLICY_CONFLICT` earns it from real
effect inference — change what `private.tsx` reads and the fixture stops failing, which is the
coupling a fixture of a refusal should have.

`packages/kernel/fixtures/plugins.ts` is a five-plugin stack, because the interesting
properties of this layer only appear above two. It orders itself into two waves with nobody
writing a priority integer, and `@weft/csp` is in it specifically to justify `before`: a nonce
has to precede anything that adds a script tag, and no read/write relationship captures that.

## What this does not do yet

- **Nothing generates a plan.** `lowerPlan` turns one into a route (see
  [routing](../kernel/routing.md)) and `factsFrom` derives its inputs from compiler output, but
  the plan and its bindings are still written by hand. Generating them from a file convention or
  a profile is phase 8.
- **No byte budget enforcement.** `budget({ js, grow })` is parsed and stored. The measurement
  exists in `@weft/bench`; the two are not wired together.
- **No scoped registration.** Fastify-style per-subtree plugin encapsulation is not
  implemented; plugins are global to a kernel.
- **No client plugins, no capability grants, no residency checking.** `residency`,
  `capabilities` and `budget` are declared on the plugin type and read by nothing.
- **`refresh`, `speculate` and `incremental` are recorded and unread.**
