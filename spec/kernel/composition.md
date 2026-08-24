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

## The shell is a plan, so a region is a slot

A region fills a hole in the shell, is dispatched in a wave, may be cached, may be refreshed, and
degrades on a policy. Every one of those is a slot's behaviour, so `region('search')` builds a slot
and the plan layer checks it the way it checks everything else — that it fills a boundary the shell
leaves, that its `needs` name real slots, that a public document does not contain a private region.

```ts
plan(
  '/app',
  [
    shell('shell/app'),
    region('chrome')
      .local('fragment/chrome')
      .critical()
      .csp({ 'img-src': ["'self'"] }),
    region('search')
      .remote({ id: 'search', version: '2.1.0', reads: ['route:q'] })
      .budget({ cpu: '80ms' })
      .fallback('static:search-placeholder')
      .csp({ 'connect-src': ['https://search.internal'] }),
    region('recs').remote({ id: 'recs', version: '0.4.0' }).optional(),
  ],
  { exposes: ['locale', 'cartCount'] },
)
```

### One deliberate divergence from the design's sketch

The design writes `.remote('svc:search', contract.search)`. This declares `remote` and no target,
and the omission is the point: a shell naming the tier would make rolling that region a redeploy of
every shell that names it, which is the property the registry port exists to provide. So the plan
declares what a _build_ needs — whether this region crosses a boundary — and the deployment decides
which one.

`locus` is not a hint. It is what the hop count is computed from, what the render-location check runs
against, and what a startup check compares the registry with. The executor on a region slot is the
reserved name `region`, meaning _the registry decides_; a region naming any other executor, and a
non-region slot claiming that one, are both build errors, because two answers to "where does this
render" is how a page ends up with the numbers from one and the behaviour of the other.

### Where a region's cache class comes from

A cache class is still derived and never declared — the derivation just happens on the other side.
The contract carries the region's **reads**, in the same vocabulary a local fragment uses, and the
composite runs them through the same `cacheClassOf`, `varyOn` and `requiresTtl`. A region declaring
`reads: ['route:q']` contributes to the document's `Vary` and its strictest class exactly as a slot
does, and the composite resolves those reads for the request like any others.

Absent reads mean unknown, and unknown is not nothing: an undescribed region reads `opaque`, which is
uncacheable and private, so a public document containing one is a build error rather than a page
advertised as shareable on the strength of a silence.

The reads are also why the arrival check compares more than a version. A version that matched while
the reads had moved underneath it would be worse than a mismatch — the composite has already
advertised a class and a `Vary` derived from what the contract said — so a region whose reads have
changed is refused and the page keeps the answer it committed to.

### Three declarations that contradict themselves

| Refused                    | Why                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `E_REGION_CRITICAL_REMOTE` | Critical means in the first flush, and the first flush is what a gateway can do without a hop                             |
| `E_REGION_CONTRACT_LOCAL`  | A contract stands in for a compiler this build does not have; here it has one, and a second description can only disagree |
| `E_NOT_EXPOSED`            | The exposed set is the only channel between regions, so a region consuming something outside it is checkable              |

### The numbers a build states

`hopsOf(plan)` gives regions, remote regions, and hops, and `weft why` prints them per route with the
locus, contract and declared degradation of each region. `W_HOP_COUNT` warns at 80% of the platform's
subrequest ceiling — 50 by default, Workers' documented figure — because the request that finds the
ceiling is a 500 and not a slow page.

The count is a **floor**, stated as one. It counts the boundaries this plan crosses; a region that
fans out further is one this build has no view of, and its own plan counts its own. The composite
reports the real total at runtime from what each region announces, which is the number to compare the
floor against.

### One document, one policy

Per-region `csp(...)` is merged into a single header, sorted by directive so two builds of one plan
produce the same string. Different hosts for one directive are a union. `'none'` beside anything else
is `E_CSP_CONFLICT`, because it is the one value that means _and nothing else_, and merging it by
union would silently turn a region's refusal to load anything into permission to load somebody
else's host. The header is written in phase A, from the lowered plan, so it costs the kernel nothing.

## Topologies: the four shapes are one field

`topology(name, { regions, render })` produces a registry and a set of executors, and nothing above
the registry can tell which name it was given. `monolith` binds every region to `inline`;
`split-render` sends every region to one render tier; `mesh` gives each region its own service.

Two of the four are the same code with a different address, and saying so is better than inventing a
distinction: **`edge-regional` is `split-render` whose render tier is somewhere else**. The
difference is real — a regional tier is near the database and an edge gateway is not — and it is a
URL rather than a mechanism.

The one thing a topology may not do is collapse quietly. A split with nowhere to send a region is
`E_NO_TIER` rather than a fallback to this process, because a monolith reported as a split is a
latency claim nobody can check. `describe()` prints a line per region — where it runs, what reaches
it, what contract and revision — because a deployment shape that cannot be printed is one somebody
will guess at during an incident.

## Verification: four facts in four places

A plan says a region is remote. A registry says where it is. A deployment says which executors it
binds. The region itself says what it is serving. Every pair of those can disagree, and only some of
the disagreements are knowable at build time.

`verifyRegions(plans, { registry, executors }, probe?)` compares them where the answers exist:

| Code                      | The disagreement                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `E_NO_SUCH_REGION`        | A route composes a name the registry does not resolve                                 |
| `E_REGION_LOCUS_MISMATCH` | The plan says remote and the registry binds it locally, or the reverse                |
| `E_UNKNOWN_EXECUTOR`      | The registry names a tier this deployment does not bind                               |
| `E_REGION_CONTRACT`       | The registry, or the running region, serves something the shell was not built against |
| `E_REGION_UNREACHABLE`    | The probe could not get an answer at all                                              |

The locus mismatch is an error rather than a warning on purpose. A plan declared `remote` is a plan
whose hop count, document cache class and render-location check were all decided on that basis, so a
registry quietly making it local means every one of those numbers describes a different deployment
than the one running.

`regionProbe(ports)` is the design's `weft verify --against production`, and it is the composition
path rather than a second one: same executor, same address, same announcement, so a verification
that passes is a verification of the thing that will serve traffic. It deliberately does not render
— the request carries no route and no params, because a region asked what it _is_ has not been asked
for a page.

## A region over a live channel

In the document path a region's markup fills a hole in a shell being streamed. Over a channel the
page is already there, so what travels is the least that has to — and the region is the only side
that can decide what that is, because it is the side holding the template. The composite hands over
what this client holds for that region; a `DELTA` comes back where the client has the template and
the base, markup where it does not. The surgical ladder crosses a deployment boundary unchanged.

Two frames per answer, split by whether they paint. The one that changes what the reader sees is what
an epoch stages; a template, a stylesheet or a module travels immediately even inside an epoch,
because holding back the thing a frame needs in order to apply would only delay the frame. The
region decides that split itself, which is right: only the side that produced the frames knows which
of them is the picture.

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

`entry-region.ts` — the document request path plus resolution and the check — is **11,021 B brotli**
against a stated 11,264 B ceiling. `entry-region-channel.ts` — the transport plus composition, which
is what a gateway serving both actually imports — is **16,037 B** against 16,384. Both are their own
entries on the rule route staging established: a deployment that composes nothing never imports
either, and its request path is the size it was.

Two costs landed on entries this capability is not in. The `REGION` frame kind moved every entry
carrying the frame table a few bytes — the channel 10,669 → 10,678, the front door 12,223 → 12,227 —
and the dispatch point for a region over a channel cost the transport entry **20 bytes**, which is a
dispatch point in a shared file and could not be moved anywhere. The transport watermark has nine
bytes left. That is recorded rather than resolved: the next thing to touch `channel.ts` either trims
it or moves the watermark with a reason, and it should know that before it starts.

## What this does not do yet

- **`expose()` is declared and checked, and nothing routes it yet.** A region consuming a signal the
  shell does not expose is a build error, which is the half that makes the single channel worth
  having. What is missing is the runtime: a shell signal does not yet reach a region's client code,
  so today the declaration is a contract nobody can breach because nobody can use it.
- **A `STALE` for a region's cache tag has nobody to tell.** The composite does not hold a region's
  cache keys — it holds a contract, and keys are the region's own — so push invalidation stops at the
  boundary. The client's own refresh interval is what covers it, which is the design's stated
  fallback for the whole invalidation tier and not a special case here.
- **`weft verify` is a function and not yet a command.** `verifyRegions` and `regionProbe` do the
  work; nothing in the CLI calls them, so a deploy is not gated on them yet.
- **Nested regions are a tree in the numbers and not in the resolution.** A region's own regions are
  resolved by its own registry, which is right, but nothing yet reports the composite tree as one
  graph.
- **A region cannot be staged as part of a route.** `WARM at=` answers with regions from this
  deployment's plan; a composed region on another deployment is not part of that answer, so a staged
  route arrives with its remote regions unfilled.
