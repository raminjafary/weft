# A plan generated from measurement

The convention generates a plan from the file tree. What the file tree cannot say is what any of it
**costs**, and delivery is a decision about cost: whether a region should arrive separately depends
on how long it takes on this deployment with this data. An author asked to guess that guesses
`stream: true` on everything, which buys the out-of-order filler for a page whose regions all
arrive together.

So: record what happened, and let the recording decide the part of the plan that is about time.

## What is recorded

`weft dev --profile`, or `profile: true` in the config, and the process writes
`.weft/profile.json` as it serves — every thirty seconds and again on the way out, because the
interesting case for a profile is a process that was killed.

| Field                | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `routes[].requests`  | Document requests matched to this pattern                          |
| `slots[].renders`    | Renders that actually happened. A hit is not a render              |
| `slots[].p50`, `p95` | Milliseconds to produce the bytes, loader included                 |
| `slots[].bytes`      | The largest render seen. A small region gains nothing from a flush |
| `slots[].hits`       | Requests the store answered for                                    |
| `routes[].from`      | Which pattern the reader came from, and how often                  |
| `routes[].described` | Times this route was described to a client that had not been to it |
| `routes[].followed`  | Times such a description was then used                             |

**Where the numbers come from, and why not from telemetry.** A `TelemetryPort` sees `slot.render`
with a slot name and no route, because the executor that emits it has no idea what page it is on —
and `body` is a different slot on every route. The front door knows both, so the recorder is wired
where the front door already wraps a slot's render. A request path serving a deployment that asked
for no profile pays nothing.

**A hit is the absence of a render**, so it cannot be counted where renders are. The kernel's trace
names the key each slot resolved to and the keys that hit, so the difference is read from there
after the response — which is also what makes "slow for readers" and "slow the first time"
distinguishable.

**Transitions come from `Referer`**, matched against the same router the request went through — a
referer is a URL and a route is a pattern, so `/app/ordinary/pantry` and
`/app/ordinary/:category` are never equal. A staged navigation sends a referer too, so a page
reached by a DOM swap counts the same as one reached by a load.

## What it decides

Two things, and both are about **time**. A profile cannot move a fragment, change a cache class or
touch a key: those belong to the compiler and the convention, and a recording of last Tuesday has no
standing over any of them. What it does have standing over is delivery — whether a region is worth its
own flush — and whether describing a route to a client that has not been to it is worth the bytes.
Both were guesses in a declaration, and this is a measurement.

### Whether a region is worth its own flush

| Observation                                                  | Decision                                     |
| ------------------------------------------------------------ | -------------------------------------------- |
| p95 ≥ 40 ms, ≥ 512 B, and something on the page is 2× faster | `stream`, priority by p50 ascending          |
| Every region fast                                            | `buffered` — in-order, no filler on the wire |
| Every region slow                                            | `buffered` — a reader waits either way       |
| Under 512 B                                                  | `buffered` — too small for its own flush     |
| Fewer than 8 renders                                         | nothing. The convention's placement stands   |

The two "every region" rows are the same argument from both ends: out-of-order delivery costs a
329-byte filler and buys fastest-first, so it is worth it exactly when there is a spread to
exploit. A page whose regions are uniformly slow gains nothing, and one whose regions are uniformly
fast pays the filler for nothing.

**Priority is fastest-first**, derived from the same numbers, so the region that can paint soonest
does.

**Eight renders is the floor.** Two requests are not a measurement. A slot under the floor is left
exactly as the convention placed it and the report names it — and a slot that is nearly always a
hit is a slot whose delivery barely matters, so having nothing to say about it is the right answer
rather than a gap.

### Whether a route is worth describing

The second decision, and the one thing about discovery that was never a measurement. A `PLAN` frame
describes routes a client has not been to — every field in it is something the client would otherwise
spend a request to learn, and the expensive one is the shell, because a link into a different document
cannot be swapped in as regions and finding that out by asking costs a round trip _and_ a server render
of a page nobody clicked.

That is the case for describing. What was missing is the case against: bytes spent on a page nobody may
open. It is the same question as whether a route is worth staging, with the same answer — it is a
measurement — and nothing recorded it, so the handshake described whatever the transition table said
and no number ever came back to say whether the describing helped.

| Observation                                      | Decision                                      |
| ------------------------------------------------ | --------------------------------------------- |
| ≥ 20% of descriptions followed, over ≥ 8 of them | `describe`                                    |
| Under 20%                                        | `skip` — the bytes buy nothing here           |
| Fewer than 8 descriptions                        | nothing. An unmeasured route keeps describing |

**Twenty percent, against staging's fifteen and four.** The asymmetry is the point: a description is a
line in a frame the connection was already getting, and being wrong four times out of five still pays,
because the one time it is right it saves a round trip and a render. Staging is the expensive one — it
runs loaders — so it needs the higher bar.

**A description is counted as followed only when this connection was told about it.** A client asks to
stage a route it has not been to _because_ it was described one; it has no other way to know the shell
matches. So a `WARM at=` for a described pattern is the description being used, and one for an
undescribed pattern is a hover on a link the page had anyway — counting that would make every
description look successful.

**A prefix somebody asked about is described whatever the recording says.** The measurement is about
what this deployment _volunteers_, in the unasked frame when a channel opens, and a question is not a
volunteer. `weft.discover('/checkout/*')` is answered either way.

## What it refuses to decide

Printed by `weft profile` rather than left as a silence, because two of these are in the design and
a reader is entitled to know why they are not here.

**Chunk packing.** There is no bundler. Client modules are TypeScript served with their types
stripped, so there are no chunks to pack. The design assumes a bundler this framework deliberately
does not have, and packing chunks that do not exist is not a thing a profile can do.

**V8 compile hints.** A template is data here, not code. There is no per-template function to hint:
the renderer walks pre-encoded segments, so the hot code is the renderer and it is hot on every page
already.

**Whether a subtree is worth describing before anybody has looked at it _at all_.** The half above is
measured: a description handed out and followed, or not. What has no observation behind it is a prefix
no client has ever asked about and no transition points at — there is nothing to count, and inventing a
number would be the guess this whole layer exists instead of. So half of the discovery question is a
decision and half is a stated refusal, because a capability that is half built and reads as whole is
worse than one that says which half.

**A cache key.** Keys come from what the compiler saw a fragment read. A profile is not a compiler,
and this is the one extension point the design refuses on purpose.

## The demo, recorded

Twelve passes over seven pages, each page linked from the one before:

```
  /app/dashboard   12 request(s)
    readout      buffered         only 163 B: too small to be worth its own flush
    panel        buffered         p95 0.2ms over 12 renders: fast enough to buffer behind
    slowest      stream prio 0    p95 601.9ms over 12 renders, 667 B: slow enough to arrive
                                  separately, and something on this page is at least twice as fast
    readers arrive from /app/cart often enough to stage this route

  /app/article   12 request(s)
    panel        buffered         p95 0.2ms over 12 renders, and no region on this route is slow
                                  enough to wait behind: in-order, so the filler is not on the wire
```

Two things in that output are worth reading twice. The dashboard's `slowest` panel is the only
region on the whole demo the profile streams, and it is the one the demo made deliberately slow —
so the measurement found the thing that was planted for it to find. And most `body` slots appear
under "too few renders to decide" with one render and eleven hits, which is not a shortcoming of
the recording: a region the store answers for is a region whose delivery hardly matters.

## What is not built

**The version is `2`.** Counting discoveries added two fields, and a minor addition to a format is
still a format change — so an older profile is ignored rather than half-read. That matters more here
than it usually would: a missing `described` reads as zero, and zero means "described and never
followed", which is the _opposite_ of the truth for a recording that never counted.

**`weft profile --apply` does not exist**, and deliberately: the profile is read at generation time,
so the next `weft dev` or `weft build` already plans from it and `routes.json` shows the result.
A second copy of the decisions, written to disk by hand, would be a plan somebody wrote with extra
steps.
