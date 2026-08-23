# Byte budgets, and what each number covers

The design states one server-side figure — "target under 8 KB" — and the kernel it describes
does more than one job. A single number over several jobs is a number you can satisfy by
moving its boundary, which makes it a label rather than a gate. So the ceilings here are
**per entry**, each entry is a real module that a deployment can import on its own, and each
one says what it covers and where its figure comes from.

The measurement is in [`packages/bench/src/budget.ts`](../../packages/bench/src/budget.ts) and
the gate is the test that calls it. Rolldown, minified, brotli at quality 11 — what ships.

## The entries

| Entry                | Covers                                                                            | Measured | Ceiling  | Where the ceiling comes from                                        |
| -------------------- | --------------------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------- |
| `entry-request.ts`   | Lifecycle, two-phase envelope, routing, key derivation, wave dispatch, the stream | 8,169 B  | 8,192 B  | The design's "target under 8 KB server-side"                        |
| `entry-channel.ts`   | The above, plus surgical refresh, form selection, epochs, the stale registry      | 10,461 B | 12,288 B | No design figure. A watermark                                       |
| `entry-intent.ts`    | The request path, plus intent dispatch, capability checks, method-aware routing   | 9,288 B  | 10,240 B | No design figure. A watermark                                       |
| `entry-transport.ts` | The channel path, plus a live channel: negotiation, held state, push invalidation | 13,250 B | 13,312 B | No design figure. A watermark                                       |
| `entry-stage.ts`     | The above, plus a whole route staged over the channel: `WARM at=`, `NAV`          | 13,516 B | 14,336 B | No design figure. Its own, because it went past the watermark above |
| `index.ts`           | Everything, including build-time validation and serialisation                     | 11,601 B | —        | Not a claim. Reported so the marginal split is checkable            |

On the client, same rule:

| Entry              | Covers                                                              | Measured | Ceiling  |
| ------------------ | ------------------------------------------------------------------- | -------- | -------- |
| `entry-content.ts` | Adopt and bind                                                      | 2,226 B  | 5,120 B  |
| `entry-app.ts`     | Plus deltas, epochs, residency                                      | 3,119 B  | 12,288 B |
| `entry-channel.ts` | Plus routing arriving frames into regions and epochs                | 4,004 B  | 4,096 B  |
| `entry-nav.ts`     | Plus routes staged and unpainted, `NAV` frames, and what a click is | 4,754 B  | 5,120 B  |
| `index.ts`         | Everything                                                          | 4,680 B  | 6,144 B  |

Navigation is the client-side case of the rule below: 665 bytes on top of a channel route, in an
entry of its own, because a page that links nowhere should not carry the staging model. The
ceiling leaves 451 bytes, which is what the next thing added to a navigating page argues with.

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

**A new capability gets its own entry and its own stated ceiling**, rather than being pushed
into an existing one. The alternative — one pool everything draws from — means the first
feature to arrive spends the headroom and every later one argues about it. The channel is
what made this concrete: charged to `entry-channel.ts` it went 53 bytes over a ceiling set
before it existed, and the fix is a third entry rather than a bigger second one. There is a
real deployment behind the split — surgical refresh over plain request/response, with no
long-lived connection, is how every phase 6 test worked before a channel existed.

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

| Entry                | Lines | Ceiling |
| -------------------- | ----- | ------- |
| `entry-request.ts`   | 1,693 | 1,800   |
| `entry-channel.ts`   | 1,982 | 2,100   |
| `entry-intent.ts`    | 1,974 | 2,100   |
| `entry-transport.ts` | 2,349 | 2,500   |

A companion gate asserts every source file is reachable from some entry or named as off the
request path, because a module that no ceiling applies to is a module that is invisible to
both of these.
