# Weft — phase zero

A design for a TypeScript fullstack framework whose bet is on the **delivery** layer:
the wire form of a piece of UI is negotiated per request over a set of encodings the
compiler has proven equivalent, instead of being frozen at build time.

The design is in `docs/` — [the architecture proposal](docs/weft-and-warp.html), [the API
sketch](docs/weft-by-example.html), and [the research dossier](docs/field-notes.html).

**No framework exists yet, on purpose.** Phase zero is the benchmark harness and the two
versioned formats everything else depends on, because the speed claim is unfalsifiable
without a harness and a wire format cannot be versioned retroactively.

| What | Where | Status |
| --- | --- | --- |
| Template IR, `weft.template-ir/1` | [`spec/ir/template-ir-1.md`](spec/ir/template-ir-1.md), `packages/ir` | 1.0.0, sealed and validated |
| Warp frames, `weft.warp/1` | [`spec/warp/warp-1.md`](spec/warp/warp-1.md), `packages/warp` | 1.0.0, both framings, negotiation |
| Versioning contract | [`spec/VERSIONING.md`](spec/VERSIONING.md) | Majors refuse, minors round-trip |
| Device and engine reality | [`spec/baseline/devices.md`](spec/baseline/devices.md) | Written before the numbers |
| Benchmark harness | `packages/bench` | Three axes measured, three await a client runtime |
| Template compiler | — | Not started. The IR is hand-built in the workloads |

## Running it

No install, no build step — Node 22.18+ strips the types.

```sh
node packages/bench/src/cli.ts list                       # axes, scenarios, candidates
node packages/bench/src/cli.ts verify                      # every wire form must agree
node packages/bench/src/cli.ts run                         # measure and write a report
node packages/bench/src/cli.ts run --transport buffered     # the intercepted-webview path
node packages/bench/src/cli.ts ir cart                      # the sealed, versioned IR
node --test packages/*/test/*.test.ts                       # 51 conformance tests
```

`run` writes a markdown report and the raw JSON to `results/`. Third-party candidates
are configured, never vendored: `--external candidates.json` spawns another framework's
app and measures it over HTTP on the same axes.

## What the harness refuses to do

The point of building this first is to make it hard to fool ourselves later.

- **It aborts if the wire forms disagree.** Before any measurement, every form of every
  scenario must produce byte-identical output: `html` against the string-concatenation
  control, `data` projected through a resident template, and `delta` applied to its base.
  A mismatch reports the first differing byte and stops the run.
- **It refuses claims below the noise floor.** Two runs whose p50 ± MAD overlap are
  reported as "not separable at this sample size — no claim".
- **It never aggregates engines.** A single-engine run says so, and `webkit` is labelled
  as a proxy for iOS webviews rather than reported as an iOS number.
- **It says "not measured" with a reason** instead of reporting a zero. Every axis that
  needs a client runtime currently says exactly why it is empty.
- **It states each axis's expectation up front**, including the one where the honest
  answer is a tie: isolated DOM updates are at the floor already and this design should
  match them, not beat them.

## Where it stands, on one machine

Apple M4, Node 24.18, loopback, 300 samples. Reproduce with the command the report
prints; these are one machine's numbers and not a published claim.

**Server render throughput** — pre-encoded segments against string concatenation:

| Scenario | Segments | Control | |
| --- | --- | --- | --- |
| shell, 701 B | 1,415,732 renders/s | 636,972 | 2.22× |
| cart, 12 rows | 251,318 | 169,328 | 1.48× |
| feed, 50 rows | 65,552 | 43,113 | 1.52× |

**Bytes per server-driven update** — one row's quantity and price change:

| Scenario | Form | Raw | Brotli |
| --- | --- | --- | --- |
| feed | `html` | 6,283 | 601 |
| feed | `data` | 3,100 | 600 |
| feed | `delta` | 371 | 186 |

The uncomfortable finding is in that last table, and it is the kind of thing phase zero
exists to surface: **the `data` form's byte win does not survive compression.** Raw it is
half the size of `html`; after brotli it is 600 bytes against 601, because compression
already removes the template redundancy that `data` removes semantically. Only `delta`
wins on the wire that actually ships — 186 bytes against 601, 3.2×. So `data`'s case has
to rest on the client-side work it avoids, not on payload size, and that is a claim the
current harness cannot yet measure.

**Shell TTFB** is not yet a meaningful comparison. Over loopback with a warm cache both
candidates land under 0.1 ms and are usually not separable; the only scenario with a
resolvable difference is the 50-row feed, at 1.42×. Testing the real claim needs a slow
data source behind a hole and a network with latency in it.

## What has to be true next

In the order the design says to disprove things:

1. A template-to-IR compiler, so the IR is emitted rather than hand-written.
2. A route with a slow hole and simulated network latency, which is where the
   precomputed-shell claim is either true or it is not.
3. A tuned React Router 7 app as an external candidate. Until then the control is a
   string-concatenation renderer, which is the right *shape* of comparison but not a
   framework anyone ships.
4. Incremental declarative-shadow-DOM parsing tested on real iOS, Android WebView, and
   WebKitGTK. If the engines diverge the filler script becomes the primary path, which
   is survivable and changes what can be claimed.
