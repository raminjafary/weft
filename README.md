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
| Template IR, `weft.template-ir/2` | [`spec/ir/template-ir-2.md`](spec/ir/template-ir-2.md), `packages/ir` | 2.0.0 — one form fewer than major 1 |
| Warp frames, `weft.warp/1` | [`spec/warp/warp-1.md`](spec/warp/warp-1.md), `packages/warp` | 1.0.0, and now exercised end to end |
| Versioning contract | [`spec/VERSIONING.md`](spec/VERSIONING.md) | Majors refuse, minors round-trip |
| Device and engine reality | [`spec/baseline/devices.md`](spec/baseline/devices.md) | Written before the numbers |
| Template compiler | [`spec/compiler/supported-subset.md`](spec/compiler/supported-subset.md), `packages/compiler` | TSX to IR, on Oxc, with type-driven escape elision |
| Client runtime | [`spec/client/adoption.md`](spec/client/adoption.md), `packages/client` | Adoption, signals, surgical deltas, resident templates over Warp |
| Benchmark harness | `packages/bench` | All six axes measured |
| React Router 7 candidate | [`benchmarks/rr7`](benchmarks/rr7) | The phase-zero gate, tuned and default shapes |

## Running it

No build step — Node 22.18+ strips the types. One install, for the compiler's parser.

```sh
pnpm install                                                # Oxc, for the compiler only

node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
node packages/compiler/src/cli.ts fixtures/*.tsx --no-types   # syntax-only elision
node packages/bench/src/cli.ts list                         # axes, scenarios, candidates
node packages/bench/src/cli.ts verify                       # every wire form must agree
node packages/bench/src/cli.ts client                      # adopt and patch, in three engines
node packages/bench/src/cli.ts run                          # measure and write a report
node packages/bench/src/cli.ts run --transport buffered      # the intercepted-webview path
node packages/bench/src/cli.ts run --axes shell-ttfb --scenarios slow-feed \
  --latency 40 --external benchmarks/rr7/candidates.json    # the gate, against RR7
node packages/bench/src/cli.ts ir cart                       # the compiled, sealed IR
npm run typecheck                                            # TypeScript 7, clean
node --test packages/*/test/*.test.ts                        # 95 conformance tests
node packages/bench/src/cli.ts run --axes client-work         # what each form costs a client
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
  control, `data` projected through a resident template, `delta` applied to its base, and
  every candidate's response *as served over HTTP* — because a streaming server assembles
  its response separately from the in-process renderer, and byte equality in memory does
  not imply byte equality on the wire. A mismatch reports the first differing byte and
  stops the run.
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
| feed | `delta` | 371 | 187 |

## A form was cut

The `data` form — values only, projected through a template the client already holds —
was the most distinctive thing in the negotiated set. It is gone, and the harness is why.

| Evidence | Result |
| --- | --- |
| Bytes, raw | 3,100 against `html`'s 6,289 — a 2× win |
| Bytes, brotli | 599 against 605. **1%.** Compression already removes the template redundancy that `data` removed semantically |
| Client work, Chromium | 1.16× *more* than `html` |
| Client work, Firefox | 1.33× more |
| Client work, WebKit | 1.07× more |

Values have to be parsed and projected before anything can reach the HTML parser, and the
parser is native code — which is the same observation the design already makes about why
server-rendered DOM beats client-constructed DOM. It applies to our own form too.

The decisive argument is architectural rather than numeric, though. **A `data` refresh
into a resident template is a `delta` that has declined to diff.** There is no regime
where it is the best form available: a full-region refresh is cheaper as `html`, and a
partial one is cheaper as `delta`. So it went, as IR 2.0.0 — a form leaving the vocabulary
is a wire break, and the versioning contract says a major refuses rather than migrates.

`delta` stays: 16.9× smaller raw, 3.2× after brotli, and nothing else in the field offers
it without a stateful process per connection. With one honest caveat — its measured client
cost is a full re-projection, because only signal-wired bindings carry addressing today.
Applying a delta *surgically* needs anchors on holes, which is
[a known gap](spec/ir/template-ir-2.md) left deliberately open until a client runtime
exists to consume it.

## The client runtime, and a reversed finding

The two axes the design calls *"the largest gap"* — interactivity and repeat-visit
startup — needed a runtime before they could be measured at all. There is now enough of
one to answer them: adoption walks the DOM the parser built and records where each value
lives, with no component code executing. 50-row region, ~200 bindings, p50:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Adopt the region | 0.047 ms | 0.095 ms | 0.040 ms |
| Parse the same markup | 0.076 ms | 0.060 ms | 0.140 ms |
| Apply a 12-path delta surgically | 0.0017 ms | 0.0029 ms | 0.0015 ms |
| One signal write to one node | 0.29 µs | 1.7 µs | 0.71 µs |

**This reverses an earlier finding.** When the harness had no runtime it measured the
`delta` form by re-projecting the whole region, and reported it 1.28× *worse* than
sending markup. Applied as designed — one write per changed value, into DOM that already
exists — it is **20–93× cheaper** than the parse it replaces. The form was never the
problem; the measurement was, and it was measuring a client that could not address its
own holes. Fixing that took `anchor` onto holes rather than only onto wiring entries
(IR 2.1.0), which is exactly the gap the previous commit recorded and deferred.

Adoption costing roughly what a parse costs is the honest version of "startup is cheap":
cheap because it is proportional to bindings rather than components, not free.

The conformance suite earned its place immediately. It caught that one value can occupy
several holes — a quantity is an input's value, an output's text, and a button's disabled
flag — and the first implementation wrote only to the last of the three. It also caught a
benchmark measuring an empty loop, because the template under test wired nothing at all
and `set()` was updating a number and touching no DOM.

## Repeat visits, and Warp's first real run

The second of the two "largest gap" claims: a returning visitor should do no wiring
construction, because a wiring table is content-addressed and can simply be kept. Testing
it meant making the resident set real — templates persisted in IndexedDB, advertised to the
server as a coarse digest, and delivered as `TPL` frames only when the client does not
already hold them. That is also the first time Warp has run end to end rather than in its
own tests.

| Boot path, p50 | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| First visit | 2.50 ms | 6.00 ms | 3.00 ms |
| Repeat visit | 0.70 ms | 3.00 ms | 1.00 ms |
| Protocol bytes | 1,124 → 132 | same | same |
| `TPL` frames sent | 2 → 0 | same | same |

**One correction to the claim.** "Zero wiring construction" is true, and it is not the same
as zero startup work. A repeat visit skips receiving, parsing and storing templates. It
still pays **adoption**, because the DOM in front of it is new every time and the bindings
have to be found again. Only the table adoption builds *from* is cached, never the walk
itself.

Storage is IndexedDB rather than a service worker, because WKWebView gates service workers
behind app-bound domains — the traffic where a repeat-visit gain matters most is the
traffic that does not have them. Where IndexedDB is missing too, the store degrades to
memory and every visit is a first visit; the reported figure carries its storage tier.

## A correction

An earlier version of this file claimed that syntax-only escape elision cost 5–12% of the
throughput win, and that feeding types into the compiler would recover it. The compiler
now has type information — it asks the TypeScript checker, so `{total}` is `proven-safe`
when `total` is a number and escaped when it is a string — and the recovery **did not
happen**. Measured directly, on the same templates with elision on and off:

| | ns per render |
| --- | --- |
| Typed, 4 holes elided | 16,780 |
| Syntax-only, 0 elided | 16,503 |

Elision is worth nothing here, and the reason is that the renderer already elides at
runtime: it scans a value before escaping it and writes it untouched when the scan finds
nothing, which for `"8715"` is a few nanoseconds. The compile-time proof saves the scan
and the scan was never the cost.

The real 7.9% was the **marker comments**. The compiler emits `<!>` before a dynamic text
run so the text node is addressable, and the hand-written IR it replaced had none. That is
a genuine cost for a genuine capability, and mis-attributing it to escaping was a guess
dressed as a finding.

The type oracle stays, on a smaller and honest justification: it makes the IR's escape
class *true* rather than conservative. A JavaScript renderer can afford to scan; a native
codec crossing a WASM boundary per hole, or a client projecting values into a resident
template, cannot. An escape class that says "escape" about a number is a lie the format
should not carry, whatever this particular renderer does with it.

## The phase-zero gate, and its answer

The design says: *if the pre-encoded-buffer shell does not beat a tuned React Router 7
app on TTFB in a reproducible test, the central premise is wrong and better to know in
week two.* That test now exists — a route whose data takes 40 ms, 40 ms of injected RTT,
and [a real RR7 app](benchmarks/rr7) in two configurations.

| Candidate | TTFB p50 | Last byte | Bytes |
| --- | --- | --- | --- |
| Weft segments | 43.46 ms | 84.67 ms | 6,289 |
| String-concat SSR, streaming | 43.48 ms | 84.84 ms | 6,289 |
| **RR7, tuned** — promise loader, Suspense, `onShellReady` | **44.65 ms** | 90.78 ms | 7,687 |
| Await the loader, then render | 84.75 ms | 84.78 ms | 6,289 |
| **RR7, default shape** — awaited loader, `onAllReady` | **95.35 ms** | 95.40 ms | 6,370 |

**The premise survives, but the framing does not.** Against a *tuned* RR7 app the shell is
1.03× faster to first byte — a 1.2 ms difference on a 43 ms number. Strip the network out
and the same comparison is 3.46× (0.64 ms against 2.21 ms), which is a real difference in
server work and an irrelevant one to a user: any actual RTT swamps it. TTFB against a
competent competitor is not the differentiator, and a design marketed on it would be
marketing 1.2 ms.

What the test does establish is worth more than the claim it replaces:

- **Streaming is the whole game, and it is architectural.** The two blocking candidates
  pay their query before their first byte — 1.95× and 2.19× worse — and no renderer
  improvement recovers that. Weft cannot be configured into that failure, because a
  fragment that reads something slow is a hole by construction. RR7 can, and its default
  shape is the slow one.
- **Weft's edge over the tuned app is on the axes nobody markets**: 6.7% faster to last
  byte and 18% fewer bytes for the same content, because React ships Suspense markers and
  comment nodes that pre-encoded segments do not need.
- **The renderer mechanism is invisible here.** Segments and string concatenation are not
  separable on this axis at all. The 1.4–1.96× throughput difference is real and it lives
  in server capacity, not in latency.

## What has to be true next

In the order the design says to disprove things:

1. Type information in the compiler, to recover the escape elision a syntax-only pass
   has to give up.
2. Anchors on holes, so a delta can be applied surgically rather than by re-projecting the
   region — but only alongside the client runtime that would read them.
3. A bandwidth and loss model in the latency proxy. It delays packets and nothing else,
   so it understates what a slow link does to an 18% byte difference — which is now one
   of the few measured advantages, so it deserves a better instrument.
4. Incremental declarative-shadow-DOM parsing tested on real iOS, Android WebView, and
   WebKitGTK. If the engines diverge the filler script becomes the primary path, which
   is survivable and changes what can be claimed.
5. Component composition in the compiler. Today `<Widget/>` is a refusal, and a fragment
   is a whole template.
