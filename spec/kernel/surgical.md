# Surgical updates without a stateful server

Phoenix LiveView is the strongest prior art in this whole design, and the one thing it
structurally cannot do defines the opportunity. LiveView holds the previous render in a
process per connected user, so a diff is computed per connection and can never be shared. Ten
thousand users watching one price list produce ten thousand identical diffs in ten thousand
processes.

Keep the render state on the client instead. The client names the base render it holds; the
server recovers that base from the store, recomputes, diffs, and memoizes the result under the
transition. Any stateless isolate anywhere can serve it.

## The flow

```
client →  HELD    s12=a91f-abc123        // template a91f, base render abc123
          REFRESH s12 form=auto

server:  1. recover base abc123 through StorePort            base:a91f:abc123
         2. recompute
         3. diff dynamics → {total:"12,400 IQD"}
         4. memoize under the transition                     delta:a91f:abc123->def456
         5. record the new base                              base:a91f:def456

server →  DELTA   s12 base=abc123 next=def456 {total:"12,400 IQD"}

client:  the wiring table says total → a text node. one write.
         no diffing, no template execution, no vdom.
```

`surgicalRefresh()` is that, and `packages/kernel/test/refresh.test.ts` runs it end to end.

## Why the shared delta is the point

The delta is a pure function of two content-addressed states, so it is cacheable by exactly
the machinery that already exists — no new subsystem. The second client making the same
transition gets `memoized: true` and pays a store read. The ten-thousandth pays a store read.

This is the largest efficiency argument for content-addressing the whole design, and it is
unavailable to any framework holding render state per connection.

## The ladder, and a correction to the design

The design's degradation ladder has three rungs: base missing → send `data`; template not
resident → send `html`. **This repository has two**, because the `data` form was cut in IR
2.0.0 after measurement — 1% smaller after brotli and 1.07–1.33× slower to apply than `html`.
See `spec/FINDINGS.md`.

So a client that holds the template but whose base the server cannot recover falls straight to
`html` rather than to a projected value set. `selectForm()` implements it:

| Resident | Base recovered | `delta` derivable | Result                                 |
| -------- | -------------- | ----------------- | -------------------------------------- |
| yes      | yes            | yes               | `delta`                                |
| yes      | yes            | no (slot hole)    | `patch`                                |
| yes      | no             | —                 | `html`, or the declared fallback       |
| no       | —              | —                 | `bundle` if RTT ≥ 100 ms, else `split` |
| —        | —              | —                 | `html`, always available               |

Two rules hold throughout. A form the client did not accept at negotiation is never selected.
A form the template cannot serve is never selected — and `derivableForms()` already refuses
`delta` for a template with a `slot` hole or an isolated instance, because a hole this render
does not fill is not projectable from values the parent holds.

Every step degrades, which is what makes this deployable rather than clever. The fast path is
an optimisation over a correct slow path, never a replacement for it.

## `patch`: the rung that needs no template

The second row of that table used to say `html`, and it was the largest hole in the ladder. A
region with a `raw()` value, an isolated instance or a `slot` hole cannot serve a delta however
much the client holds — nothing about those holes is projectable from values — so the most
surgical mechanism in the design was refused by exactly the templates that had the most to gain
from it, and every refresh of them replaced a region.

A patch addresses the DOM **the way adoption does** rather than the way a delta does: an element
path walked over element children, and a marker ordinal for a text node that is not its element's
only child. Nothing is projected, so nothing has to be provable. What travels is the text or the
markup each changed hole produced this time.

| Hole                           | What travels                                | How it is applied       |
| ------------------------------ | ------------------------------------------- | ----------------------- |
| text                           | the value, unescaped                        | `node.data =`           |
| attribute, boolean, presence   | the value, or nothing, which means remove   | `setAttribute` / remove |
| `raw()`, sole child            | markup                                      | `innerHTML =`           |
| one row of a list              | that row's markup                           | `replaceWith`           |
| rows added, rows dropped       | the new rows' markup, or the new row count  | `append` / remove tail  |
| a component instance           | the instance's markup                       | `replaceWith`           |
| a `slot`, an isolated instance | nothing — those bytes are not this render's | never addressed         |

`opaque` carries the paths of the holes whose subtree owns its own markers, because the client
counts marker comments to find a text node and adoption skips those subtrees when it counts. A
client with no copy of the template arrives at the same ordinals, which is the whole point: a patch
is self-describing.

Addresses are all resolved before anything is written. A markup write moves the nodes a later
address would have counted, and resolving first is the difference between an order that happens to
work and one that cannot stop working.

### What it costs, measured

Apple M4, Chromium, the bench's own scenarios. Raw bytes and brotli:

| Region                        | `delta`   | `patch`     | `html`        |
| ----------------------------- | --------- | ----------- | ------------- |
| cart, 12 rows, one row edited | 77 / 62 B | 368 / 158 B | 1,582 / 296 B |
| feed, 50 rows                 | 233 / 95  | 1,052 / 192 | 6,289 / 502   |
| composed, a 141-byte region   | 15 / 19   | 110 / 93    | 141 / 78      |

And what applying one costs, p50, against the two forms either side of it:

| Scenario | `delta` applied | `patch` applied | `html` parsed |
| -------- | --------------- | --------------- | ------------- |
| cart     | 0.00061 ms      | 0.0064 ms       | 0.021 ms      |
| feed     | 0.0018 ms       | 0.0199 ms       | 0.077 ms      |

So the rung sits where a rung should: **4.3–6.0× smaller than the region raw, 1.9–2.6× after
brotli, and 3.3–3.9× cheaper to apply than the parse it replaces** — while costing 4.5–4.8× a
delta's bytes and 10–11× a delta's apply, which is what addresses cost when you cannot use a
binding table.

The third row is the floor, and it is in the table because it reverses the claim: on a 141-byte
region the patch is **larger than the markup after brotli** — 93 B against 78. Addresses do not
compress the way repeated markup does. It is still the better answer there, and for a reason that
is not about bytes: a markup replacement destroys every binding adopted inside the region, so the
front door re-adopts and re-wires it, and anything a reader was doing in there — a focused field, a
scroll position, a half-typed value — goes with it. A patch writes nodes and leaves adoption intact.
That is why the ladder prefers it and why the size comparison is reported rather than gated on.

The first implementation replaced a list's host content whenever anything in the list changed, and
the measurement killed it: on the cart scenario a one-row edit came out **1,663 B against the
region's own 1,582**. Rows are addressable — adoption already treats a list host's element children
as exactly the rows — so a changed row is one `replace` and a changed length is one `append` or one
`truncate`.

### Two refusals worth naming

**A patch is not stageable.** A `PATCH` naming an epoch is refused by the client, and the server
never sends one: `selectForm` drops the form when the frame will carry an epoch. A delta addresses a
binding, which does not move; a patch addresses a position, and another epoch's commit can move it
under the payload before it is applied. A form that cannot be held is not offered for holding.

**The encoder is a seam, not a policy.** `patchPayload` written into the refresh path cost every
entry carrying that path ~440 B of brotli and took four byte watermarks past their ceilings,
including two that a deployment composing regions pays and never uses. So it arrives through
`SurgicalInput.patch`, is measured under `entry-patch.ts`, and the front door binds it. A deployment
that does not has a ladder with the rung missing — and `selectForm` says exactly that rather than
falling silently to markup.

## Push invalidation, travelling the other way

`StorePort.invalidate(tags)` returns the keys it dropped. `createStaleRegistry()` maps
connection → slot → key, and `staleFor(dropped, reason)` turns those keys into `STALE` frames
for exactly the connections holding them.

```
STALE  s12 reason=tag:cart:42
```

The client then decides: refresh now, on next focus, or never. That is push invalidation of
server-rendered regions without turning the application into a realtime app.

## Measured: one transition, a thousand clients

The claim this whole flow exists to make. A per-connection differ — which is what LiveView's
architecture is, by construction rather than by choice — keeps the previous render in a process
per connection, so N connections making one transition produce N diffs. Keeping the state on
the client makes a delta a pure function of two content-addressed states, so one computation
serves all of them.

`node packages/bench/src/cli.ts deltas`, 1,000 clients, the 50-row feed with 6 rows changed:

| Arrival                     | Strategy       | Diffs | Memoized | Store reads | ms   |
| --------------------------- | -------------- | ----- | -------- | ----------- | ---- |
| all on one base render      | per-connection | 1,000 | 0        | 0           | 8.2  |
| all on one base render      | shared         | **1** | 999      | 1,001       | 0.3  |
| each on its own base render | per-connection | 1,000 | 0        | 0           | 9.2  |
| each on its own base render | shared         | 1,000 | 0        | 2,000       | 17.3 |

Both rows of the second block are the honest part. **When clients hold different bases there is
nothing to share**, and the shared path then does the same N diffs plus a store read and a write
for each — measurably worse, 17.3 ms against 9.2. Reporting only the first block would be
advocacy. The win is proportional to how many clients share a base, and the shape it is for is
a broadcast: a price list, a feed, a scoreboard.

Both figures come from the same differ over the same templates and the same transition, so the
only variable is where the previous state lives. Phoenix is not running: the per-connection
number is a real per-connection differ in this harness, and the claim it supports is
architectural. No constant factor of a LiveView deployment is measured or claimed.

## Incremental recompute

The design's three memoisation levels, all of them now real.

**Level one, the fragment**, keyed by its effect signature. That is `StorePort` and it has
existed since the plan layer.

**Level two, derived values.** `derivedPlan()` computes, once per template, which derived ids a
change can reach — transitively, since one derived value may read another. `resolveDerivedFrom`
carries the rest over from the previous resolved set.

**Level three, template segments.** A rendered nested template is a pure function of its
version and its values, so it is content-addressed: `segmentKey(tpl, values)`. A list of 500
rows where three changed costs three row renders. A _reordered_ list costs none, because the
key is the content and not the index.

Three scoping decisions, stated rather than discovered:

- **Only nested templates are memoised** — list rows and component instances. A text hole is one
  escape scan and one encode, and hashing its value costs more than rendering it. A memo that
  loses is worse than no memo.
- **The memo is process-local**, because `render` is synchronous: it writes into a buffer and
  returns a byte count, so a memo it consults must answer synchronously. Sharing row bytes
  between isolates would mean making rendering async, which would cost every render more than it
  saves any. The sharing stops at the isolate boundary, and that is the honest statement.
- **Structural change is reported, not hidden.** A hole whose shape changed — a list that is
  suddenly not an array — is named in `stats.structural`. A slot reporting structural change
  every time is a slot for which `.incremental()` costs rather than saves.

The property that makes it safe to turn on is byte identity with a full render, and it is a gate
rather than a claim: `weft-bench verify` renders every scenario both ways, cold memo and warm,
and refuses to publish numbers if a single byte differs.

## What this does not do yet

- **Base renders and memoized deltas expire after fifteen minutes** by default, configurable per
  refresh. An expired base costs a form and never correctness: the client names one the server
  cannot recover, `selectForm` falls to `html`, and the page is right. A shorter ceiling costs
  only delta hit rate.
- **The delta is not served from a CDN.** It is cacheable by construction and only ever read
  from `StorePort`.
