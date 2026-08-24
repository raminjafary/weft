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
| `entry-request.ts` — document path         | 8,040 B  | 8,192 B, from the design's "under 8 KB" |
| `entry-channel.ts` — plus refresh, epochs  | 10,255 B | 12,288 B, no design figure, a watermark |
| `entry-intent.ts` — plus intent dispatch   | 9,147 B  | 10,240 B, no design figure, a watermark |
| `entry-transport.ts` — plus a live channel | 12,645 B | 13,312 B, no design figure, a watermark |

152 bytes of headroom on the claim, now that the route matcher is in the figure. The whole
barrel (`index.ts`, including build-time validation and serialisation) is 11,601 B and is
deliberately **not** the entry the claim is measured against — a deployment serving documents does not import the channel path, and
measuring gross rather than marginal is how byte budgets become meaningless and get switched
off.

What each figure covers, and what may enter the request path at all, is
[`budgets.md`](budgets.md). Two modules are excluded by a reachability gate rather than by
convention: `plugin-graph.ts`, because plugin ordering is inferred from static declarations and
belongs to the build, and `plugin-guard.ts`, because the design specifies declared-read
enforcement as a dev-time check.

## The fourteen

| Port         | Status              | Notes                                                                                   |
| ------------ | ------------------- | --------------------------------------------------------------------------------------- |
| `store`      | Interface + 2 impls | `memoryStore` (L1), `tieredStore` (composition)                                         |
| `flags`      | Interface + 1 impl  | `staticFlags`; `axes()` is mandatory, not optional                                      |
| `session`    | Interface + 1 impl  | `cookieSession`                                                                         |
| `executor`   | Interface + 4 impls | `inline`, `deferred`, `client`, and a real `pool` of worker threads                     |
| `telemetry`  | Interface + 1 impl  | `collectingTelemetry`                                                                   |
| `transport`  | Interface + 1 impl  | `nodeTransport`, for 103                                                                |
| `scheduler`  | Interface + 2 impls | `prioScheduler` is the kernel's own rule, named; `fifoScheduler` keeps plan order       |
| `assets`     | Interface + 1 impl  | `weftAssets`, and the kernel asks it when the route named no critical links             |
| `render`     | Interface + 1 impl  | `irRenderer`; the plan binds it, so `remote` is another implementation not a path       |
| `registry`   | Interface + 1 impl  | An intent id to its code, a region name to a deployment, a catalogue id to a renderable |
| `config`     | Interface + 2 impls | `envConfig` under a prefix, `staticConfig` for a Worker's `env`                         |
| `db`         | Interface + 1 impl  | `boundedDb`: a name, a deadline, and the tags an access declared                        |
| `deployment` | Interface + 2 impls | `hostDeployment` reads whatever the host calls a revision; `staticDeployment`           |
| `limits`     | Interface + 1 impl  | `countingLimits` counts; `counted` is the decision it refuses to make for you           |

Fourteen declared, fourteen implemented, and eleven of them bound by the front door with no
configuration at all. A port that does not exist refuses with a named error and does not
approximate — which is what the three that were "declared only" did until they were built, and
what any future one will do.

`registry` was the last of the fourteen that the front door declared and did not bind. It is bound
now, because composition acquired a front door: a route says a slot is a region and `weft.config.ts`
says which deployment serves it, so the indirection has somewhere to live other than a test.

`limits` is the fourteenth, and it is the clearest case for why these are ports rather than
configuration. The implementation counts; what it cannot decide is _what a call is counted against_,
because an address is wrong behind a proxy, a session is wrong for an unauthenticated API, and a
subject is wrong for every call made before anybody signs in. A kernel picking one would be guessing
with a straight face, so an intent that declares a limit and finds nothing bound is `E_NO_RATE_LIMIT`
rather than unlimited.

`store` grew a second scope field for a related reason. `scope` says who may read what a tier holds,
and a tiered store refuses to write a private entry to a shared one on the strength of it; `leaseScope`
says how many processes agree that somebody already took a lease. Those were one field until replay
needed them to differ — a deployment should not have to make its cache shared in order to make its
nonces single-use. `sharedLeases(store, { dir })` sets the second and leaves the first alone.

### The three that were declared only, and what they turned out to be

**`config`.** What the deployment was configured with — an environment variable, a Worker
binding, a secrets manager — behind one interface, so nothing above it has to know which. Two
rules make it more than a `Record`. A setting is **not a tracked read**: it is a property of the
deployment rather than of the request, so it cannot taint a fragment and cannot enter a cache key,
which is also the only reason it is safe for a key to be loggable. And `required` refuses by name
rather than defaulting, because a deployment missing its database URL should fail where it is
configured. `envConfig` is visible only under a prefix (`WEFT_` by default), so a fragment asking
for a setting cannot reach a credential the process happened to be started with.

**`db`.** Where a loader's data comes from, named rather than anonymous. The framework never sees
a loader — a `.data.ts` is application code the compiler does not read — so every query inside one
is invisible to everything that would otherwise bound it. The port gives back exactly what that
absence costs: a name in the telemetry, a deadline somebody chose rather than the driver's
default, and the tags the render depended on recorded where an invalidation can be checked against
them. It is deliberately **not a query language**: what runs is the caller's own function, and a
`run` that ignores its `AbortSignal` gets a named `E_QUERY_TIMEOUT` and a query that is still
running, which is stated rather than hidden.

**`deployment`.** Which build is answering and where. Worth a port because every platform spells
it differently and most spell it in an environment variable the kernel may not read. It feeds a
response header, telemetry attributes that make two versions comparable during a rollout, and the
inspector's own ports page. It deliberately does **not** feed cache keys: a revision in the key
namespace would drop every cached render on every deploy, and the entries that genuinely must not
survive one already do not, because a key contains the template's content address.

### Where a capability goes when the request path has no room for it

`ctx.data` and `ctx.setting` are the front door's, not the kernel's — `packages/weft/src/context.ts`
rather than `packages/kernel/src/context.ts`. That is the byte budget deciding an architecture
question, and it decided it correctly.

Written into the kernel's context, the two of them plus the scheduler and assets wiring took the
document request path to **8,254 B** against a ceiling of 8,192 that the design fixed and this
repository has already refused to move once. The rule says a new capability does not draw on that
headroom, so the capability moved to where its consumer already was: a loader is a front-door
concept, so what a loader can reach is the front door's decision. The kernel kept the port
declarations, which are types and cost nothing, and the request path came back to **8,108 B**.

The wrapper is one function. `withServices(ctx, ports)` spreads the deployment's services onto the
context the kernel handed in, and cannot add to what it tracks — so a loader gains a database and
a settings table and still cannot smuggle an unkeyed read into a render.

## Registry: two questions with the same shape and different lifetimes

`intent(id)` answers what an opaque id names, because the client never carries the name of server
code. `region(name)` answers where a region lives, because a shell says `search` and something has to
say what `search` is. They sit behind one port because they are the same operation — a name the caller
cannot resolve, resolved by something the deployment configured — and they are separate methods
because their lifetimes are not the same. An intent id is derived from code and changes when the code
does; a region binding is operational and changes when somebody rolls a tier.

The region half is what makes the design's topologies configuration rather than modes. A binding
naming `inline` is the monolith; one naming `binding:` or `svc:` is a tier boundary. `roll(binding)`
points a name somewhere else without rebuilding the shell that composes it, which is the sentence the
port exists for — and a registry that cannot answer regions at all refuses `E_NO_REGION_REGISTRY`
rather than being approximated by a table compiled into the shell, because a compiled table makes a
roll a redeploy. The whole of composition is [`composition.md`](composition.md).

## SchedulerPort: the kernel's own rule, named

`order(ready)` and `maxConcurrency`, and the default implementation is exactly what the kernel did
before the port was bound: priority descending, then name. Naming it is what makes it a
deployment's decision, and the name-breaks-the-tie half is not a preference — two runs of one plan
have to dispatch in the same order, or a measurement of one is not a measurement of the other.

A scheduler **reorders what it was handed**. It may not invent a slot, drop one, or return
something it was not given: the wave is the plan's, and a scheduler that could change its
membership could change what a page contains. The kernel passes its own nodes through and reads
the order back, so anything else would be discarded anyway.

The ceiling is the part that is not policy. Forty concurrent queries from one page request will
melt a database, so the cap exists whether or not anyone tunes it, and the plan warns at build
time when a plan's widest wave exceeds it (`W_WAVE_WIDTH`).

## AssetPort: what a route needs before it has been rendered

`criticalFor(route)` is asked while the envelope is still open and the plan has not run — which is
the whole of what 103 is for, and until this port was bound the kernel had nothing to ask. Every
page now hints its own stylesheet and the client runtime at effectively zero milliseconds, from a
table the build already had: a page links one stylesheet and one module, so answering costs a map
lookup rather than a render.

Only what is _critical_ goes in. A 103 listing everything a page might use is a 103 that delays
the things it needs, so fonts and images a fragment happens to reference are not there: they are
discovered from the shell, which by then has already been flushed.

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
anyway — and the plan warns at build time with `W_CPU_BUDGET_ADVISORY`, naming the executors
where the limit is real.

## SessionPort, and the guarantee it buys

Because a cache key comes from the effect signature and not from the session port, swapping
cookie backends cannot change caching behaviour. "Set a cookie without worrying" is a
consequence here, not a slogan. `rotateIfStale` returns the cookies to write rather than
writing them, because only the envelope knows whether it is still open.
