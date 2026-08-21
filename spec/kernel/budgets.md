# Byte budgets, and what each number covers

The design states one server-side figure — "target under 8 KB" — and the kernel it describes
does more than one job. A single number over several jobs is a number you can satisfy by
moving its boundary, which makes it a label rather than a gate. So the ceilings here are
**per entry**, each entry is a real module that a deployment can import on its own, and each
one says what it covers and where its figure comes from.

The measurement is in [`packages/bench/src/budget.ts`](../../packages/bench/src/budget.ts) and
the gate is the test that calls it. Rolldown, minified, brotli at quality 11 — what ships.

## The entries

| Entry                | Covers                                                                            | Measured | Ceiling  | Where the ceiling comes from                             |
| -------------------- | --------------------------------------------------------------------------------- | -------- | -------- | -------------------------------------------------------- |
| `entry-request.ts`   | Lifecycle, two-phase envelope, routing, key derivation, wave dispatch, the stream | 8,040 B  | 8,192 B  | The design's "target under 8 KB server-side"             |
| `entry-channel.ts`   | The above, plus surgical refresh, form selection, epochs, the stale registry      | 10,255 B | 12,288 B | No design figure. A watermark                            |
| `entry-intent.ts`    | The request path, plus intent dispatch, capability checks, method-aware routing   | 9,147 B  | 10,240 B | No design figure. A watermark                            |
| `entry-transport.ts` | The channel path, plus a live channel: negotiation, held state, push invalidation | 12,645 B | 13,312 B | No design figure. A watermark                            |
| `index.ts`           | Everything, including build-time validation and serialisation                     | 11,601 B | —        | Not a claim. Reported so the marginal split is checkable |

On the client, same rule:

| Entry              | Covers                                               | Measured | Ceiling  |
| ------------------ | ---------------------------------------------------- | -------- | -------- |
| `entry-content.ts` | Adopt and bind                                       | 2,082 B  | 5,120 B  |
| `entry-app.ts`     | Plus deltas, epochs, residency                       | 2,982 B  | 12,288 B |
| `entry-channel.ts` | Plus routing arriving frames into regions and epochs | 3,721 B  | 4,096 B  |
| `index.ts`         | Everything                                           | 3,735 B  | 6,144 B  |

**The 8 KB is the document request path, and it now includes the route matcher.** It did not
at first: `createRouter` was never exported from the entry, so the figure described a kernel
whose `serve()` throws `E_NO_ROUTES`. Adding it cost 639 bytes and is the difference between a
number about something deployable and a number about a subset. The earlier figures — 7,602,
7,833, 7,360 — all excluded it.

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
it is meant to describe, routing never took it near 2,500: the request path is 2,316 lines.

So the ceiling is back at 2,500 and each entry has its own, by the same reachability walk the
byte budget uses:

| Entry                | Lines | Ceiling |
| -------------------- | ----- | ------- |
| `entry-request.ts`   | 2,316 | 2,500   |
| `entry-channel.ts`   | 2,694 | 2,900   |
| `entry-intent.ts`    | 2,710 | 2,900   |
| `entry-transport.ts` | 3,171 | 3,300   |

A companion gate asserts every source file is reachable from some entry or named as off the
request path, because a module that no ceiling applies to is a module that is invisible to
both of these.
