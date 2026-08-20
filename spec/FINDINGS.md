# What measurement did to the design

The three documents in [`docs/`](../docs) are the design as written, in August 2026, before
any of it had been built. This is the record of what happened when it was, claim by claim.
Four things the design says are now wrong, and they are wrong in ways worth reading rather
than quietly editing away.

Nothing here is a hypothetical. Every number comes from
`node packages/bench/src/cli.ts`, on an Apple M4, and every one of them is reproducible by
the command the report prints.

| The design says                                                 | Verdict                                |
| --------------------------------------------------------------- | -------------------------------------- |
| TTFB against a tuned React Router 7 app is the phase-zero gate  | **Reversed** — worth 1.2 ms            |
| Six negotiable wire forms, including `data`                     | **Cut to five**                        |
| Escape elision is a throughput lever                            | **Reversed** — worth nothing           |
| Incremental declarative shadow DOM is the largest platform risk | **Did not materialise**, and sharpened |
| Streaming beats a blocking response                             | **Confirmed** — 2.19×                  |
| Pre-encoded segments beat string concatenation                  | **Confirmed** — 1.4× to 2×             |
| The `delta` form is the smallest possible payload               | **Confirmed** — 3.2× after brotli      |
| A returning visitor does zero wiring construction               | **Confirmed, with a correction**       |
| The client runtime fits in 4–6 KB                               | **Confirmed** for what exists          |
| Isolated DOM updates will tie                                   | **Consistent** — 0.29–1.7 µs           |
| Warp unifies five jobs on one channel                           | **One path exercised** of five         |

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

## Two claims the design makes that cannot be tested yet

**Effect-tracked rendering.** _Partly answered since this page was written._ The compiler
now infers the design's full read surface, derives the cache class, `Vary`, key components
and flag axes from it, and refuses an untracked ambient read with a hard error — see
[effects and the ban](compiler/effects.md). What is still missing is everything downstream:
no route contagion, no cache-policy declaration for `requiresTtl` to contradict, no writes,
and no runtime that resolves a read's _value_ into an actual key.

**Warp as one channel for five jobs.** One path runs end to end: a document carrying `WARP`,
`SHELL` and `TPL` as binary frames, decoded in the browser by the codec that encoded them.
Navigation, mutation, refresh and invalidation remain specified and untried, along with the
socket binding, `RESUME`, and epochs.

## What the harness refuses to do, and why that mattered

Every number above survived gates that were built before the numbers were: a run aborts if
any wire form disagrees byte for byte, refuses a comparison whose p50 ± MAD overlap, never
aggregates engines, labels `webkit` a proxy for iOS rather than an iOS result, and reports
"not measured" with a reason instead of a zero. Three of the findings on this page — the
`data` form, the elision reversal, the delta correction — exist because a gate contradicted
something already written down.
