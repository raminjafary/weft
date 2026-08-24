# Composition: a region is a fragment that lives somewhere else

Micro-frontend orchestration is a product category with its own runtime, its own registry and its
own failure modes. It should not be. A shell is a fragment tree whose leaves are regions, and a
region is a fragment that happens to render on another deployment — so composition here is not a
second runtime beside this one. It is three things this framework already had, pointed at each
other, plus one check it did not have.

| Already existed                                        | What it does for a region                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ExecutorPort`, and that it is a crash-domain boundary | `binding:` and `svc:` reach another deployment; a failure there degrades one region        |
| `Registry`, a port                                     | resolves the name `search` to whatever is serving `search` right now                       |
| Warp frames, which every render already produces       | what comes back over the boundary is the protocol the composite already speaks downward    |
| **New:** the region check                              | frames arriving from elsewhere are somebody else's, and a length prefix does not say whose |

## The name is the indirection, and that is the whole point of the port

A shell says `search`. It does not say where `search` is, and nothing compiled into it does either.
`Registry.region(name)` answers with a `RegionBinding`:

```ts
interface RegionBinding {
  region: string
  /** `inline` for a region this process renders. `binding:…` or `svc:…` for a tier boundary. */
  executor: string
  /** Module and export on the other side. Required by anything that is not this thread. */
  address?: JobAddress
  revision?: string
  contract?: { id: string; version: string }
}
```

Two consequences fall out of that being a port rather than a constant.

**Rolling a region to a new revision is a registry write.** `manifestRegistry(...).roll(binding)`
points a name at a different deployment, and the shell composing it is not rebuilt, restarted or
told. The test that proves it stands up two region services on two ports, composes the first, writes
the registry, and composes the second — no recompilation between the two assertions.

**The four topologies in the design are one field.** `monolith` is every binding on `inline`;
`split-render` is a gateway whose regions are on `binding:`; `mesh` is regions on `svc:` per team.
There is no mode switch, because there is nothing for a mode to switch: a region on `inline` goes
through the same executor every other slot on the page goes through. That is what keeps the collapsed
single-process shape the best-tested path rather than the one nobody runs, and it is asserted rather
than asserted-about — **the same region composed in-process and over a binding produces byte-identical
markup**, which is the test that would fail first if `inline` ever became a special case.

## What a region may say, and what it may not

A region's answer is a Warp stream. It opens with `REGION` — added in Warp 1.6.0 — naming itself,
its contract, its revision and the boundaries it crossed on its own account.

It has to be the region's own name and not the one it was asked for. A service that echoed the
requested name back would make the check below unfalsifiable, which is the same class of mistake as
a manifest that spelled its own intent ids: the thing being checked has to come from the side being
checked. `regionService` reads it off the exported renderer (`{ region, contract, render }`), so a
registry entry pointing `search` at the recommendations deployment is refused by the shell —
`E_REGION_ESCAPE` — rather than rendered into the wrong hole.

Then every frame after it is checked twice.

**Kind.** A region sends `HTML`, `TPL`, `DATA`, `DELTA`, `PATCH`, `SIGNAL`, `MOD`, `CSS`, `SLOT` and
`ERROR`. Everything else is `E_REGION_FRAME` with the authority it would have been borrowing named:

| Refused    | Whose it is                                                                            |
| ---------- | -------------------------------------------------------------------------------------- |
| `WARP`     | negotiation is between the composite and its client                                    |
| `SHELL`    | a region that could send one could replace the page it is part of                      |
| `PLAN`     | a plan is a route table; a region knows one route on one deployment                    |
| `NAV`      | only the side holding both shells can answer a staged route                            |
| `COMMIT`   | an epoch commits a whole page atomically, so the flip belongs to whoever owns the page |
| `STALE`    | push invalidation names connections, and a region holds none of this composite's       |
| `REDIRECT` | a region cannot move the page it is inside                                             |
| `COOKIE`   | a region cannot write to the composite's reader                                        |
| `ACK`      | an intent's answer belongs to the deployment that dispatched it                        |

The gate is over the frame vocabulary rather than over examples: a test walks every downlink kind
and fails if one is neither in the list a region sends nor refused with a reason. A refusal list that
quietly missed a kind is a hole nobody would notice.

Uplink frames need no entry here — the decoder rejects them as `E_WRONG_DIRECTION` before this table
is consulted — and an **unknown** kind is stepped over rather than refused, which is what makes a
Warp minor additive across a tier boundary as well as across a connection.

**Slot name.** Every frame that addresses a slot must address this region or a slot inside it
(`search:results`). A frame naming `cart` is `E_REGION_ESCAPE`. This is the security half of
"rendering as a service, by passing component names over the wire": the danger is not that a region
renders badly, it is that a region writes into a hole that is not its own.

## Failure is declared, and it is the vocabulary a slot already has

There is no second degradation model for regions. `optional()` is `onExceed: 'placeholder'` with no
placeholder — an empty hole and nobody paged. A declared degradation is `onExceed: 'fallback'` with
bytes. A budget is `cpuBudgetMs`, which on a binding or a service is a deadline on _waiting_ and says
so in its own message, because the other end cannot be killed from here.

Everything that can go wrong degrades one region rather than failing the page, including the protocol
refusals above:

| What happened                                         | Code                  | What the reader gets     |
| ----------------------------------------------------- | --------------------- | ------------------------ |
| the deployment is not there                           | `E_SLOT_FAILED`       | the declared degradation |
| it did not answer in time                             | `E_CPU_BUDGET`        | the declared degradation |
| it announced a different region                       | `E_REGION_ESCAPE`     | the declared degradation |
| it wrote into a sibling's hole                        | `E_REGION_ESCAPE`     | the declared degradation |
| it sent a frame that is not its to send               | `E_REGION_FRAME`      | the declared degradation |
| it serves a contract this shell was not built against | `E_REGION_CONTRACT`   | the declared degradation |
| it says it failed, in an `ERROR` frame                | the region's own code | the declared degradation |

A region that fails is a `region.degraded` measure on `TelemetryPort` with the region, the executor
and the code, for the reason every other degradation is: graceful degradation nobody can see is a
regression that looks like nothing at all in an aggregate.

What is **not** degradation is a region nobody can resolve. `E_NO_REGION_REGISTRY` (no registry able
to answer regions is bound), `E_NO_SUCH_REGION`, `E_UNKNOWN_EXECUTOR` (the registry named a tier this
deployment does not bind) and `E_NO_LOCAL_REGION` (the registry says this process renders it and this
process does not) are all misconfiguration rather than a bad afternoon at another team, and they
throw. A page missing a region because a name is wrong should not look like a page missing a region
because a service is down.

## Contracts, and the window CI cannot close

Typed cross-boundary contracts are not novel: Module Federation checks published types, and the
recommended discipline is contract tests in CI. What is narrower here is _when_. The `REGION` frame
carries the contract the deployment **is serving right now**, and the composite compares it with what
the shell was built expecting. CI against a published type closes the window before a deploy; this is
the window after one, and it closes with a declared degradation rather than an exception or a
silently duplicated copy.

## Hops are counted, not discovered

Every hop is latency, and a naive split of a page full of cheap fragments loses to a monolith. So the
count is a number the composite reports rather than something a deployment finds under load: an
outcome carries `hops`, a region that reached a further deployment of its own says so in its
announcement, and the total adds up through the tree. `composer.hops` is the page's.

The honest position on cost, unchanged from the design: decomposition is opt-in per region, the
collapsed topology is the default, and a tier boundary buys a **failure** boundary more reliably than
it buys throughput.

## Measured

`entry-region.ts` — the document request path plus resolution and the check — is **10,888 B brotli**
against a stated 11,264 B ceiling. Its own entry, on the rule route staging established: a deployment
that composes nothing never imports it and its request path is the size it was.

The `REGION` frame kind cost every entry that carries the frame table a few bytes: the channel entry
moved 10,669 → 10,678, the transport 13,261 → 13,283, and the front door 12,223 → 12,227. Recorded
because the transport watermark has 29 bytes left rather than 51, and the next thing that touches the
frame table should know that before it starts.

## What this does not do yet

- **A shell DSL.** Regions are composed through `createComposer` against a registry; the design's
  `shell(({ region, contract }) => …)` — and with it build-time hop and subrequest counts, per-region
  CSP, and typed `expose()` between regions — is not written.
- **Regions over a live channel.** A composed region arrives in the document path. A region refreshed
  or staged over an open channel goes through the same check, but nothing wires the composer into the
  hub yet, so a `STALE` for a region's cache tag has nobody to tell.
- **`weft verify --against production`.** The runtime contract check exists; the deploy-time one that
  queries every region and refuses a deploy on a mismatch does not.
- **Nested regions are a tree in the numbers and not in the resolution.** A region's own regions are
  resolved by its own registry, which is right, but nothing yet reports the composite tree as one
  graph.
