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
| Template IR, `weft.template-ir/1` | [`spec/ir/template-ir-1.md`](spec/ir/template-ir-1.md), `packages/ir` | 1.1.0, sealed and validated |
| Warp frames, `weft.warp/1` | [`spec/warp/warp-1.md`](spec/warp/warp-1.md), `packages/warp` | 1.0.0, both framings, negotiation |
| Versioning contract | [`spec/VERSIONING.md`](spec/VERSIONING.md) | Majors refuse, minors round-trip |
| Device and engine reality | [`spec/baseline/devices.md`](spec/baseline/devices.md) | Written before the numbers |
| Template compiler | [`spec/compiler/supported-subset.md`](spec/compiler/supported-subset.md), `packages/compiler` | TSX to IR, on Oxc. Refuses what it cannot lower |
| Benchmark harness | `packages/bench` | Three axes measured, three await a client runtime |

## Running it

No build step — Node 22.18+ strips the types. One install, for the compiler's parser.

```sh
pnpm install                                                # Oxc, for the compiler only

node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
node packages/bench/src/cli.ts list                         # axes, scenarios, candidates
node packages/bench/src/cli.ts verify                       # every wire form must agree
node packages/bench/src/cli.ts run                          # measure and write a report
node packages/bench/src/cli.ts run --transport buffered      # the intercepted-webview path
node packages/bench/src/cli.ts ir cart                       # the compiled, sealed IR
node --test packages/*/test/*.test.ts                        # 69 conformance tests
```

The benchmark compiles [its fixtures](packages/compiler/fixtures) in-process, so every
number is measured against emitted IR rather than an IR written by hand to flatter it.

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
| shell, 707 B | 1,165,022 renders/s | 594,914 | 1.96× |
| cart, 12 rows | 236,539 | 167,419 | 1.41× |
| feed, 50 rows | 62,492 | 43,807 | 1.43× |

Both candidates render the same compiled templates — one as byte segments, one as
JavaScript strings — so this compares the mechanism and nothing else.

**Bytes per server-driven update** — one row's quantity and price change:

| Scenario | Form | Raw | Brotli |
| --- | --- | --- | --- |
| feed | `html` | 6,289 | 605 |
| feed | `data` | 3,100 | 599 |
| feed | `delta` | 371 | 187 |

The uncomfortable finding is in that last table, and it is the kind of thing phase zero
exists to surface: **the `data` form's byte win does not survive compression.** Raw it is
half the size of `html`; after brotli it is 600 bytes against 601, because compression
already removes the template redundancy that `data` removes semantically. Only `delta`
wins on the wire that actually ships — 187 bytes against 605, 3.2×. So `data`'s case has
to rest on the client-side work it avoids, not on payload size, and that is a claim the
current harness cannot yet measure.

The second finding is the price of a syntax-only compiler. The hand-written IR this
replaced marked numeric holes `proven-safe`; the compiler cannot prove that about a prop
without type information, so it escapes by default and gives back 5–12% of the
throughput win. Escape elision is a type-checker feature, not a syntax feature — that is
the strongest argument for feeding `tsc`'s types into the pass.

**Shell TTFB** is not yet a meaningful comparison. Over loopback with a warm cache both
candidates land under 0.1 ms and are usually not separable; the only scenario with a
resolvable difference is the 50-row feed, at 1.62×. Testing the real claim needs a slow
data source behind a hole and a network with latency in it.

## What has to be true next

In the order the design says to disprove things:

1. A tuned React Router 7 app as an external candidate, plus a route with a slow hole and
   simulated network latency. That is the phase-zero gate: beat it on shell TTFB
   reproducibly, or the central premise is wrong. Until then the control is a
   string-concatenation renderer — the right *shape* of comparison, but not a framework
   anyone ships.
2. Type information in the compiler, to recover the escape elision a syntax-only pass
   has to give up.
3. Whether the `data` form survives the client-work measurement, or comes out of the
   negotiated set. Cutting a form is a win: one less column in the differential matrix
   forever.
4. Incremental declarative-shadow-DOM parsing tested on real iOS, Android WebView, and
   WebKitGTK. If the engines diverge the filler script becomes the primary path, which
   is survivable and changes what can be claimed.
5. Component composition in the compiler. Today `<Widget/>` is a refusal, and a fragment
   is a whole template.
