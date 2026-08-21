# Ports, and the rule that makes them possible

A port has exactly one active implementation and answers _who does this job_. A plugin adds
behaviour at a defined point and answers _what else happens here_. Conflating the two is how
plugin systems become unmaintainable, so they are separate concepts with separate files.

## The rule the kernel is built against

> The kernel imports nothing but the WinterTC Minimum Common Web API.

Not a preference — a constraint on what the kernel is allowed to know, which is what turns
"runs on Workers" into a property rather than a porting exercise. It is enforced by
`packages/kernel/test/standards.test.ts`, which fails the build on:

- any `from 'node:…'` import under `packages/kernel/src`
- `process.`, `Buffer`, CommonJS `require(`, `__dirname`
- a relative import reaching outside `@weft/ir` and `@weft/warp`, the two versioned wire
  packages
- kernel source growing past 2,900 lines — a smell detector for the kernel absorbing work that
  belongs in a port, not the real gate. It moved from 2,500 when routing was added, because
  routing is one of the four jobs the design gives a kernel

`serveRoute` used to live in the kernel and imported `node:http`. It moved to
`@weft/adapters` when the gate was written, which is the gate doing its job on its first
run.

## Measured

| Entry                                      | brotli   | Ceiling                                 |
| ------------------------------------------ | -------- | --------------------------------------- |
| `entry-request.ts` — document path         | 7,999 B  | 8,192 B, from the design's "under 8 KB" |
| `entry-channel.ts` — plus refresh, epochs  | 10,221 B | 12,288 B, no design figure, a watermark |
| `entry-transport.ts` — plus a live channel | 12,343 B | 13,312 B, no design figure, a watermark |

193 bytes of headroom on the claim, now that the route matcher is in the figure. The whole
barrel (`index.ts`, including build-time validation and serialisation) is 11,601 B and is
deliberately **not** the entry the claim is measured against — a deployment serving documents does not import the channel path, and
measuring gross rather than marginal is how byte budgets become meaningless and get switched
off.

What each figure covers, and what may enter the request path at all, is
[`budgets.md`](budgets.md). Two modules are excluded by a reachability gate rather than by
convention: `plugin-graph.ts`, because plugin ordering is inferred from static declarations and
belongs to the build, and `plugin-guard.ts`, because the design specifies declared-read
enforcement as a dev-time check.

## The thirteen

| Port         | Status              | Notes                                                                   |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| `store`      | Interface + 2 impls | `memoryStore` (L1), `tieredStore` (composition)                         |
| `flags`      | Interface + 1 impl  | `staticFlags`; `axes()` is mandatory, not optional                      |
| `session`    | Interface + 1 impl  | `cookieSession`                                                         |
| `executor`   | Interface + 3 impls | `inline`, `deferred`, `client`                                          |
| `telemetry`  | Interface + 1 impl  | `collectingTelemetry`                                                   |
| `transport`  | Interface + 1 impl  | `nodeTransport`, for 103                                                |
| `scheduler`  | Interface only      | The kernel uses `maxConcurrency`; ordering inside a wave is by priority |
| `assets`     | Interface only      | `route.critical` is passed in directly today                            |
| `render`     | Interface only      | Slots carry their own `render`                                          |
| `registry`   | Declared only       | `unimplemented('registry')` → `E_PORT_UNIMPLEMENTED`                    |
| `config`     | Declared only       | as above                                                                |
| `db`         | Declared only       | as above                                                                |
| `deployment` | Declared only       | as above                                                                |

A port that does not exist refuses with a named error. It does not approximate.

## StorePort, and why `coherence` is in the interface

```ts
interface StorePort {
  consistency: 'eventual' | 'strong'
  coherence: 'ttl' | 'generation' | 'pubsub' | 'tracking' | 'warp'
  scope: 'process' | 'shared'
  maxValueBytes: number
  get(key): Promise<StoreEntry | null>
  set(key, value: Uint8Array | ReadableStream, meta): Promise<void>
  invalidate(tags): Promise<string[]>
  lease(key, ttlMs): Promise<Lease | null>
  revalidateAfterResponse(task): void
}
```

Four of those signatures are load-bearing in ways that are easy to miss.

**`coherence` names how a tier learns that something it holds is now wrong.** An in-process
cache that cannot be invalidated from outside is not really a cache; it is a short buffer
whose TTL you tune down until staleness stops hurting. `memoryStore` reports `generation` and
means it: bounded TTL plus a counter, because a Worker isolate cannot be addressed at all. A
Redis 6 adapter would report `tracking` and mean something stronger. Silently conflating the
two is the thing this field exists to prevent.

**`invalidate` returns the keys it dropped**, which is what makes push invalidation possible
at all — `createStaleRegistry().staleFor(dropped, reason)` turns those keys into `STALE`
frames for the connections holding them.

**`set` takes a `ReadableStream`**, so a fragment can be cached while it streams to the first
reader rather than only after it completes.

**`scope` says who can read the tier**, which is a different question from consistency and from
coherence, and conflating them is how a private entry ends up somewhere it can be served to the
wrong person. `tieredStore` writes a private entry only to `process` tiers — the filter is on the
write rather than the read, because an entry that never left cannot be served to anyone.

`tieredStore` composes tiers, reports the **weakest** consistency and coherence of its members,
and the **most reachable** scope — a stack containing one shared tier is a shared stack. Reporting the strongest would be the comfortable lie: an L1 that
cannot be invalidated remotely puts a ceiling on what the whole stack can promise, and the
plan refuses a `consistency: 'strong'` policy against an eventual store on the strength of
exactly this number (`E_CONSISTENCY_MISMATCH`).

A hit deep in the stack fills every tier above it. A write reaches all of them. The lease is
held by the outermost tier, because a lease only the fastest tier knows about is not one.

## FlagPort: `axes()` is not optional

A flag is a graph partition, not a runtime `if`. Enumerating every reachable value is what
turns a combinatorial space into a small set and what lets a build prove the losing variant's
chunks are unreachable. A resolver that cannot do it is refused (`E_UNKNOWN_FLAG`), and a
bucket returning a value outside the declared axis is refused too (`E_FLAG_OFF_AXIS`) rather
than quietly becoming a cache key nobody enumerated.

## ExecutorPort: one method, six mechanisms

`run(job) → RenderOutcome` collapses same-thread, worker pool, separate isolate, service
binding, another pod, and the browser into one signature. The boundary is also the fault and
budget boundary.

`preemptible` is declared on the executor rather than assumed, because a CPU budget is only
enforceable where a render can be interrupted. `inline` is not preemptible: a budget there is
checked between awaits and a tight synchronous loop goes straight through it. The executor
still **reports** the breach — `E_CPU_BUDGET` with a message saying it ran to completion
anyway — and the plan warns at build time with `W_CPU_BUDGET_INLINE`, naming the executors
where the limit is real.

## SessionPort, and the guarantee it buys

Because a cache key comes from the effect signature and not from the session port, swapping
cookie backends cannot change caching behaviour. "Set a cookie without worrying" is a
consequence here, not a slogan. `rotateIfStale` returns the cookies to write rather than
writing them, because only the envelope knows whether it is still open.
