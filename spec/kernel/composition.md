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
its contract, its revision and the boundaries it crossed on its own account. Answering a probe, the
same frame carries what it composes in its body: Warp 1.7.0, and the section below on the tree.

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

A tier that composes tiers reports what it **measured** rather than what it was configured with. A
region service used to be handed its hop count as an option, which meant a nested tier that lost a
region to a timeout still announced the boundary it turned out not to cross; a region whose own
regions go through a composer returns them in `composed` and the count comes from what happened.

The honest position on cost, unchanged from the design: decomposition is opt-in per region, the
collapsed topology is the default, and a tier boundary buys a **failure** boundary more reliably than
it buys throughput.

## The tree, when something asks what the shape is

The count answers "how much latency". It does not answer "made of what" — a composite could report
three boundaries and nothing could say which three, because a region's own regions are resolved by
_its_ registry and the name means nothing on this deployment. That is right, and it is why the graph
is **asked for** rather than derived.

`weft verify --probe` walks it. Each tier is asked what it is serving; a tier that is itself a
composite asks the tiers below it and answers with its whole subtree, so what comes back is spliced
where it was asked rather than re-resolved by somebody who could not resolve it. A region implements
that with `probeRegions(ports, names, depth)` — the same registry, the same executors, the same
announcement as a render, with no render.

Four things are deliberate about how it travels.

- **In the frame's body, not its headers.** A tree is a list of records and a header set is not one,
  which is the reason the `PLAN` frame gives for the same choice.
- **Only on a probe.** A page being rendered needs the count, and the count is a header. A subtree on
  the request path would be bytes a composite has no parser for and would forward unread.
- **Written and read in `region-tree.ts`, which no request entry imports.** Composition got its own
  entry on the rule that a deployment composing nothing should not carry the check that makes
  composing safe; this is that rule one level in, and it is why the graph costs the document path
  **zero bytes** rather than a moved watermark.
- **Bounded by whoever asked.** Two deployments composing each other is a cycle nothing here can see,
  because the far side is somebody else's registry answering somebody else's question. So the depth
  is spent by the caller and refused at zero with `E_REGION_TOO_DEEP` as a node in the graph — a walk
  that stopped without saying so would read as complete.

What arrives is one deployment's claim about another, so what is checked is the shape and the
arithmetic: `E_REGION_TREE` for a subtree that is not a list, is more than 8 tiers deep, holds more
than 256 regions, or **does not add up to the count in the same frame**. The last is the one worth
having. `hops` was the whole of what a nested tier reported and therefore could not be contradicted;
now the number and the graph are two claims about one topology, and a plan's ceiling was checked
against the number.

`W_REGION_TREE_DEEPER` is the one thing the graph can say that no build could. `hopsOf(plan)` counts
the regions a route declares — every boundary it can see — so a route that turns out to cross more is
not wrong, but it is not what the latency budget was written against either. A warning names the
region, what it composes, and both numbers.

## Measured

`entry-region.ts` — the document request path plus resolution and the check — is **11,246 B brotli**
against a stated 11,264 B ceiling. `entry-region-channel.ts` — the transport plus composition, which
is what a gateway serving both actually imports — is **16,268 B** against 16,384. Both are their own
entries on the rule route staging established: a deployment that composes nothing never imports
either, and its request path is the size it was.

`readsFor` cost 155 bytes on the first of those and 143 on the second, taking the region entry from 243
bytes of headroom to **18**. It is worth what it cost: without it a region's declared reads reached the
key derivation and not the region, so a contract could say `route:q` and the region would render as if
it had not been told — a page whose key described something other than what rendered it.

On the client, the exposed table is `entry-expose.ts` at **4,368 B** against 5,120, and it took the
front door past a watermark set before composition existed: 12 KB → 13 KB, measured at 12,540. That
watermark has moved four times and this is the fifth; what it covers is now stated as _adoption to
composition_. The trims that were available were taken first — a named error class the client package
has no other instance of, two header aliases, and the prose out of a message that ships to every
reader — for 164 bytes. The remainder is the mechanism, and a page that composes nothing can still
build a boot module without it, which is what the entry is for.

Two costs landed on entries this capability is not in. The `REGION` frame kind moved every entry
carrying the frame table a few bytes — the channel 10,669 → 10,678, the front door 12,223 → 12,227 —
and the dispatch point for a region over a channel cost the transport entry **20 bytes**, which is a
dispatch point in a shared file and could not be moved anywhere. The transport watermark has nine
bytes left. That is recorded rather than resolved: the next thing to touch `channel.ts` either trims
it or moves the watermark with a reason, and it should know that before it starts.

## Composition from the front door

Everything above was reachable by importing the kernel, the plan layer and the adapters and wiring a
composer by hand. That is the right way for the plan layer's own tests, whose subject _is_ the
composer, and it was a gap in the framework: `demo/` depends on `weft` alone, so a page there that
needed the kernel was a page the front door could not express.

A route says a slot is a region. It says nothing about where.

```ts
// app/routes/app/composed.data.ts
slots: {
  search: {
    region: {
      remote: { id: 'search', version: '2.1.0', reads: ['route:q'] },
      fallback: 'degraded',
      consumes: ['currency'],
    },
    budget: { cpu: '250ms' },
  },
},
exposes: ['currency', 'cartCount'],
```

A deployment says where.

```ts
// weft.config.ts
executors: { 'binding:search': bindingExecutor({ binding: regionService({ root }), timeoutMs: 500 }) },
regions: [{ region: 'search', executor: 'binding:search',
            address: { module: './search-region.ts', export: 'search' },
            contract: { id: 'search', version: '2.1.0', reads: ['route:q'] } }],
```

And the other side is a module rather than a service somebody writes, which is the protocol claim with
nothing between it and the reader:

```ts
export const search: RegionRenderer = {
  region: 'search',
  contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
  render: (request) => markupFor(request.reads?.['route:q'], request.exposed?.currency),
}
```

**A region is given its reads rather than taking them**, and that is what makes a composed page
cacheable at all. `readsFor` resolves the contract's reads through the _same context_ a local
fragment's go through — so reading `cookie:currency` on the region's behalf taints the composite
exactly as a local fragment reading it would, and the document's key and `Vary` describe the region's
reads whether it is in this process or across a socket. A composite that resolved them off the raw
request would produce a page whose key did not describe what rendered it, which is the one failure the
whole effect graph exists to prevent.

`ports.registry` was the last declared port nothing bound. It is bound now, and it answers three
questions with three lifetimes: an intent id derived from code, a region binding somebody rolls, and a
catalogue entry a client may name.

## `weft verify`

The four facts in four places, compared where the answers are, with an exit code.

```
$ weft verify demo --probe

  route              region          locus   where               serving
  /app/composed     search          remote  binding:search      search@2.1.0  rev search-42

  1 region(s) agree, including what each one says it is serving right now
```

`--probe` is the half that needs the network and it is the window CI cannot close: a contract test
against a published type says what was true when the type was published, and this says what is true at
the moment of the deploy. Without it the command is still worth running, because three of the four
comparisons need nothing but this process.

The resolvable half also runs at **startup**, printed with the banner. A composed page that cannot
resolve one of its regions fails at request time with a named error, which is correct and late: the
name is wrong in a config file and the person who can fix it is looking at a terminal. `weft build`
prints a line per region for the same reason, and says which command gates it.

## The exposed set, routed

`expose()` was declared and checked and nothing routed it — a contract nobody could breach because
nobody could use it. Both directions work now, and they are two mechanisms because they answer two
questions.

**Server side.** The names a region declared it consumes are resolved from the shell's own values and
handed across the boundary in the region's request. Stringified, like a read, and for the same reason:
these cross a serialisation, so a region that received the number `3` in a monolith and the string
`"3"` over a binding would have a bug that appears in one topology and not the other — which is the
class of thing the byte-identical assertion between the two exists to catch. Intersected with what the
shell exposes rather than trusted: validation already refuses a region consuming something outside the
set, and this makes the runtime unable to widen one.

**Client side.** A region's client code runs in a page it did not assemble. It cannot reach the shell's
variables — they are in another deployment's module graph — and it must not reach for a global, because
a global that exists on one page and not another is the coupling a composed page cannot afford. So
there is one table, and `weft.exposed('currency')` reads it. What comes back is a `Readable`, so it is
in the signal graph: a new value recomputes exactly the nodes that read it. There is no write side, and
that asymmetry is the design's — a shell offers values, it does not host a bus.

The table's _set_ comes from one frame, and that is the security property. A `SIGNAL` with a body and
no name is the shell's declaration, sent when the connection opens for the same reason `PLAN` is: the
client cannot ask a question it does not know it has. It **replaces** rather than merges, so nothing on
the wire can add a name — and a name the shell has stopped exposing stops being readable rather than
keeping the last value anybody saw. A `SIGNAL` naming something outside the set is refused and
_reported_: a dropped one looks exactly like one that never arrived.

A page with no channel is not missing anything. A region's first render already had the values it
consumes — the composite resolved them and handed them over, so the markup that arrived is correct —
and a shell value that _changes_ needs a live channel by definition. Changes are sent after an intent,
one frame per value that moved, on both bindings: a form post that left every open page's exposed
values stale would be push invalidation working on one binding out of two.

### One frame kind, two namespaces, and a hole that had to be closed

A region may send `SIGNAL` — its own client state is its own business. But a signal carries a name out
of a namespace the _shell_ also writes into, and every other frame a region sends addresses a slot, so
the escape check had nothing to check. An unscoped `SIGNAL` arriving from a region would have let it
set a value its siblings read: the exact coupling the exposed set exists instead of, arriving through
the back door.

So an unscoped `SIGNAL` is the composite's, and a region's own must carry `s=<region>` — at which point
the check that was already there does the rest. `E_REGION_ESCAPE`.

## A region staged as part of a route

`WARM at=` used to answer with regions from this deployment's plan only, so a staged route arrived with
its remote holes empty and the reader watched them assemble after the commit — which is the one thing
staging exists to prevent. They are composed now, and told the epoch they are being staged into, so a
region knows the answer is not going to paint yet and can split its own frames accordingly.

`StagedRoute.slots` became the union a refresh already branches on rather than a second mechanism:
frames from elsewhere are the smallest form their producer could choose, because it is the side holding
the template, so choosing again here would mean re-deriving a delta against a template this process
does not have. The one thing the stage adds is the epoch, on the one frame that paints.

The same union made a remote region **refreshable over the channel** from the front door. There is no
`live` gate on that path, deliberately: `live` says _this process may re-render this slot under a
reader_, which is a statement about a fragment this process holds. A region's freshness is the region's
own business, and refusing to ask it would be this deployment deciding something it has no view of.

## What this does not do yet

- **A `STALE` for a region's cache tag has nobody to tell.** The composite does not hold a region's
  cache keys — it holds a contract, and keys are the region's own — so push invalidation stops at the
  boundary. The client's own refresh interval is what covers it, which is the design's stated
  fallback for the whole invalidation tier and not a special case here.

  What changed is that it is no longer a silence. A remote region that declares cache tags and no
  refresh interval has _neither_ mechanism, and that is `W_REGION_TAGS_UNREACHABLE` at build time,
  naming the tags and the fallback. A warning rather than an error, because a tag on a remote region is
  not a contradiction — the region may well be invalidated by it on its own side, and this composite
  simply cannot see that. What would be wrong is letting a page declare tags, get nothing, and find out
  from a region that never updates in production.

- **Nested regions are a tree in the numbers and not in the resolution.** A region's own regions are
  resolved by its own registry, which is right, but nothing yet reports the composite tree as one
  graph.
