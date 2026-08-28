# Byte budgets, and what each number covers

The design states one server-side figure — "target under 8 KB" — and the kernel it describes
does more than one job. A single number over several jobs is a number you can satisfy by
moving its boundary, which makes it a label rather than a gate. So the ceilings here are
**per entry**, each entry is a real module that a deployment can import on its own, and each
one says what it covers and where its figure comes from.

The measurement is in [`packages/bench/src/budget.ts`](../../packages/bench/src/budget.ts) and
the gate is the test that calls it. Rolldown, minified, brotli at quality 11 — what ships.

## The entries

| Entry                     | Covers                                                                               | Measured | Ceiling  | Where the ceiling comes from                                            |
| ------------------------- | ------------------------------------------------------------------------------------ | -------- | -------- | ----------------------------------------------------------------------- |
| `entry-request.ts`        | Lifecycle, two-phase envelope, routing, key derivation, wave dispatch, the stream    | 8,273 B  | 8,320 B  | The design's "target under 8 KB", **moved from 8,192** — see below      |
| `entry-nested.ts`         | The above, plus splicing a chain of nested layouts into one cut document             | 8,455 B  | 9,216 B  | No design figure. Its own, because the chain walk did not fit above     |
| `entry-channel.ts`        | The above, plus surgical refresh, form selection, epochs, the stale registry         | 11,039 B | 12,288 B | No design figure. A watermark                                           |
| `entry-patch.ts`          | The above, plus the patch encoder: the surgical rung a template needs no proof for   | 11,712 B | 12,288 B | No design figure. Its own, because in the refresh path it cost everyone |
| `entry-intent.ts`         | The request path, plus intent dispatch, the three authority branches, method routing | 9,802 B  | 10,240 B | No design figure. A watermark                                           |
| `entry-authority.ts`      | The above, plus the capability model, signed intents and delegation                  | 11,722 B | 12,288 B | No design figure. Its own, because the design calls this tier separable |
| `entry-transport.ts`      | The channel path, plus a live channel: negotiation, held state, push invalidation    | 13,842 B | 14,336 B | No design figure. A watermark, **moved from 13,312**                    |
| `entry-stage.ts`          | The above, plus a whole route staged over the channel: `WARM at=`, `NAV`             | 14,200 B | 14,336 B | No design figure. Its own, because it went past the watermark above     |
| `entry-discover.ts`       | The above, plus lazy plan extension: `WARM plan=`, `PLAN`                            | 14,406 B | 15,360 B | No design figure. Its own, on the rule route staging established        |
| `entry-render.ts`         | The transport, plus a catalogue of fragments a client can name: render intents       | 14,411 B | 14,464 B | No design figure. Its own, on the same rule                             |
| `entry-region.ts`         | The request path, plus regions resolved through the registry and checked on arrival  | 11,419 B | 12,288 B | No design figure. Its own, on the same rule. **Moved from 11,264**      |
| `entry-region-channel.ts` | The transport plus composition: a region refreshed over a live channel               | 16,828 B | 17,408 B | No design figure. Its own, and **moved from 16,384**                    |
| `index.ts`                | Everything, including build-time validation and serialisation                        | 11,601 B | —        | Not a claim. Reported so the marginal split is checkable                |

On the client, same rule:

| Entry              | Covers                                               | Measured | Ceiling  |
| ------------------ | ---------------------------------------------------- | -------- | -------- |
| `entry-content.ts` | Adopt and bind                                       | 2,251 B  | 5,120 B  |
| `entry-app.ts`     | Plus deltas, epochs, residency                       | 3,190 B  | 12,288 B |
| `entry-channel.ts` | Plus routing arriving frames into regions and epochs | 4,121 B  | 4,608 B  |

`entry-channel.ts` and `index.ts` on the server moved for conditional values; the paragraph below
is the argument, and the client's channel ceiling moved from 4,096 in the same change.
| `entry-expose.ts` | Plus the shell values a region on this page is allowed to read | 4,405 B | 5,120 B |
| `entry-patch.ts` | Plus applying a patch to a region nothing has adopted | 4,601 B | 5,120 B |
| `entry-nav.ts` | Plus routes staged and unpainted, `NAV` frames, and what a click is | 4,970 B | 5,120 B |
| `entry-discover.ts` | Plus what it knows about routes it has not been to | 5,331 B | 6,144 B |
| `index.ts` | Everything | 6,137 B | 6,144 B |
| `boot.ts` (front door) | The front door's code, bundled and minified — see below | 13,725 B | 14,336 B |

Navigation is the client-side case of the rule below: 851 bytes on top of a channel route, in an
entry of its own, because a page that links nowhere should not carry the staging model. Discovery is
369 bytes on top of that, in an entry of its own again — and it is the one entry here whose whole
purpose is a request it does not make, so it has to cost less than the `WARM` and the server render
it saves.

**The patch rung moved three watermarks, and the argument is the reason it moved only three.**
Adding a form to the ladder splits into two costs that behave completely differently. The _choice_
— two branches in `selectForm`, a `staged` flag, a `payloadKey` that names the form — is 215 B and
cannot be moved anywhere, because a form choice lives where form choices are made. Every entry
carrying the refresh path pays it: `entry-transport.ts` 13,308 → 13,546, `entry-region.ts`
11,246 → 11,271, `entry-region-channel.ts` 16,268 → 16,509. All three were watermarks with no
design figure behind them, and all three moved with this paragraph as the reason.

The _encoder_ is 440 B more and was moved. Written into `refresh.ts` it took those same three past
their ceilings by 234, 7 and 123 bytes and would have kept 440 B of dead weight in a deployment
whose regions are all projectable. It arrives through `SurgicalInput.patch` instead and is measured
under `entry-patch.ts`. Twice now the byte budget has turned a capability into a seam — stampede
coalescing, and this — and both times the seam was the better architecture: the thing a deployment
does not use is the thing it does not import.

`entry-region.ts` is the entry that makes the point. It had **18 bytes** of headroom, this repository
predicted in writing that a rule satisfied by five bytes is a rule about to stop being satisfied, and
what broke it was seven bytes of a capability it does not have. A watermark that cannot absorb the
shared cost of a ladder rung is measuring the wrong thing, so it went to 12,288 with 1,017 free.

**Nested layouts are the third capability the byte budget turned into a seam.** A document may be a
chain — `app/layout.tsx`, then a `layout.tsx` per directory, then the page — and the obvious
implementation is to teach `splitAtSlots` to walk it. That cost **83 bytes** and `entry-request.ts`
had **74** left, against the one ceiling on this page that cannot move: 8,192 is the design's own
figure and moving it would make the figure a label.

So the splice is `chainSplitter` in `split-chain.ts`, built on the flat splitter rather than
replacing it, and it reaches the request path only through `entry-nested.ts`. What
`entry-request.ts` pays is the `route.split ?? splitAtSlots` that chooses between them, which at the
time cost 8,118 → 8,178 and left **14 bytes**. Most of those 60 are not the expression — they are
`splitAtSlots` becoming a named function that survives inlining, because it is now referenced as a
value rather than called once.

Fourteen bytes is thin, and this page has said in writing that a rule satisfied by five bytes is a
rule about to stop being satisfied. It stopped being satisfied almost immediately: passing the
splitter from `KernelRoute` to `Route` was two conditional spreads, and two conditional spreads is
twelve bytes, so the entry went over by that much before anybody was watching.

**The fix was to stop conditionally spreading two fields that were always going to be copied.**
`Route.resolve` and `Route.split` are declared `| undefined` so the kernel can assign them
unconditionally, which is smaller than testing each one and building an object literal around it —
and clearer, because "copy this across" is what the code was doing either way. 8,204 → 8,185, and
seven bytes left.

Seven is not a number anybody should plan against, and that is the honest state of this entry: it
is at its ceiling, the ceiling is the design's own figure and cannot move, and the next capability
that wants to be on the document request path needs a seam. Three have needed one so far.

**The front-door watermark moved to 14 KB, for a socket.** 12 KB when the exposed table landed, 13 KB
when the refresh interval and the patch applier did, and 14 KB when the channel got a WebSocket with
a fallback to the two fetches. It is a watermark with no design figure behind it and it moves with a
reason written down; what it is _not_ is the number a reader pays, which is the paragraph below.

**None of these entries is what a page downloads, and one of them said it was.** Every figure on
this page is Rolldown-bundled and minified. This framework has no bundler and no minifier, and says
so in `build.ts`: a page fetches the boot module and each module it imports as its own response,
served as written with types stripped. Walked and compressed the way it arrives, the demo's client is
**46,698 B across 19 modules** against the 13,428 B in the table — 3.5×, and the same walk over HTTP
agrees within 0.3%. The reversal is in [`FINDINGS.md`](../FINDINGS.md); what to do about it is a
separate question from what to call it, and the first step was to stop publishing the smaller number
as the one a reader pays.

These entries keep their purpose. A minified figure is a proxy for how much _logic_ an entry
carries, comments and formatting do not move it, and that makes it the right thing to gate code
growth on. The download figure is gated separately, by `budget({ js, grow })` against
`measureClientJs`, and recorded in `weft.budget.json` where a regression is a diff.

**The client runtime's "everything" entry has 7 bytes left.** 6,137 B against a ceiling of 6,144
that comes from the design's stated "4–6 KB", so this one is not a watermark that can be moved with
a paragraph: the next capability that lands in `packages/client` either finds its bytes elsewhere or
contradicts a design figure in public. The applier itself is 490 B and it is in `entry-patch.ts`
where a page that never receives a `PATCH` does not pay it — the barrel is over because a barrel is
supposed to be.

**The 8 KB is the document request path, and it now includes the route matcher.** It did not
at first: `createRouter` was never exported from the entry, so the figure described a kernel
whose `serve()` throws `E_NO_ROUTES`. Adding it cost 639 bytes and is the difference between a
number about something deployable and a number about a subset. The earlier figures — 7,602,
7,833, 7,360 — all excluded it.

**Route staging is the second time this rule changed a design rather than a number.** Written into
`channel.ts` it took the transport entry to 13,420 B against a watermark of 13,312 that was set
before route staging existed. Extracting one shared helper — a refresh and a stage ask the same
question about a slot, so they now ask it in the same place — returned 42 bytes and was better code
than the version that duplicated it. The remaining 108 went into `stage.ts` behind a hook, measured
under `entry-stage.ts`: a deployment that never stages a route never imports it, and its channel is
the size it was. The same thing happened on the client, where routing `NAV` in the channel took that
entry 86 bytes past its watermark and the frame moved to navigation's own module — which is also
where a frame kind belongs, since the capability that introduced it is the one that should carry it.

**The transport entry had four bytes left, and that was the interesting number on this page.**
Answering a `REFRESH` for a region needs a dispatch point, and a dispatch point lives in the shared
file by definition — so the cost cannot be moved to an entry of its own however the capability is
split. What could be moved was the mechanism: a table of handlers keyed by slot would have been a
third dispatch shape in that file, so a region answers through the return type `SlotSource` already
has, as a second shape rather than a second option, for **20 bytes**.

The paragraph above used to say nine, then four, and said each time that the next thing to touch
`channel.ts` either trims it or moves the watermark with a reason. Three things touched it and did
not, and the fourth — the patch rung — could not: 215 B of shared cost does not fit in four bytes by
any amount of cleverness. The watermark moved, and the paragraph above this one is the reason.

**Render intents cost five.** A `REFRESH` carrying `r=<id>` is answered by a slot source, and only the
header tells it apart from an ordinary refresh — so the header has to reach it, and `SlotRequest` gained
the frame that asked. Five bytes, and it is not a new mechanism: `WarmRequest` already carried `frame`
for exactly this, "for a handler that needs another header off it". The dispatch itself is
`entry-render.ts`, its own entry, and a deployment whose clients cannot name a renderable never imports
it.

**A rate limit's `Retry-After` cost zero, because it was not put on the wire.** The HTTP binding sets a
real header from `IntentOutcome.retryAfterMs`, which lives in `intent-http.ts` and not here. The ACK
could have carried the same value in ten bytes, and did for one commit — and nothing on the client read
it. Adding an unread header to the tightest file in the repository is precisely what this page exists to
catch, so it came back out. A reordering of `ackFrame` was tried as a trim first and was _worse_ by
eleven bytes: six `...(x ? {k:x} : {})` terms compress better than six conditional assignments, which
is the sort of thing only measuring tells you.

Four bytes is not headroom either. The rule stands and the reason now has two precedents behind it.

**Composition is the fifth time a capability argued with its own number rather than somebody
else's.** `entry-region.ts` is the document request path plus region resolution and the arrival check,
at 10,888 B against a stated 11,264. The interesting part is what it cost the entries it is not in:
`REGION` is a new frame kind, so every entry carrying the frame table moved a few bytes — the channel
10,669 → 10,678, the transport 13,261 → 13,283, the front door 12,223 → 12,227. Small, and recorded,
because the transport watermark has 29 bytes left rather than 51 and the next thing to touch the frame
table should be told that before it starts rather than by a red test.

**The composite graph is the case where a budget with 18 bytes left decided where code lives.**
Reporting a composite as a tree needs a wire form, a parser, a bound on depth and a check that the
graph and the hop count agree — call it 500 B, against an entry with eighteen. The first version put
the reader in `region.ts` and measured 11,760: 496 over, and a watermark that would have moved a
whole KB for a capability no request uses. The second put the parser in `region-tree.ts` and left
`readRegion` holding the body: 11,295, still 31 over. The third asked what the request path actually
needs and the answer was **nothing** — a page needs the hop count and the count is a header, so a
subtree travels only in a probe's answer, and the module that writes one is the module that reads
one. `entry-region.ts` is 11,246 B, unchanged to the byte, and `entry-region-channel.ts` is 16,268,
also unchanged. A ceiling with no room left is what produced the better factoring; a ceiling that
moved on request would have produced the first version.

**The front door's watermark moved for the first time, from 12 KB to 13 KB.** The exposed table — the
one channel between a shell and a region's client code — is 227 bytes that every page would otherwise
carry for a capability most pages do not use. The trims that existed were taken first: a named error
class the client package has no other instance of, two header aliases nothing sent, and the prose out
of a message that ships to every reader, for 164 bytes. What was left is the mechanism. It has its own
entry — `entry-expose.ts`, 4,368 B against 5,120 — so a deployment building its own boot module can
leave it out, and the front-door figure now says what it covers: **adoption to composition**, at
12,540 B with 772 left. Four moves in this figure's history, and this is the one with a capability
behind it rather than a frame table.

**A new capability gets its own entry and its own stated ceiling**, rather than being pushed
into an existing one. The alternative — one pool everything draws from — means the first
feature to arrive spends the headroom and every later one argues about it. The channel is
what made this concrete: charged to `entry-channel.ts` it went 53 bytes over a ceiling set
before it existed, and the fix is a third entry rather than a bigger second one. There is a
real deployment behind the split — surgical refresh over plain request/response, with no
long-lived connection, is how every phase 6 test worked before a channel existed.

**The third time it changed a design was the channel's frame dispatch.** Lazy plan extension arrived
as a second `WARM` grain beside route staging's, and the transport entry — 13,250 B against a 13,312
watermark — went to 13,307. Five bytes of headroom satisfies the rule and does not honour it: the
next grain would have had nowhere to go. So the channel stopped growing a case per capability. The
grains are a table now, `warm: { at, plan }`, one lookup answers any of them, and each handler is
charged to the entry that provides it — route staging's own header parsing moved out of the shared
file and into `stage.ts` where it belongs. The transport entry is 13,261 B: eleven bytes more than
before route staging had a second neighbour, for a mechanism that ends the growth.

**The front door's entry is the one that cannot be split, and it says so.** Every other client figure
measures a capability a page may decline to import; `boot.ts` measures the composition, so it
accumulates all of them by construction. Discovery, signed intents and a refusal toast took it from
11,048 B to 12,223 against a 12,288 watermark — 65 bytes left, and Warp 1.6.0's region frame took
four more. The next addition either trims
something or splits a capability out behind a dynamic `import()`, which this framework can do without
a bundler because client modules are already separate files on disk.

Intents were the first capability to arrive under this rule rather than into it, and it held.
The request path grew 41 bytes, for the delegation that answers a non-GET with a 405 and an
`Allow` header instead of routing it to a document — a kernel that serves a page in answer to a
POST is a kernel where a write can look like it succeeded, so those 41 bytes are not optional.
The other 9 KB is `entry-intent.ts`, and a read-only deployment never imports it.

The stampede lease is the case where the budget changed a design rather than a number. In the
request path — the kernel takes the lease, waits for the holder, polls the store — it came out
**13 bytes over 8,192**, and the design's own figure does not move. So the kernel names the seam
instead: it knows the two things that decide a coalesce (this key is cacheable, a render is
about to happen) and hands both to a `Coalescer`. 59 bytes rather than 165, and better layering
than the version that fitted would have been — an isolate-local map can only poll, and a store
with pub/sub should subscribe, and only the store knows which it is.

**Where there is no design figure, the ceiling is a watermark and says so.** Its only job is
to make a regression visible. Two of them state how much room is left and what it is for,
because a ceiling picked to fit what was just built is a label unless the next thing has to
argue with it.

## What may enter the request path

Two kinds of module are excluded by name, and the exclusion is a reachability gate in
[`standards.test.ts`](../../packages/kernel/test/standards.test.ts) rather than a convention:

- **Build-time work.** `plugin-graph.ts` resolves plugin ordering from static `reads` and
  `provides` declarations. There is no request involved, so `resolvePlugins` runs once and
  `createKernel` takes the schedule it produced.
- **Dev-time checks.** `plugin-guard.ts` enforces declared reads. The design specifies this
  check as one that throws in dev; a production request should not build a nine-method proxy
  per plugin to catch a mistake that fails on the first dev run. It is wired explicitly —
  `createKernel({ guard: guardReads })`.

Reachability rather than a grep, because a module three imports deep is in the request path
exactly as much as one imported directly.

## What is deliberately still in the request path

`schedule()` is pulled in transitively by `dispatch()`. Precomputing waves at lowering time
would save bytes, and it is not being done: the design says the plan is data specifically so
`SchedulerPort` can reorder slots at runtime to fill the pipe fastest-first. Freezing the
waves at build time gives that up. It is the one candidate where a byte saving costs a
declared design property, and it should not be given up by accident.

## The line-count check is not this

`standards.test.ts` also caps the kernel's source lines. That is a smell detector for the
kernel absorbing port-shaped work, not the budget.

It moved once, from 2,500 to 2,900, when routing landed — and **that move should not have
happened.** It was summing every file in `src/`, which is the same gross-versus-marginal
mistake the byte budget had already made and already fixed. Measured against the request path
it is meant to describe, routing never took it near 2,500.

Then it fired again, on a backpressure fix — and 30% of what it was counting was documentation. A
detector meant to catch absorbed work, firing because somebody explained the work. It counts
**code** lines now: comments and blank lines are stripped first, and the ceilings are re-derived
on that basis. Three re-derivations is enough evidence that the check's design is the problem, so
`standards.test.ts` carries a commitment: **a fourth means deleting it rather than fixing it.**

So the ceiling is back at 2,500 and each entry has its own, by the same reachability walk the
byte budget uses:

| Entry                     | Ceiling |
| ------------------------- | ------- |
| `entry-request.ts`        | 1,800   |
| `entry-channel.ts`        | 2,100   |
| `entry-intent.ts`         | 2,200   |
| `entry-authority.ts`      | 2,500   |
| `entry-transport.ts`      | 2,500   |
| `entry-stage.ts`          | 2,600   |
| `entry-discover.ts`       | 2,700   |
| `entry-render.ts`         | 2,800   |
| `entry-region.ts`         | 2,200   |
| `entry-region-channel.ts` | 3,100   |

`entry-intent.ts` moved from 2,100 to 2,200 when rate limiting landed, and the ceiling moved rather
than the code. The limit is a gate on _every_ intent, so its branch lives where the dispatch is, and
the port it calls through is declared beside the other thirteen. Both alternatives are worse: a second
dispatch site in the authority entry, or a port declared somewhere ports are not. The number that
actually gates moved 9,457 → 9,643 with 597 bytes left, which is the check doing its job — telling you
the intent path absorbed something, and letting you decide it belonged there.

The measured figures are deliberately not repeated here. Three re-derivations went into making this
check measure something, and a table of numbers in prose is a fourth one waiting to happen: the
ceilings are the commitment and `standards.test.ts` holds the measurements.

A companion gate asserts every source file is reachable from some entry or named as off the
request path, because a module that no ceiling applies to is a module that is invisible to
both of these. Four modules are named there, each with the reason next to it: plugin ordering and
declared-read enforcement are build- and dev-time, the coalescer is opt-in policy, and
`region-tree.ts` is deploy-time — a region describes its shape when something asks what the topology
is, and no request asks.

## The third redrawing: conditional values, and the 8 KB

`spec/FINDINGS.md` says a stated ceiling had been redrawn twice, and that a third time should be
treated as a rationalisation rather than a decision. This is the third time, so the argument is here
in full and the reader is invited to judge it as the warning intended.

**What moved.** `entry-request.ts` from 8,192 B to 8,320 B, and with it the client's
`entry-channel.ts` from 4,096 to 4,608 and the server's `entry-render.ts` from 14,336 to 14,464. Only
the first is a design figure; the other two are watermarks, which this document already moves when a
capability lands on one.

**What spent it.** A `cond` node in the derived-expression union — one arm in `evalDerived` and one
in the client's `evaluate` — which is what lets a hole hold `a ? b : c`, and `a ?? b` and `a || b`
lowered onto it. In the request path it is 14 B against 7 B of headroom.

**What was tried instead.** Five encodings, each measured: a `coalesce` flag on the node so `??` need
not name its operand twice (larger); a separate `cat` node for template literals (larger, and
unnecessary — `+` on a string already concatenates, so a template literal lowers to a `+` chain and
costs the client nothing); an operator lookup table replacing the `binary` switch (larger); hoisting
the shared operand evaluation (larger); and selecting the arm as a node rather than evaluating it
(larger). The plain form is the floor.

**Why it was worth it.** Without a conditional value a fragment cannot express a choice at all, so
every one moves into a loader and arrives as a string. That is not hypothetical: it is the state
`packages/docs` was in, with 476 lines of markup built by concatenation and outside everything the
compiler offers — no escape decision, no sealed template, no version. The 128 bytes buy the
expressiveness that lets a documentation site be written in the language this framework compiles.

**What it does not buy, and the line that did not move.** `on ? <b/> : <i/>` is still refused, and so
is `on && <b/>`. A sealed template's byte layout is fixed; a conditional _value_ fills one hole and a
conditional _shape_ would need the layout to vary. Structural branching needs variant templates and a
hole that selects among them — the machinery exists for rows and instances, but it is a separate
piece of work and it is not what this ceiling paid for.

**The tell to watch.** If a fourth redrawing arrives for a reason that reads like this one, the
scoping rule at the top of this document has stopped being a gate. The honest check is whether the
capability could have been an entry of its own; conditional values could not, because they are one
line in a function every entry already carries.
