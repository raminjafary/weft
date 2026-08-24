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

| Code                     | When                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `W_CPU_BUDGET_ADVISORY`  | a CPU budget on anything that is not a separate crash domain, naming the executors where it would be real |
| `W_WAVE_WIDTH`           | the widest wave exceeds the concurrency ceiling; the extra slots queue                                    |
| `W_TTL_UNDECLARED`       | reads the clock and declares no policy, so nothing is cached                                              |
| `W_TTL_ON_STATIC`        | a TTL on a fragment that reads nothing and resolves at build time                                         |
| `W_INCREMENTAL_NO_GRAPH` | `.incremental()` with no derived values, so the input hashing is pure overhead                            |
| `W_HOP_COUNT`            | the fan-out is within 20% of the platform's subrequest ceiling, and a region that fans out adds its own   |

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

## Where a slot may render

A slot's executor decides where its render happens, and until now nothing checked that against what
the compiler saw the fragment read. `E_RENDER_LOCATION` is that check, and both halves of it already
existed — which is why it is a build error rather than a convention.

The rule needs one distinction the executor table does not already make: not whether a target is a
separate crash domain, but whether it can see the request. `locusOf` derives three answers.
`inline`, `deferred`, `isolate` and `pool:` are this **process** — a worker thread is a crash domain
and the same request. `client` is the **browser**. `binding:` and `svc:` are another **deployment**.

| Locus     | Refused reads                                | Why                                                                                                                                                                                                                         |
| --------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`  | `identity`, `cookie:*`, `header:*`, `opaque` | There is no request in a browser. A cookie is refused whether or not it is `HttpOnly`, because which one it is is a runtime property and this is a build check — and the one that matters is exactly the one a session uses |
| `remote`  | `opaque`                                     | `ctx.raw()` is a closure over the request, and a closure cannot cross a crash domain — the same constraint that made `JobAddress` necessary                                                                                 |
| `process` | none                                         | It is the request's own thread                                                                                                                                                                                              |

`route:*`, `locale`, `device` and `time` all exist in a browser and are left alone, which is what
makes an island a usable thing rather than a fragment that may read nothing.

**What this deliberately does not decide** is whether a private fragment may render on another
deployment. That is a trust boundary, and only the deployment knows where its own are: a framework
guessing would either refuse a legitimate internal service or wave through a third-party one, and
both are worse than saying so here.

## Regions, and the one thing a plan does not say about them

`region('search')` builds a slot, because a region fills a hole, is dispatched in a wave, may be
cached and degrades on a policy — all of which are a slot's behaviour. What it adds is a locus, a
contract, a CSP fragment, and what happens when the other end is having a bad afternoon.

The locus is `local` or `remote` and never a target. The design's sketch writes
`.remote('svc:search')`; a shell naming the tier would make rolling that region a redeploy of every
shell that names it, so the plan declares the one thing the build needs — whether a boundary is
crossed — and the registry decides which one. The whole of it is in
[`../kernel/composition.md`](../kernel/composition.md), including where a remote region's cache class
comes from, what `hopsOf` counts, and why the count is a floor.

`regionSpecOf` derives what the composer is told from the plan, and it is exported because a region is
composed on three paths — a document request, a refresh over the channel, a route being staged. The
second caller that built that by hand would have been the first to disagree with the plan about a budget
or a fallback, so there is one derivation and three callers.

## What this does not do yet

- **No byte budget enforcement.** `budget({ js, grow })` is parsed and stored. The measurement
  exists in `@weft/bench`; the two are not wired together.
- **No scoped registration.** Fastify-style per-subtree plugin encapsulation is not
  implemented; plugins are global to a kernel.
- **No plugin capabilities.** The capability model is on intents, where the writes are — see
  [`../kernel/authority.md`](../kernel/authority.md). `residency`, `capabilities` and `budget` on the
  _plugin_ type are still declared and read by nothing, and a second gate with a second set of
  failure modes is not worth having before somebody needs it.
- **`refresh` and `speculate` are recorded and unread.** `.incremental()` is read now: it puts a
  content-addressed segment memo on the slot, and `W_INCREMENTAL_NO_GRAPH` fires only when there
  is neither a derived value nor a nested template for it to reuse.
