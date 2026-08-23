# Where a render runs, what it may cost, and when it is allowed to paint

Three mechanisms that look unrelated and are not: they are all consequences of render being
provably read-only.

## Render is a DAG, not a tree walk

Every server renderer in production walks depth-first from root to leaf on one thread. The
conflation at the heart of that is treating **existence dependency** as **data dependency**: a
child usually cannot start because its parent decides whether it exists, not because it needs
the parent's result.

`needs` in a plan is data dependency only. Everything else is dispatched immediately.

```
fragment DAG   9 slots | 3 waves | widest 6 | ceiling 6

wave 0   breadcrumbs, header, product-core, recommendations, reviews, shell
wave 1   price-box (needs product-core), review-summary (needs reviews)
wave 2   buy-panel (needs price-box)

critical path   product-core -> price-box -> buy-panel   =  42.7ms
                a sequential root-to-leaf walk would have been 123.3ms.
```

Those are the design's own figures, reproduced by `packages/kernel/test/waves.test.ts`
against `criticalPath()`.

**Optional slots do not end the critical path.** The design's example has a 44.8 ms
recommendations panel and still reports 42.7 ms, because the page is complete without it.
`DagNode.optional` carries that: the slot is still scheduled and still costs CPU, but it
cannot be the endpoint, or one slow panel would be reported as the floor for a page that is
perfectly usable.

Ties in the critical path break on **depth**, so a plan with no measured timings still names
its longest chain rather than reporting no critical path at all. Without that, `weft why` is
only useful after everything has already been measured, which is the wrong way round for a
planning tool.

`schedule()` refuses two things: `E_UNKNOWN_SLOT` for a dependency that is not in the plan,
and `E_PLAN_CYCLE` naming the slots involved. `dispatch()` caps concurrency per wave, because
forty concurrent queries from one page request will melt a database, and the plan warns at
build time when the widest wave exceeds the ceiling (`W_WAVE_WIDTH`).

### Why this is safe here

Render is read-only. Envelope writes are confined to phase A and effects are tracked, so two
fragments evaluated concurrently cannot observe each other's side effects, because they cannot
have any. In a framework where a component may write to a store or set a cookie mid-render,
parallel evaluation makes ordering observable and the result nondeterministic. The constraint
that made the envelope design necessary is the constraint that makes concurrent evaluation
possible — the same invariant paying twice.

## Six kinds, and what each one actually promises

`ExecutorPort.run(job)` is one method and there are six implementations of it. The differences that
matter are two: whether a budget on it is a _limit_ or a _report_, and what the other side is.

| Kind       | Preemption | A CPU budget is | The other side is                                |
| ---------- | ---------- | --------------- | ------------------------------------------------ |
| `inline`   | `never`    | a report        | this thread, this task                           |
| `deferred` | `at-await` | a report        | this thread, a fresh macrotask                   |
| `pool`     | `always`   | a limit         | a warm worker thread, module registry shared     |
| `isolate`  | `always`   | a limit         | a worker thread per render, nothing carried over |
| `binding`  | `at-await` | a deadline      | a call to something in the same datacentre       |
| `svc`      | `at-await` | a deadline      | another pod, over a network                      |
| `client`   | —          | vacuous         | the browser; nothing renders on the server       |

Only a separate stack can promise a limit, and only `pool` and `isolate` have one. A binding and a
service _are_ separate crash domains — a failure there cannot take this process down — but this end
cannot stop them either: aborting the request stops the waiting, not the work. So they report
`at-await` and their budget message says exactly that, because a slot whose budget silently bounded
latency rather than CPU is a slot whose author was told the wrong thing.

**What an isolate costs, measured.** Same trivial render, fifteen samples each, on this machine: a
warm pool worker answers in under a tenth of a millisecond, because the round trip is a
`postMessage` and the module is already loaded. A fresh isolate pays a p50 of **27.8 ms** (min 15.1)
before it renders anything, because its module registry is empty by construction — which is the
guarantee, not an inefficiency: nothing can leak from one render to the next when there is nowhere
for it to live. It is the wrong default and the right answer for a fragment rendering somebody
else's template.

**A closure does not cross any of these.** Four of the six require a `JobAddress` — a module and an
export — and refuse `E_JOB_NOT_ADDRESSABLE` without one rather than quietly running on the request
thread, which would hand back a budget that looks enforced and is not. Props must survive
serialisation for the same reason. Both are real constraints on what a fragment may be, and the
plan refuses at build time rather than at request time.

`renderService()` is the other side of a binding or a service, so a deployment does not have to
write one — and so this repository tests both against a real `fetch` handler and a real socket
rather than against a mock.

## Executors, and the two budgets that are different mechanisms

`ExecutorPort.run(job)` is one method. `inline`, `pool`, `isolate`, `binding`, `svc` and
`client` are implementations of it, and the boundary is also the fault and budget boundary: a
slot that blows its budget is killed and degrades, and nothing else on the page notices.

| `onExceed`      | Behaviour                                                             |
| --------------- | --------------------------------------------------------------------- |
| `'stale'`       | Serve the last cached value even if expired. Usually the best answer  |
| `'client'`      | Abandon the server render; emit the island and let the browser do it  |
| `'fallback'`    | Render the declared fallback                                          |
| `'placeholder'` | Keep the skeleton. Honest, cheap, visibly incomplete                  |
| `'fail'`        | Propagate. Only defensible for a slot the page is meaningless without |

### A CPU budget is only enforceable on a preemptible executor

JavaScript is single-threaded. You cannot interrupt a synchronous render on the request
thread, so on `inline` a budget is checked between awaits and a tight synchronous loop goes
straight through it. Three consequences, all of them stated rather than papered over:

1. `ExecutorPort` implementations declare `preemptible`.
2. A breach on a non-preemptible executor is still **reported** — `E_CPU_BUDGET`, with a
   message saying it ran to completion anyway — because a budget's job is not only to contain
   damage, it is to tell you the damage happened.
3. Declaring a CPU budget outside a crash domain is `W_CPU_BUDGET_ADVISORY` at build time, naming
   the executors where the limit is real.

Every degradation goes through `TelemetryPort` as `slot.degraded`. A slot silently dropping
from a server render to a client one for 4% of requests is a real regression that looks like
nothing at all in an aggregate, and that is the failure mode of graceful degradation
generally.

### What is implemented

`inline` (not preemptible), `deferred` (a fresh macrotask, preemptible at await points, and
**not** a worker thread — it does not claim to be one), and `client` (renders nothing
server-side). `pool`, `isolate`, `binding` and `svc` are named in the plan's validator and
refused as unbound (`E_UNKNOWN_EXECUTOR`) rather than silently falling back to inline.

## Epochs: fresh data without a changed view

Everywhere else, fetching implies committing. A background revalidation repaints; prefetching
a route can flicker the one you are looking at. Separating data currency from view currency is
the missing primitive.

`live` is what is painted. Staged epochs exist alongside it, fully resolved and completely
invisible.

**Server side** (`createEpochs` in `@weft/kernel`): `stage(epoch, slot, frame)` rewrites the
frame to carry the epoch, so it paints nothing; `commit(epoch, transition)` emits every staged
frame followed by one `COMMIT` naming the slots. Staging into `live` is `E_STAGE_LIVE`, open
epochs are bounded (`E_TOO_MANY_EPOCHS`), and committing an epoch with nothing in it is
`E_NO_SUCH_EPOCH`.

**Client side** (`createEpochs` in `@weft/client`): staged deltas are held per slot per epoch;
`commit` applies them all inside one `batch`, optionally wrapped in a same-document View
Transition where the engine has one. A later frame for the same slot supersedes the earlier
one rather than queueing a write nobody would see.

Four things fall out rather than being built:

- Prefetch cannot disturb the present. It is structurally impossible, not carefully avoided.
- Fresh data can sit staged through a scroll or a half-typed form and commit at the next safe
  moment.
- Five slots stage, one commit. The page never shows a half-updated state — a transaction
  boundary for UI data.
- An optimistic update is a staged epoch committed immediately, so rollback is `discard()`
  rather than reconstructing prior state.

Client epochs cost **254 bytes brotli**: the runtime went 2,742 → 2,996 B against a 6,144 B
ceiling.

## What this does not do yet

- **No worker-thread pool.** `deferred` is preemptible at await points and nothing more.
- **No per-request CPU accounting.** The budget is wall-clock, measured by the executor.
- **No speculation.** `.speculate()` is recorded in the plan and read by nothing.
- **No incremental recompute.** `.incremental()` is recorded and warns when there is no graph
  to memoize, but no memoized recompute exists.
- **The client's epoch commit is not driven by frames yet.** The server emits `COMMIT`; no
  transport reads it and calls the client's `commit`.
