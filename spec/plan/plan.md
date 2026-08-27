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
  name: '@weftjs/i18n',
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
writing a priority integer, and `@weftjs/csp` is in it specifically to justify `before`: a nonce
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

`hopsOf` counts the regions a route declares, which is every boundary a build can see: what a region
composes is resolved by _that_ region's registry, so a second tier is not a name this deployment could
resolve. `verifyRegions(plans, context, probe)` is where the rest of it appears — with a probe it
returns a `graph` per route, assembled from what each tier answered about itself, and
`W_REGION_TREE_DEEPER` when a route turns out to cross more boundaries than its plan counted. That is
not an error: a region composing regions is its own deployment's decision. It is the number the
latency budget was written against, arriving from a command rather than from production.

`regionSpecOf` derives what the composer is told from the plan, and it is exported because a region is
composed on three paths — a document request, a refresh over the channel, a route being staged. The
second caller that built that by hand would have been the first to disagree with the plan about a budget
or a fallback, so there is one derivation and three callers.

## The four declarations that were recorded and read by nothing

A plan is data, which makes it easy to add a field to and easy to leave unread. Four were, and each
one turned out to mean something slightly different from what its name suggested.

**`budget({ js })` is enforced, and it is not per slot.** The declaration is per slot because the
design was describing a framework with a bundler: chunks per route, an island in one of them, a
number per slot. There is no bundler here — a page loads the boot module and whatever it imports,
the same set on every route — so there is no per-slot JavaScript to measure. `weft build` measures
what a page downloads by walking that graph and compressing each response the way it arrives, and a
declared ceiling the measurement breaks fails the build. The failure names the route, the slot that
declared the number, and the measurement, and then says plainly that the excess is the application's
client rather than that slot's share of it: attribution nobody can compute is attribution nobody
should print. Wiring it also reversed a claim this repository was publishing about itself — see
[`FINDINGS.md`](../FINDINGS.md).

**`grow` needs no bundler at all.** A ceiling alone produces permanent silence just under it; a
growth cap notices the afternoon somebody added 900 bytes. The baseline is `weft.budget.json` beside
the application's config rather than a query against a branch, because a baseline nobody can commit
only ever compares a machine to itself.

**Scoped registration is a property of the graph, not a check on the request.** `Plugin.scope` is a
path prefix, and `resolveScoped` resolves one schedule per prefix at build time — so two plugins
that would be ambiguous together are not ambiguous under `/admin` and `/shop`, each scope's ordering
and cycles are checked within it, and a route carries the schedule that applies to it. The request
path pays a `??` and never a prefix walk: two bytes of brotli, which is what encapsulation costs
when it is resolved rather than evaluated.

**`residency` and `capabilities` are checked where the plugin is registered.** A plugin whose
residency is `client` or `build` may not carry an `onRequest` — nothing would ever call it, and that
is `E_PLUGIN_RESIDENCY`. A plugin declaring a capability no role can grant is
`E_PLUGIN_CAPABILITY_UNGRANTABLE`, which is the rule an intent already lives by, applied at the
other registration point rather than becoming a second gate with its own failure modes. Both are in
`resolvePlugins`, which is build-time and off the request path. There is no `budget` on the plugin
type and this document used to say there was.

**`refresh` is the fallback the design named and nothing implemented.** A region on another
deployment holds its own cache keys, so a `STALE` about them has nobody to tell, and the design's
answer is the client's own interval — recorded in the plan, warned about at build time, asked on by
nobody. It travels in the adopt payload now, and the client asks under the conditions the plan
declared: `visible` by default, because a background tab polling forever is the failure mode that
makes people turn intervals off. Conditions are checked when the timer fires rather than by starting
and stopping it, so the cadence a deployment declared survives somebody switching windows.

**`speculate` is about a clock, not about a reader.** A slot with a TTL has one request per period
that pays for a render, and it is always somebody's. `.speculate()` moves that render to _after_ a
response, through `StorePort.revalidateAfterResponse` — which existed, collected tasks, and was
drained by nobody. It is deliberately not prefetching a route on a guess: guessing where a reader
goes next is what a staged route already does, paid for by their own hover. `'profile'` leaves the
decision to a measurement rather than to the declaration.

## What this does not do yet

- **A `js` budget cannot be attributed to a slot**, and the refusal says so rather than implying
  otherwise. That is a property of having no bundler, not an omission: there is nothing to attribute
  until a page's JavaScript can differ from another page's.
- **`speculate: 'profile'` is carried as its own mode and decided by the recorder's own numbers.**
  A slot the profile has never seen render is a slot nothing knows the cost of, and warming it on a
  guess is work that looks like a feature and reads like a leak.
