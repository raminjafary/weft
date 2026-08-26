# What measurement did to the design

The three documents in [`docs/`](../docs) are the design as written, in August 2026, before
any of it had been built. This is the record of what happened when it was, claim by claim.
Five things are now wrong — four the design said, and one this repository published about itself —
and they are wrong in ways worth reading rather than quietly editing away.

Nothing here is a hypothetical. Every number comes from
`node packages/bench/src/cli.ts`, on an Apple M4, and every one of them is reproducible by
the command the report prints.

| The design says                                                 | Verdict                                              |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| TTFB against a tuned React Router 7 app is the phase-zero gate  | **Reversed** — worth 1.2 ms                          |
| Six negotiable wire forms, including `data`                     | **Cut to five**                                      |
| Escape elision is a throughput lever                            | **Reversed** — worth nothing                         |
| Incremental declarative shadow DOM is the largest platform risk | **Did not materialise**, and sharpened               |
| Streaming beats a blocking response                             | **Confirmed** — 2.19×                                |
| Pre-encoded segments beat string concatenation                  | **Confirmed** — 1.4× to 2×                           |
| The `delta` form is the smallest possible payload               | **Confirmed** — 3.2× after brotli                    |
| A returning visitor does zero wiring construction               | **Confirmed, with a correction**                     |
| The client runtime fits in 4–6 KB                               | **Confirmed** for what exists                        |
| Isolated DOM updates will tie                                   | **Consistent** — 0.29–1.7 µs                         |
| Warp unifies five jobs on one channel                           | **One path exercised** of five                       |
| Client rendering work belongs off the main thread               | **Refused** — the decode is under the worker's floor |
| The front-door entry is what a page downloads                   | **Reversed** — 3.5× under the served figure          |

## Reversed: the front-door figure was measuring a bundle this framework does not ship

> _"`boot.ts` (front door) — what a page actually downloads — 12,540 B."_

That entry was added because nothing was measuring the composition a reader actually loads, which
was the right instinct and the wrong measurement. It bundles with Rolldown and minifies. This
framework has **no bundler and no minifier**, on purpose and in writing: a page fetches the boot
module and each module it imports as its own response, served as written with types stripped and
comments intact.

Wiring `budget({ js })` to a real number is what exposed it. Walking the graph the browser walks and
compressing each response the way it arrives:

| The demo's client            | Modules | Raw       | Brotli       |
| ---------------------------- | ------- | --------- | ------------ |
| Bundled and minified         | 1       | 43,383 B  | 13,428 B     |
| **Served, module by module** | 19      | 176,264 B | **46,698 B** |

**3.5× the figure that was published**, and the same walk over HTTP against the running server
agrees within 0.3% — 46,830 B, the difference being the boot prelude the front door adds.

Where the bytes are: nearly half of it is `boot.ts` alone, a file whose comments are a large
fraction of it. Nothing here is a compression failure; it is what "no minifier" costs, measured
instead of assumed. Two smaller effects are in the number too and are worth knowing — a barrel of
re-exports compresses to _more_ than it was, because a brotli stream has a header and a fifty-byte
file has nothing to find, and nineteen responses cannot share a compression window the way one
bundle can.

The bundled entry stays and is relabelled. It is a good gate on how much code the front door _is_ —
minified bytes are a proxy for logic, and comments do not move them — and it is no longer allowed to
stand in for what a page pays. The download figure is measured by `measureClientJs`, gated by
`budget({ js, grow })`, reported by `weft build` and committed as `weft.budget.json`, so a
regression is a diff.

## Refused after measuring: decoding frames off the main thread

> _"Off-main-thread rendering, client side. Nothing runs in a worker. What could be prepared
> off-thread — parsing a `TPL`, resolving derived values — is not."_

This sat on the roadmap as the last honestly-absent line of phase 3, which made it look like work
nobody had got to. It is not: it is work that does not pay, and the number says so.

`applyDelta` writes the DOM and cannot leave the main thread by nature. The candidate was the
byte-walking half of the frame router — length prefixes, headers, JSON bodies — so both paths were
measured against each other in a real engine before anything was built on either.
`node packages/bench/src/cli.ts decode` transfers the same batch to a module worker, decodes and
parses it there, and structured-clones the frames back.

| A `DELTA` of       | On the wire | Main thread | In a worker |
| ------------------ | ----------- | ----------- | ----------- |
| 400 changed values | 10.8 KB     | 0.100 ms    | 0.100 ms    |
| 2,000 values       | 55 KB       | 0.200 ms    | 0.200 ms    |
| 20,000 values      | 580 KB      | 1.500 ms    | 1.600 ms    |

Chromium clamps `performance.now()` to 100 µs here, so the first two rows are both _at the
resolution of the clock_: the decode of a realistic frame batch is too small to measure. At 580 KB —
twenty thousand changed values, which is not a page anybody has — the decode is finally measurable
at 1.5 ms and the worker is **slower**, because a `postMessage` and the structured clone of the
result cost about what the decode costs.

That is the general shape rather than an accident of this codec. A worker pays for moving data twice
and earns it back only when the work between the two moves is large. Decoding is the opposite: it
consumes bytes and produces _more_ objects than it consumed, so the return trip is the expensive
half. What would pay is work that shrinks its input — a diff, a digest, a projection — and the
client's diffing already happens on the server, which is what the shared-delta finding is about.

So this is refused rather than pending, and the roadmap says so with the numbers. What remains
genuinely unmeasured is parsing a staged _document_ off-thread, which is not possible at all:
`DOMParser` does not exist in a worker.

## Reversed: TTFB was the wrong gate

> _"If the pre-encoded-buffer shell does not beat a tuned React Router 7 app on TTFB in a
> reproducible test, the central premise is wrong and better to know in week two."_

The test exists now — a route whose data takes 40 ms, 40 ms of injected RTT, and a real RR7
app in two configurations. Against the **tuned** one (promise loader, Suspense boundary,
piped on `onShellReady`) the shell reaches first byte in 43.46 ms against 44.65 ms. That is
1.03×, a 1.2 ms difference on a 43 ms number. Remove the network and it is 3.46× — real
server work, and irrelevant to a person, because any actual RTT swamps it.

So the premise survives and the framing does not. What the same test established instead is
worth more: against RR7's **default** shape, the one most applications ship, the difference
is 2.19×, and it is architectural rather than a tuning gap. A blocking response pays its
query before its first byte and no renderer improvement recovers that. Weft cannot be
configured into it, because a fragment that reads something slow becomes a hole by
construction.

## Cut: the `data` form

> _"`data` — values only, keyed to a resident template. Client work: project through
> template."_

Raw, it was half the size of `html`. After brotli it was 599 bytes against 605 — a 1%
difference, because compression already removes the template redundancy that `data` removed
semantically. Turning a payload into DOM then cost 1.07–1.33× **more** as `data` than as
`html` in all three engines, since values must be parsed and projected before anything
reaches the HTML parser, and the parser is native code. That is the design's own argument
about server-rendered DOM, turned on one of its own forms.

The decisive objection is not numeric. **A `data` refresh into a resident template is a
`delta` that has declined to diff.** There is no regime where it wins: a full-region refresh
is cheaper as `html`, a partial one is cheaper as `delta`. It was removed in template IR
2.0.0 — a form leaving the vocabulary is a wire break, so the major exists to make older
documents refuse rather than misparse.

## Reversed: escape elision is not a throughput lever

> _"Escape elision. The compiler proves which interpolations are already safe — numbers,
> enums, values from sanitizing sources — and skips escaping them entirely."_

The compiler does this, using type information from the checker. It is worth nothing:
16,780 ns per render with four holes elided against 16,503 ns with none. The renderer
already elides at runtime by scanning a value and writing it untouched when the scan finds
nothing, and for `"8715"` that scan is a few nanoseconds. The compile-time proof saves the
scan, and the scan was never the cost.

The 7.9% that was briefly attributed to elision belongs to the **marker comments** the
compiler emits so a dynamic text node is addressable — a real cost for a real capability.
The pass stays anyway, on a smaller claim: an escape class that says "escape" about a number
is a lie, and a native codec crossing a WASM boundary per hole cannot afford the scan that
makes the lie harmless.

## Did not materialise, and sharpened: declarative shadow DOM

> _"Incremental DSD parsing is the single largest platform risk … If the three engines
> diverge, the filler script becomes the primary path rather than the fallback."_

Probed with a host that does not close until 60 ms: the shadow root is attached at 9 ms in
Chromium, 38 ms in Firefox, 8 ms in WebKit, and slotted content renders as it arrives in all
three. Incremental parsing works. The engines do not diverge.

Building on it produced a sharper statement than the design's own correction, though.
**Zero-JavaScript filling and out-of-order filling are mutually exclusive.** Slot assignment
works on the light-DOM children of a host that is _still open_, and keeping a host open
until its content arrives is precisely in-order streaming — which needs no fill mechanism
at all, because the content lands where it belongs. Out-of-order requires every host to be
closed, so content must arrive elsewhere and be moved, and moving a node is JavaScript.

The filler is therefore not a fallback for weaker engines. It is the price of fastest-first
on every engine, and it costs 329 bytes to buy a fast region at 22 ms instead of 103 ms.

## Confirmed, with a correction: repeat visits

> _"Wiring tables are content-addressed per template version, so a returning visitor does
> zero wiring construction."_

True, and not the same as zero startup work. A repeat visit skips receiving, parsing and
storing templates — 2 frames and about a kilobyte become none — and the boot path drops from
2.50 ms to 0.70 ms in Chromium, 6.00 to 3.00 in Firefox, 3.00 to 1.00 in WebKit. What it
still pays is **adoption**, because the DOM in front of it is new every time and the bindings
must be found again. Only the table adoption builds _from_ is cached, never the walk.

Storage is IndexedDB rather than a service worker, because WKWebView gates service workers
behind app-bound domains — the traffic where a repeat-visit gain matters most is the traffic
that does not have them.

## Corrected mid-flight: the `delta` form's client cost

Not a design claim, but this project's own worst error, and it belongs on the record. Before
a client runtime existed, the harness measured a delta by re-projecting the whole region and
reported it **1.28× worse** than sending markup. That number was published here for two
commits. It was measuring a client that could not address its own holes: only signal-wired
bindings carried addressing, so a server-owned value could not be located. With anchors on
holes (IR 2.1.0) a delta is applied as designed — one write per changed value — and is
**20–93× cheaper** than the parse it replaces.

The lesson is not about deltas. A measurement of a capability that does not exist yet
measures the stand-in, and reports it as if it were the thing.

## Paid for, honestly: the signal graph rewrite

The graph was rewritten to alien-signals' shape — doubly linked dependency edges, bitflag
node status, push-pull propagation with a lazy `checkDirty` — replacing a value with a
`Set` of subscribers. The stated reason was derived values: nothing computed on the
client, so the compiler had to refuse `{n() * 2}`.

Measured back to back on one machine on the `isolated-dom-update` axis, the rewrite made
the one-signal-one-node case **slower**: 0.28 → 0.31 µs on Chromium, 0.72 → 0.74 µs on
WebKit, a tie on Firefox. The old code went straight from `set` to the subscriber call;
this one pushes through propagate, a queue and a flush. The runtime grew 1,695 → 2,583
bytes brotli. The axis expects a tie against Solid, Svelte 5 and Vue Vapor, and it is
still a tie — but a rewrite that costs 7% on its own referee is not a performance win, and
recording it as one would be the same error as the `delta` correction below.

What it bought is one step out, and it is real: on the `derived` scenario, one signal
write reaching a node **through a computed** is not separable from the direct write at
this sample size in any of the three engines. The harness refused all three comparisons
rather than report a difference inside its own noise. Laziness, diamond dedup and dynamic
dependencies arrived at no measurable per-write cost — which is the claim worth making,
rather than a throughput one.

## Caught by a gate: a delta was carrying values nothing could write

Adding a scenario whose holes are computed rather than bound directly made the
cross-engine conformance check fail on "a delta writes one value per changed path". Two
distinct bugs were behind it, both older than derived values:

A delta diffed the whole value set, including bindings with **no hole in the template**. A
prop that appears only inside an expression has nothing to be written into, so the client
skipped it — one write for two paths. Deltas now carry only what the template can address.

The scenario's own transition moved a **signal**, asking the server to re-render state the
client owns. That is not a bug in the delta; it is a category error in the scenario, and
the fix was to move a prop instead. The rule it forced into the format is worth more than
the fix: a derived value that reaches a signal is the client's, and a delta must never
carry it.

## Clarified: a flag axis is also a key component

The design says a flag is "an axis rather than a key component", and `keyComponents()` in
`@weft/ir` excludes `flag:` reads accordingly. The design's own worked example puts one in the
key:

```
derived key = h(cart-summary@a91f, new-cart=on, currency=IQD)
```

Both are right about different things, and building the resolver forced the distinction to be
made explicit. An axis **partitions the plan**, which is what makes the losing branch's chunks
unreachable — that is why it is reported separately. It is still **in the key**, because two
flag resolutions produce different bytes and one entry cannot hold both. `ResolvedKey` now
carries `components` and `axes` as separate fields and hashes both.

## Corrected: the degradation ladder has two rungs, not three

The design's stateless-refresh flow degrades in three steps — base not in cache → send `data`;
template not resident → send `html`. The `data` form was cut in IR 2.0.0 on measurement, so
there is no middle rung. A client that holds the template but whose base render the server
cannot recover falls straight to `html`.

This is the `data` cut paying a second time. The first cost was a wire form; the second is a
coarser degradation for a returning client on a cache miss. Both were the right call on the
numbers, and the second cost was not visible when the first decision was made.

## Measured: the kernel against the design's 8 KB

The design claims "target under 8 KB server-side" for the microkernel and nothing had measured
it. Bundled with Rolldown, minified, brotli:

| Entry                                           | brotli   | Ceiling  |
| ----------------------------------------------- | -------- | -------- |
| Document request path (`entry-request.ts`)      | 7,602 B  | 8,192 B  |
| Plus the Warp channel path (`entry-channel.ts`) | 9,846 B  | 12,288 B |
| The whole barrel (`index.ts`)                   | 10,686 B | —        |

The claim holds, with **590 bytes of headroom**, and only for the entry the claim is about.
The first attempt measured the barrel and came out 29% over — which is the marginal-versus-gross
mistake the design warns about in the same paragraph as the byte budget, made immediately and
in the obvious place. The split into two entries is not bookkeeping: a deployment serving
documents does not import surgical refresh or epochs, and measuring it as though it did is how
budgets become meaningless and get switched off.

There is no headroom for routing, intents, or an epoch transport in the 590 bytes. That is a
statement about the next phase, not this one.

## Caught by a gate on its first run: the kernel imported `node:http`

`spec/kernel/ports.md` states the rule absolutely — the kernel imports nothing but the WinterTC
Minimum Common Web API — so a test was written to enforce it. It failed immediately:
`serveRoute` had lived in `packages/kernel` since the streaming work and imports `node:http`
and `node:stream`. It moved to `@weft/adapters`.

Worth recording because the rule had been written down for weeks and read by people who
believed it. A design constraint that is not a gate is a design constraint that is already
violated somewhere you have not looked.

## Caught by a test with two links in it

`nodeTransport` joined its preload hints into one `Link` value, the way a real `Link` response
header is written. Node's `writeEarlyHints` validates each value and rejects the joined form
with `ERR_INVALID_ARG_VALUE`. Every manual check had used a single link, where the joined form
and the array form are the same string.

The fix is two exports rather than one — `linkValue` for a transport that needs them
separately, `linkHeader` for a real header — and the note is on the function, because the next
person will reach for the joined form too.

Two smaller things surfaced in the same test. The kernel was returning a document with no
`content-type`, which nothing had noticed because every other test read the body as text. And
`mountKernel`'s `close()` never resolved once a keep-alive socket existed, because
`server.close()` waits for connections — a close that does not close.

None of these are interesting bugs. They are all bugs that only a test going over a real
socket can find, which is the argument for having one.

## Paid for, honestly: routing

231 bytes brotli. The document request path went 7,602 to 7,833 against the design's 8,192, so
**359 bytes of headroom remain**.

That number is now small enough to be a real constraint rather than a reassurance. Intents, a
Warp transport binding and lazy plan extension are all still to come, and none of them fits in
359 bytes. The honest reading is that either the 8 KB claim covers a smaller kernel than the
design's full feature list implies, or something currently in the request path has to move
behind a port. Recorded now, while it is a measurement rather than an argument.

The kernel's source-line check fired at the same time — 2,770 against a 2,500 ceiling — and the
ceiling moved to 2,900. That is worth being uncomfortable about: a gate that moves when it
fires is not a gate. The distinction being relied on is that the byte budget is the design's
claim and the line count is a smell detector for the kernel absorbing port-shaped work, and
routing is one of the four jobs the design gives a kernel. If the line count moves again for
something that is not one of those four, it was never a gate.

## Paid back: 473 bytes that were never request work

Two things in the request path had no business being measured against a per-request budget,
and moving them cost nothing the design had promised.

`resolvePlugins` infers plugin ordering from static `reads` and `provides` declarations, runs a
topological sort, and refuses duplicates, ambiguity and cycles. None of that involves a request.
`createKernel` now takes the resolved `PluginSchedule` instead of a plugin list, so the sort
happens once at build. Collecting `planAxis()` moved with it, for the same reason: it takes no
request either.

`guardReads` wraps the envelope context so a plugin's undeclared read throws. The design already
specifies this as a check that throws _in dev_; it was in the production path because it had been
built as one thing with the plugin runner. It is now passed in — `createKernel({ guard: guardReads })`
— and a production build never imports it.

| Entry                 | Before   | After   | Ceiling  |
| --------------------- | -------- | ------- | -------- |
| Document request path | 7,833 B  | 7,360 B | 8,192 B  |
| Plus the Warp channel | 10,084 B | 9,583 B | 12,288 B |

**832 bytes of headroom**, up from 359. Worth naming what this is and is not: it is 473 bytes of
work that was in the wrong place, not 473 bytes of savings found by shrinking the kernel. Nothing
the design promised got smaller.

The exclusion is now a gate rather than a preference — a reachability walk from
`entry-request.ts` that fails if it can reach either module, with a positive control asserting
the same walk does find them from the barrel. A grep would not have caught a module three
imports deep, which is the version of this mistake worth catching.

## Decided, and narrowed: the 8 KB covers the document request path

The alternative to narrowing was one pool that every capability draws from, and the failure mode
of that is visible in the paragraph above this one: routing spent 231 bytes of a shared figure and
the next feature inherited the argument. So the claim is scoped, each entry states what it
covers, and a new capability gets its own entry and its own ceiling rather than a share of an
existing one. [`spec/kernel/budgets.md`](kernel/budgets.md) is the normative version.

This is the second time in this project a stated ceiling has been redrawn — the line count moved
from 2,500 to 2,900 when routing landed. The two are not the same move and the difference is the
whole argument: the line count moved its _number_ while covering the same thing, which is what
makes it a label. This one keeps every number where it is and says which one covers what. If the
distinction turns out to be a rationalisation, the tell will be a third redrawing, and it should
be treated as one.

One byte saving was available and deliberately not taken. `schedule()` reaches the request path
transitively through `dispatch()`, and the waves could be precomputed when a plan is lowered. The
design says the plan is data specifically so `SchedulerPort` can reorder slots at runtime to fill
the pipe fastest-first, so freezing the waves at build time gives up a declared capability. It is
the one candidate where bytes cost a design property, and it is not being given up by accident.

## Four defects, found by looking rather than by a test failing

None of these broke a test. Each one was a statement the code made that was not true.

### `deferred` declared `kind: 'pool'`

It is a fresh macrotask on the request thread. It said `kind: 'pool'` and `preemptible: true`, so
a reader had two reasons to believe it enforced a CPU budget against a synchronous loop, which it
cannot. It only became a lie when a **real** pool existed to be confused with.

`preemptible` was a boolean and a boolean could not tell the truth here. There are three
behaviours: `never` (same task, no yield), `at-await` (yields, so an abort lands at an await, but a
synchronous render still finishes), `always` (a separate crash domain that can be stopped
mid-instruction). The breach message now says which one happened, because a breach message that
does not say whether the work was stopped reads like a limit was enforced.

### A CPU budget on `deferred` warned about nothing

`checkBudget` warned when `spec.executor === 'inline'` — the literal string. A slot on `deferred`
got a budget, no warning, and a render that ran to completion anyway. The condition was never
about the name: it is about whether the target is a separate crash domain, which is derivable
from the target itself (`isolate`, `pool:`, `binding:`, `svc:`). `W_CPU_BUDGET_INLINE` is
`W_CPU_BUDGET_ADVISORY` now, and it names the executor it fired for.

**A check written against one example of a condition tests the example.**

### Base renders and memoized deltas never expired

Both were stored with no `ttlMs`, so on a shared store every distinct value set ever rendered
accumulates forever. It looked harmless because `memoryStore` is byte-bounded and evicts — the
only store there was.

A TTL here is safe in a way a TTL on a cache entry is not: an expired base costs a **form**, never
correctness. The client names a base the server cannot recover, `selectForm` falls to `html`, and
the page is right. Fifteen minutes by default, and the only thing a shorter one costs is delta hit
rate.

### A channel buffered without limit for a peer that stopped reading

`res.write()` returns false when the socket buffer is over its watermark. Every sink ignored it.
A slow consumer therefore looked exactly like a fast one, until the process was holding frames it
could not reclaim — every one of them stale by the time it would have arrived.

Sinks report `saturated` now, and a channel that stays saturated for 32 consecutive sends is
closed with `E_SLOW_CONSUMER`. **A channel is not a queue.** Closing is the honest answer and the
client reconnects and says what it holds, which is the one thing this architecture is good at.

## The line-count gate, re-derived a third time, with a commitment attached

It fired on the backpressure fix. Investigating: **30% of what it was counting was
documentation.** A detector meant to catch the kernel absorbing port-shaped work, firing because
somebody explained the work.

That is the third time this check has needed re-deriving and the third time it was measuring
something other than what it claims to. First the wrong file set — every file in `src/`, which is
the gross-versus-marginal mistake the byte budget had already fixed. Then, twice, the wrong lines.

It counts code lines now, per entry, and the ceilings are re-derived on that basis. The honest
position is that the byte budget is the gate and this is a weak heuristic that has cost more
attention than it has earned; it survives only because a kernel that doubles in code with no byte
change is still worth being told about. **If it needs a fourth re-derivation it should be deleted
rather than fixed.** That is a commitment with a falsifiable consequence, which is the only kind
worth writing down.

The request path is 8,169 B against 8,192 after all four fixes — **23 bytes.** The next thing that
wants to be in it has a very short argument to make.

## Measured at last: shared deltas against per-connection diffing

Phase 6 exists to make one claim — that keeping render state on the client lets one delta
computation serve every client making the same transition, where LiveView's architecture cannot
share one at all. The mechanism had been built and tested for two sessions and the comparison
had never been run.

1,000 clients, the 50-row feed, 6 rows changed:

| Arrival                     | Strategy       | Diffs | Store reads | ms   |
| --------------------------- | -------------- | ----- | ----------- | ---- |
| all on one base render      | per-connection | 1,000 | 0           | 8.2  |
| all on one base render      | shared         | **1** | 1,001       | 0.3  |
| each on its own base render | per-connection | 1,000 | 0           | 9.2  |
| each on its own base render | shared         | 1,000 | 2,000       | 17.3 |

The second block is the finding. **When clients hold different bases there is nothing to share**,
and the shared path does the same N diffs _plus_ a store read and a write for each — 17.3 ms
against 9.2, so measurably worse. The win is proportional to how many clients share a base, and
the shape it is for is a broadcast. A benchmark that reported only the first block would be
advocacy, and this one reports both because the second one is where a deployment gets surprised.

On what is and is not being compared: both figures come from the same differ over the same
templates and the same transition, so the only variable is where the previous state lives. That
is the architectural difference and it is the whole of what is measured. Phoenix is not running
here — the per-connection number is a real per-connection differ in this harness, not a model of
one, but no constant factor of a LiveView deployment is measured or claimed. Elixir on the
machine would be a different and better test, and until it runs the claim stays structural.

## Incremental recompute, and the two lines it is drawn at

The design's three memoisation levels are all real now. Two of the decisions are worth
recording because both are places where the obvious version loses.

**Only nested templates are memoised.** A text hole is one escape scan and one encode; hashing
its value to look it up costs more than rendering it. Memoising everything would have been
easier to describe and slower to run.

**The memo is process-local, and that is forced rather than chosen.** `render` is synchronous —
it writes into a caller-owned buffer and returns a byte count — so a memo it consults has to
answer synchronously, which rules out a shared tier. Sharing row bytes across isolates would
mean making rendering async, and that cost lands on every render to benefit the ones that hit.
So the content-addressed sharing that works so well one level up, for whole deltas, stops at the
isolate boundary one level down. Same argument, different answer, because of a property of the
renderer rather than of the idea.

The gate is byte identity, in `weft-bench verify` alongside the wire-form checks: every scenario
rendered both ways, cold memo and warm, refusing to publish numbers if one byte differs. A
faster render that produces different bytes is a correctness bug with a performance
justification, which is the worst kind to ship.

## Found by the first intent over a socket: ACK was pointing the wrong way

`ACK` was declared at `0x06`, in the up range, and used for the result of an intent — which
travels from the server to the client. The decoder rejected the server's own answer as
`E_WRONG_DIRECTION`. The direction had been decided by where the name sat in the table, next to
`INTENT`, rather than by which way the bytes go.

The part worth recording is that **there was already a gate for this and it passed.**
`codec.test.ts` asserts that every frame's declared direction agrees with its code range, and
`0x06` with `dir: 'up'` agreed perfectly. The gate was checking the table against itself. The
code and the direction agreed with each other and neither of them agreed with what the frame
was for, and no static check can close that gap — only using it can.

So what was added is not a better version of the same gate. It is the one thing a table can
still be checked for: `RETIRED` records `0x06`, and a test refuses to let any future frame take
the code. A code reused for a second purpose is the version mistake a length prefix cannot
protect a reader from, because the frame parses cleanly and means something else.

Warp 1.2.0. `ACK` keeps its name — the design pairs it with `INTENT` — and moves to `0x22`.

## Hidden for an afternoon by a test harness that swallowed the error

The reason the wrong-direction frame took as long as it did to find: the test harness read the
down stream in an async IIFE ending in `.catch(() => {})`. When the decoder threw on the second
frame the reader died silently, and every assertion after that timed out waiting for frames.

**A reader that died on frame two looks exactly like a server that never sent frame two.** The
harness now keeps the failure and `settle()` reports it instead of timing out, so the next
version of this reads `the reader died waiting for an ACK: E_WRONG_DIRECTION` rather than
`timed out`.

Two bugs in one afternoon were made harder to see by error handling that was too broad, in
different files. Both were written to keep a shutdown path quiet.

## Caught by a test asserting a second connection: an intent's invalidation reached nobody

An intent invalidates through its own declared-write guard, which calls `StorePort.invalidate`
directly. So by the time the channel saw the outcome the store was already cold — and the
`StaleRegistry` had never been consulted, so no connection was told.

Push invalidation worked, and it worked only for invalidations that came through
`hub.invalidate`. Every invalidation that came from a _mutation_ — which is the only place
invalidations actually come from — notified nobody. The hub has a `notify(keys, reason)` path
now, and the connection that ran the intent is deliberately excluded: it is about to be handed
the new values rather than a note about the old ones.

Found by a test with two connections in it. A test with one connection would have passed
forever, because the one connection got its delta.

## Paid for, honestly: intents

| Entry                 | Before  | After   | Ceiling  |
| --------------------- | ------- | ------- | -------- |
| Document request path | 7,999 B | 8,040 B | 8,192 B  |
| Plus intent dispatch  | —       | 9,147 B | 10,240 B |

41 bytes in the request path, for the delegation that answers a non-GET with a 405 and an
`Allow` header rather than routing it to a document. Those are not optional: a kernel that
serves a page in answer to a POST is a kernel where a write can look like it succeeded. The
dispatch itself is 1.1 KB in an entry a read-only deployment never imports.

`entry-transport.ts` briefly went over its ceiling because `channel.ts` imported `ackFrame` from
the intent module and dragged the HTTP form path in behind it. `ackFrame` moved to `channel.ts`,
where framing belongs, and the channel now takes `IntentDispatch` as a type it never imports at
runtime. The byte gate found a layering mistake, which is the second time this session it has
done that rather than merely reported a number.

## Caught by the first client that actually negotiated: the server advertised an IR it stopped emitting

`SERVER_DEFAULTS.ir` in `@weft/warp` said `1.0.0`. The emitter has been on `2.4.0` since IR
2.0.0 landed. So `negotiate` saw an IR **major** mismatch on every current client and returned
`forms: ['html']` — markup only, no delta, no patch. Phase 6's entire mechanism was
unreachable through the default negotiation.

It surfaced the first time a real client asked for a delta over a socket and got markup.

Two things made it survive. Every negotiation test supplied matching versions on both sides, so
the mismatch branch was only ever exercised deliberately — and one test exercised it _with the
current IR major_, asserting the html-only downgrade as correct behaviour under the name "an IR
major mismatch". The test was enforcing the bug. And the repeat-visit benchmark negotiated
`ir: '2.1.0'` against the same default, so its `WARP` frame had been advertising `html` while
the page applied deltas anyway.

The fix is not a corrected constant. `@weft/warp` owns the Warp version and the template IR is
versioned separately, on purpose — so a default in that package could only ever state an IR
version it cannot see. `negotiate`'s second argument is now required, `SERVER_DEFAULTS` is
gone, and the composition lives in the one place that can see both versions:
`serverCapabilities()` in the kernel, deriving from `TEMPLATE_IR_VERSION`. A gate asserts it
equals the emitter's version, and the test that used to assert the bug now asserts a current
client keeps every form.

**A default in a module that cannot see the answer is a wrong answer waiting for a reader.**

## Found by exporting one more function: the 8 KB never included the route matcher

`createRouter` was not exported from `entry-request.ts`, so it was not in the bundle the
document request path was measured as. Every figure quoted for the kernel — 7,602, 7,833,
7,360 — described a kernel whose `serve()` throws `E_NO_ROUTES`.

Adding it costs 639 bytes brotli. The path is 7,999 against 8,192, so the design's claim still
holds, on 193 bytes of headroom rather than 832.

Worth being precise about what happened here. The 473 bytes recovered earlier in the same
session were real, and they were immediately spent by an accounting correction that had been
outstanding longer. The net of the session on this figure is +166 bytes and a number that
describes something deployable.

## The line-count ceiling should not have moved

It went 2,500 to 2,900 last session when routing landed, recorded at the time as something to
be uncomfortable about. The discomfort was right and the diagnosis was wrong: it was summing
every file in `src/`, which is the same gross-versus-marginal mistake the byte budget had
already made and already fixed one section above. Measured against the request path it is
meant to describe, routing never took it near 2,500 — the request path is 2,285 lines.

So it is back at 2,500, each entry has its own ceiling by the same reachability walk the byte
budget uses, and a companion gate asserts every source file is reachable from some entry or
named as off the request path. A module no ceiling applies to is invisible to both gates.

**A gate that fires and then moves is worth re-deriving before it is renegotiated.** Twice now
the answer has been that the gate was measuring the wrong set.

## Paid for, honestly: the channel

| Entry                                 | brotli   | Ceiling  |
| ------------------------------------- | -------- | -------- |
| Document request path                 | 7,999 B  | 8,192 B  |
| Plus surgical refresh and epochs      | 10,221 B | 12,288 B |
| Plus a live channel                   | 12,343 B | 13,312 B |
| Client: app route plus a frame router | 3,626 B  | 4,096 B  |

Charged to `entry-channel.ts` the channel came out 53 bytes over a ceiling that was set before
it existed. Raising that ceiling was available and was not taken: the rule written earlier the
same session says a new capability gets its own entry, and there is a real deployment behind
the split — surgical refresh over plain request/response, with no long-lived connection, is
how every phase 6 test worked before a channel existed.

The new ceilings are watermarks and say so. Two of them state how much room is left and what
it is for, because a ceiling picked to fit what was just built is a label unless the next thing
has to argue with it.

## Found by writing the routing tests: a private entry could reach a shared tier

`tieredStore.set` wrote every entry to every tier. `EntryMeta.class` recorded that an entry was
private and nothing acted on it, so an L1 hit keyed by identity would also be written to
whatever external store sat behind it.

The fix needed a field that did not exist. `consistency` and `coherence` both describe _when_ a
tier is right, and neither says _who can read it_ — so `StorePort.scope` is now `'process' |
'shared'`, and a tiered store writes a private entry only to process-local tiers. The filter is
on the write rather than the read, because an entry that never left cannot be served to the
wrong person.

Two things about how this surfaced. It was found by a test asserting a cache **hit**, not by one
looking for a leak: the expectation said one slot would hit and both did, because
`.cache('private')` is still a policy. And the field it needed was missing rather than
misapplied — the design put consistency and coherence in the port interface for exactly this
reason, and stopped one question short.

## Paid for, honestly: client epochs

254 bytes brotli. The client runtime went 2,742 → 2,996 B against a 6,144 B ceiling, for
staged epochs, atomic multi-slot commit, discard-as-rollback, and a View Transition wrapper
where the engine has one.

## Two claims the design makes that cannot be tested yet

**Effect-tracked rendering.** _Largely answered since this page was written._ The compiler
infers the design's full read surface, derives the cache class, `Vary`, key components and flag
axes from it, and refuses an untracked ambient read with a hard error — see
[effects and the ban](compiler/effects.md). Route contagion isolates a private child rather
than tainting its route. The kernel resolves those reads into an actual key at request time
(`spec/kernel/cache.md`), and the plan layer contradicts a declaration that disagrees with the
derivation (`spec/plan/plan.md`). What is still missing is `EffectSet.writes`, which needs
intents, and the L0 build-time resolution of a fragment that reads nothing.

**Warp as one channel for five jobs.** Two paths now run end to end, and neither over a live
connection. A document carries `WARP`, `SHELL` and `TPL` as binary frames, decoded in the
browser by the codec that encoded them. `HELD`/`REFRESH` produce a memoized `DELTA` and
`STALE` is pushed for the keys an invalidation dropped — but only as frames in a test, because
there is no transport binding. Navigation, mutation, the socket binding and `RESUME` remain
specified and untried.

## What the harness refuses to do, and why that mattered

Every number above survived gates that were built before the numbers were: a run aborts if
any wire form disagrees byte for byte, refuses a comparison whose p50 ± MAD overlap, never
aggregates engines, labels `webkit` a proxy for iOS rather than an iOS result, and reports
"not measured" with a reason instead of a zero. Three of the findings on this page — the
`data` form, the elision reversal, the delta correction — exist because a gate contradicted
something already written down.
