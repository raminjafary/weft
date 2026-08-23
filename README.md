# Weft — phase zero

A design for a TypeScript fullstack framework whose bet is on the **delivery** layer:
the wire form of a piece of UI is negotiated per request over a set of encodings the
compiler has proven equivalent, instead of being frozen at build time.

The design is in `docs/` — [the architecture proposal](docs/weft-and-warp.html), [the API
sketch](docs/weft-by-example.html), and [the research dossier](docs/field-notes.html). Those
are the design _as written_, before any of it was built; four of their claims have since been
falsified by building it, and [`spec/FINDINGS.md`](spec/FINDINGS.md) is the claim-by-claim
record of what measurement did to the design.

**No framework exists yet, on purpose.** Phase zero is the benchmark harness and the two
versioned formats everything else depends on, because the speed claim is unfalsifiable
without a harness and a wire format cannot be versioned retroactively.

| What                              | Where                                                                                         | Status                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Template IR, `weft.template-ir/2` | [`spec/ir/template-ir-2.md`](spec/ir/template-ir-2.md), `packages/ir`                         | 2.5.0 — children, instances in rows, derived values, contagion      |
| Warp frames, `weft.warp/1`        | [`spec/warp/warp-1.md`](spec/warp/warp-1.md), `packages/warp`                                 | 1.2.0 — `ACK` moved to the down range, where its bytes actually go  |
| Versioning contract               | [`spec/VERSIONING.md`](spec/VERSIONING.md)                                                    | Majors refuse, minors round-trip                                    |
| What measurement changed          | [`spec/FINDINGS.md`](spec/FINDINGS.md)                                                        | Five reversed, two clarified, one gate that fired on its first run  |
| Device and engine reality         | [`spec/baseline/devices.md`](spec/baseline/devices.md)                                        | Written before the numbers                                          |
| Template compiler                 | [`spec/compiler/supported-subset.md`](spec/compiler/supported-subset.md), `packages/compiler` | TSX to IR, on Oxc, type-driven escape elision, components any shape |
| Client runtime                    | [`spec/client/adoption.md`](spec/client/adoption.md), `packages/client`                       | Adoption, surgical deltas, resident templates over Warp             |
| Signal graph                      | [`spec/client/signals.md`](spec/client/signals.md), `packages/client`                         | Linked edges, bitflag status, push-pull with a lazy check           |
| Effect inference                  | [`spec/compiler/effects.md`](spec/compiler/effects.md), `packages/compiler`                   | Reads inferred, cache class derived, ambient reads banned           |
| Route streaming                   | [`spec/kernel/streaming.md`](spec/kernel/streaming.md), `packages/kernel`                     | Slots streamed in order or fastest-first                            |
| Routing                           | [`spec/kernel/routing.md`](spec/kernel/routing.md), `packages/kernel`, `packages/plan`        | A URL matches a plan; the plan lowers to a route; `serve()` runs it |
| Request lifecycle                 | [`spec/kernel/lifecycle.md`](spec/kernel/lifecycle.md), `packages/kernel`                     | A state machine, two-phase envelope, 103 Early Hints, deferral      |
| Ports                             | [`spec/kernel/ports.md`](spec/kernel/ports.md), `packages/kernel`, `packages/adapters`        | Thirteen declared, seven implemented, the rest refuse by name       |
| Runtime cache keys                | [`spec/kernel/cache.md`](spec/kernel/cache.md), `packages/kernel`                             | Reads resolved into a key; no setter exists anywhere                |
| Static documents, L0              | [`spec/kernel/static.md`](spec/kernel/static.md), `packages/weft`                             | A page that reads nothing is a file, proved by rendering it twice   |
| Executors, waves, epochs          | [`spec/kernel/locus.md`](spec/kernel/locus.md), `packages/kernel`, `packages/client`          | DAG scheduling, CPU budgets, staged epochs with atomic commit       |
| Stateless surgical updates        | [`spec/kernel/surgical.md`](spec/kernel/surgical.md), `packages/kernel`                       | `HELD` recovers a base, the delta is memoized by its transition     |
| The plan layer                    | [`spec/plan/plan.md`](spec/plan/plan.md), `packages/plan`                                     | Plan DSL, validation against inferred effects, plugins, `weft why`  |
| Benchmark harness                 | `packages/bench`                                                                              | All six axes measured                                               |
| What is not built yet             | [`ROADMAP.md`](ROADMAP.md)                                                                    | The runtime, a docs site with a playground, a demo of every feature |
| React Router 7 candidate          | [`benchmarks/rr7`](benchmarks/rr7)                                                            | The phase-zero gate, tuned and default shapes                       |

## Running it

```sh
pnpm install
pnpm build                                                  # ten packages, in dependency order

pnpm demo                                                   # five shapes of page      :4173
pnpm inspect                                                # every mechanism, running :4180
```

Both are weft applications. `demo/` depends on `weft` alone; `@weft/inspector` reaches into the
kernel, the plan layer and the adapters, because taking those apart is what it is for.

## Writing one

A folder is an application. The route table is the file tree, and the plan that places everything
on a page is generated from it — there is no wiring to write and no config file you have to have.

```
app/
  layout.tsx            the document. Its <slot> holes are what a route fills
  layouts/<name>.tsx    an alternate one, chosen with defineRoute({ layout })
  routes/index.tsx      /
  routes/[slug].tsx     /:slug
  routes/x.data.ts      x.tsx's head, cache policy, loader, guard and slots
  routes/x.css          linked only by the pages that render x
  fragments/<name>.tsx  a component, referenced by name from a route's slots
  slots/<name>.tsx      fills the layout hole of that name on every route
  intents/**.ts         mutations. The manifest is generated from this directory
  styles.css            linked on every page, after the framework's own
  lib/**                anything else your application imports. Not read by the framework
public/                 served as written, and again at a URL carrying its digest
weft.config.ts          what this deployment binds
```

```sh
npm create weft my-app

weft dev            # serve, and rebuild what changes
weft dev --devtools # the same, plus this application's routes, keys and bytes as pages
weft build          # sealed templates, the generated plan, the intent manifest, revved assets
weft start          # serve the build. No compiler runs
weft routes         # the route table, as the file tree produced it
weft why /          # the plan the framework generated for a route
```

A route declares placement and data and deliberately cannot declare a cache key: keys come from
what the compiler saw a fragment read, so `public` on a fragment that reads identity fails the
build with the read named. `weft build` writes the plan to `routes.json`, which is what makes a
generated one reviewable.

**A page that reads nothing is a file.** `weft build` renders every route through the real kernel
twice — under two requests differing in cookies, locale, device, headers, query, flags and a clock
ten years apart — and writes the ones whose bytes came out identical to `.weft/static/`, which is a
directory you can hand to a CDN. `weft start` answers those paths from the table before the kernel
is reached, with an ETag and a 304 on a conditional request. The build prints what it wrote and,
for every other page, the reason: a parameter, a read, a live region, a streaming slot. Both halves
of that decision are needed, because a route's loader lives in a `.data.ts` and nothing compiles
it — a page whose fragments read nothing and whose loader reads a cookie is classified static and
is not. See [`spec/kernel/static.md`](spec/kernel/static.md).

There is no bundler. Client modules are TypeScript with their types stripped by Node and two bare
specifiers rewritten, so what runs in the browser is the file on disk. Adoption, intents, the
channel, control wiring and the runtime's own readouts are reached through attributes —
`data-weft-control`, `data-weft-apply`, `data-weft-intent`, `data-weft-stat` — so an application
needs no client code at all, and the demo has none.

Every URL the browser fetches carries a digest of its contents and is immutable for a year. `weft
dev` serves the same bytes at stable names with `no-store`, because a stylesheet you just edited
served as immutable is a framework that lies to you for a year.

## The harness

No build step for the packages themselves — Node 22.18+ strips the types.

```sh
node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
node packages/compiler/src/cli.ts fixtures/*.tsx --no-types   # syntax-only elision
node packages/bench/src/cli.ts list                         # axes, scenarios, candidates
node packages/bench/src/cli.ts verify                       # every wire form must agree
node packages/bench/src/cli.ts client                      # adopt and patch, in three engines
node packages/bench/src/cli.ts budget                      # bundle each entry against its byte budget
node packages/bench/src/cli.ts slots                       # both stream orders, and the shadow-DOM probe
node packages/bench/src/cli.ts l0                          # a document served from the build against the same one rendered
node packages/bench/src/cli.ts nav --latency 100           # a staged click against the same click handed to the browser
node packages/bench/src/cli.ts run                          # measure and write a report
node packages/bench/src/cli.ts run --transport buffered      # the intercepted-webview path
node packages/bench/src/cli.ts run --axes shell-ttfb --scenarios slow-feed \
  --latency 40 --external benchmarks/rr7/candidates.json    # the gate, against RR7
node packages/bench/src/cli.ts ir cart                       # the compiled, sealed IR
npm run typecheck                                            # TypeScript 7, clean
node --test packages/*/test/*.test.ts demo/test/*.test.ts    # conformance tests
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
  every candidate's response _as served over HTTP_ — because a streaming server assembles
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

| Scenario      | Segments            | Control |       |
| ------------- | ------------------- | ------- | ----- |
| shell, 707 B  | 1,165,022 renders/s | 594,914 | 1.96× |
| cart, 12 rows | 236,539             | 167,419 | 1.41× |
| feed, 50 rows | 62,492              | 43,807  | 1.43× |

Both candidates render the same compiled templates — one as byte segments, one as
JavaScript strings — so this compares the mechanism and nothing else.

**Bytes per server-driven update** — one row's quantity and price change:

| Scenario | Form    | Raw   | Brotli |
| -------- | ------- | ----- | ------ |
| feed     | `html`  | 6,289 | 605    |
| feed     | `delta` | 371   | 187    |

## A form was cut

The `data` form — values only, projected through a template the client already holds —
was the most distinctive thing in the negotiated set. It is gone, and the harness is why.

| Evidence              | Result                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Bytes, raw            | 3,100 against `html`'s 6,289 — a 2× win                                                                       |
| Bytes, brotli         | 599 against 605. **1%.** Compression already removes the template redundancy that `data` removed semantically |
| Client work, Chromium | 1.16× _more_ than `html`                                                                                      |
| Client work, Firefox  | 1.33× more                                                                                                    |
| Client work, WebKit   | 1.07× more                                                                                                    |

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
Applying a delta _surgically_ needs anchors on holes, which is
[a known gap](spec/ir/template-ir-2.md) left deliberately open until a client runtime
exists to consume it.

## The client runtime, and a reversed finding

The two axes the design calls _"the largest gap"_ — interactivity and repeat-visit
startup — needed a runtime before they could be measured at all. There is now enough of
one to answer them: adoption walks the DOM the parser built and records where each value
lives, with no component code executing. 50-row region, ~200 bindings, p50:

|                                   | Chromium                                       | Firefox   | WebKit    |
| --------------------------------- | ---------------------------------------------- | --------- | --------- |
| Adopt the region                  | 0.047 ms                                       | 0.095 ms  | 0.040 ms  |
| Parse the same markup             | 0.076 ms                                       | 0.060 ms  | 0.140 ms  |
| Apply a 12-path delta surgically  | 0.0017 ms                                      | 0.0029 ms | 0.0015 ms |
| One signal write to one node      | 0.31 µs                                        | 1.7 µs    | 0.74 µs   |
| The same write through a computed | not separable from the row above in any engine |           |           |

**This reverses an earlier finding.** When the harness had no runtime it measured the
`delta` form by re-projecting the whole region, and reported it 1.28× _worse_ than
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

## Streaming, and the platform risk that did not materialise

Streaming is the largest advantage measured anywhere in this project — 2.19× to first byte
against RR7's default shape — and it now belongs to a route rather than to a benchmark
candidate. A slot is a hole the shell refuses to wait for, and a route can stream its slots
two ways. With the slow region first, at 80 ms against 20 ms:

|                           | Chromium  | Firefox   | WebKit    |
| ------------------------- | --------- | --------- | --------- |
| in-order, fast region     | 103 ms    | 104 ms    | 103 ms    |
| out-of-order, fast region | **22 ms** | **23 ms** | **22 ms** |

4.7× earlier, for 329 bytes of inline script, with identical final DOM in all three
engines.

**The design's largest platform risk does not materialise.** Incremental declarative
shadow DOM — attaching a shadow root while its host is still streaming — works in
Chromium, Firefox and WebKit alike: the root exists at 8–38 ms against a host that does not
close until 60 ms, and slotted content renders as it arrives. Zero-JavaScript hole filling
is real, not a hope.

**But it sharpens into something less convenient than hoped.** Zero-JavaScript filling and
out-of-order filling are mutually exclusive. Slot assignment works on the children of a
host that is _still open_, and keeping a host open until its content arrives is exactly
in-order streaming — which needs no fill mechanism at all. Out-of-order needs every host
closed, so content must arrive elsewhere and be moved, and moving a node is JavaScript. The
329 bytes are not a fallback for weaker engines; they are the price of fastest-first on
every engine.

## Byte budgets

The design states four ceilings and none had ever been measured. Bundled with Rolldown,
minified, compressed the way it would ship:

| Entry                                     | Raw    | gzip   | brotli     | Budget |
| ----------------------------------------- | ------ | ------ | ---------- | ------ |
| Client runtime, everything                | 13,378 | 5,130  | **4,680**  | 6,144  |
| Content route — adopt and bind            | 6,657  | 2,426  | **2,226**  | 5,120  |
| App route — adopt, bind, patch, epochs    | 9,031  | 3,405  | **3,119**  | 12,288 |
| Channel route — plus routing frames       | 11,573 | 4,375  | **4,004**  | 4,096  |
| Navigating route — plus staged routes     | 13,347 | 5,115  | **4,669**  | 5,120  |
| Server kernel — the document request path | 23,604 | 9,055  | **8,058**  | 8,192  |
| Server kernel — plus intent dispatch      | 27,235 | 10,301 | **9,163**  | 10,240 |
| Server kernel — plus refresh and epochs   | 31,936 | 11,905 | **10,608** | 12,288 |
| Server kernel — plus a live Warp channel  | 39,622 | 14,660 | **13,095** | 13,312 |

Comfortably inside on the client, and a content route still drops by never importing the
update path, which is the module-level version of paying only for what you use.

Those client figures grew by about 1,300 bytes across the signal graph rewrite, derived
values, component adoption, property bindings, and staged epochs. It is recorded here rather
than smoothed over, because a byte budget that only ever moves in reports is not a gate.

**The kernel is the tight one, and the claim is scoped.** The design says "target under 8 KB
server-side"; that number covers **the document request path** — lifecycle, envelope, routing,
key derivation, wave dispatch, the stream. 8,169 B brotli against 8,192, so 23 bytes of
headroom. Every other capability gets its own entry and its own stated ceiling rather than a
share of that one, which is what [`spec/kernel/budgets.md`](spec/kernel/budgets.md) is for.

Two corrections got the figure where it is. Taking the plugin ordering graph and the dev-only
read guard out of the request path returned 473 bytes, because neither was ever request work —
a reachability gate keeps them out now. And `createRouter` had never been in the measurement at
all, so every earlier figure described a kernel whose `serve()` throws `E_NO_ROUTES`; including
it cost 639. The net is +166 bytes and a number that describes something you can deploy.

The first attempt measured the whole barrel and came out 29% over — the gross-versus-marginal
mistake the design warns about in the same paragraph as the byte budget, made immediately.

Read the client headroom carefully too. **This runtime still does less than the design's
runtime will.** No form negotiation on the client's side of the wire, and nothing off the main
thread. What the numbers establish is a baseline and a gate: about 1.4 KB of brotli headroom on
the client, and a test that fails the moment an entry crosses its ceiling. Instant navigation
arrived under that rule rather than into it — 665 bytes, in an entry of its own, so a page that
links nowhere does not carry the staging model.

## Repeat visits, and Warp's first real run

The second of the two "largest gap" claims: a returning visitor should do no wiring
construction, because a wiring table is content-addressed and can simply be kept. Testing
it meant making the resident set real — templates persisted in IndexedDB, advertised to the
server as a coarse digest, and delivered as `TPL` frames only when the client does not
already hold them. That is also the first time Warp has run end to end rather than in its
own tests.

| Boot path, p50    | Chromium    | Firefox | WebKit  |
| ----------------- | ----------- | ------- | ------- |
| First visit       | 2.50 ms     | 6.00 ms | 3.00 ms |
| Repeat visit      | 0.70 ms     | 3.00 ms | 1.00 ms |
| Protocol bytes    | 1,124 → 132 | same    | same    |
| `TPL` frames sent | 2 → 0       | same    | same    |

**One correction to the claim.** "Zero wiring construction" is true, and it is not the same
as zero startup work. A repeat visit skips receiving, parsing and storing templates. It
still pays **adoption**, because the DOM in front of it is new every time and the bindings
have to be found again. Only the table adoption builds _from_ is cached, never the walk
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

|                       | ns per render |
| --------------------- | ------------- |
| Typed, 4 holes elided | 16,780        |
| Syntax-only, 0 elided | 16,503        |

Elision is worth nothing here, and the reason is that the renderer already elides at
runtime: it scans a value before escaping it and writes it untouched when the scan finds
nothing, which for `"8715"` is a few nanoseconds. The compile-time proof saves the scan
and the scan was never the cost.

The real 7.9% was the **marker comments**. The compiler emits `<!>` before a dynamic text
run so the text node is addressable, and the hand-written IR it replaced had none. That is
a genuine cost for a genuine capability, and mis-attributing it to escaping was a guess
dressed as a finding.

The type oracle stays, on a smaller and honest justification: it makes the IR's escape
class _true_ rather than conservative. A JavaScript renderer can afford to scan; a native
codec crossing a WASM boundary per hole, or a client projecting values into a resident
template, cannot. An escape class that says "escape" about a number is a lie the format
should not carry, whatever this particular renderer does with it.

## The phase-zero gate, and its answer

The design says: _if the pre-encoded-buffer shell does not beat a tuned React Router 7
app on TTFB in a reproducible test, the central premise is wrong and better to know in
week two._ That test now exists — a route whose data takes 40 ms, 40 ms of injected RTT,
and [a real RR7 app](benchmarks/rr7) in two configurations.

| Candidate                                                 | TTFB p50     | Last byte | Bytes |
| --------------------------------------------------------- | ------------ | --------- | ----- |
| Weft segments                                             | 43.46 ms     | 84.67 ms  | 6,289 |
| String-concat SSR, streaming                              | 43.48 ms     | 84.84 ms  | 6,289 |
| **RR7, tuned** — promise loader, Suspense, `onShellReady` | **44.65 ms** | 90.78 ms  | 7,687 |
| Await the loader, then render                             | 84.75 ms     | 84.78 ms  | 6,289 |
| **RR7, default shape** — awaited loader, `onAllReady`     | **95.35 ms** | 95.40 ms  | 6,370 |

**The premise survives, but the framing does not.** Against a _tuned_ RR7 app the shell is
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

## The kernel, the ports, and the plan layer

The design's build order puts kernel and ports at phase 2 and the plan layer at phase 4, and
this project had built phase 4's front half — effect inference, cache classes, contagion — on
top of a kernel that did not exist. That is why `requiresTtl` had nothing to contradict. The
floor is now under it.

**The request is a state machine.** `received → envelope → planned → streaming → settled`,
with declared transitions and `E_REQUEST_STATE` for anything else. Phase A owns the envelope;
phase B is a **different context type** with no envelope methods on it, so the mistake every
other framework documents cannot be written here. `Cache-Control` and `Vary` are written
before the seal, from the resolved keys, which removes the single most common reason to want a
late header.

**103 Early Hints decouples discovery from committing.** The links go out at effectively zero
milliseconds and the envelope stays open. `sendEarlyHints` returns whether they actually went
out, because 103 is H2/H3 only and an HTTP/1.1 client just waits — a boolean rather than a
claim.

**An effect that missed its window can wait for the next request on the connection**, and
eligibility is not the developer's call: `deferrable()` refuses anything non-idempotent by
name. If there is no next request the effect is dropped, which is stated rather than hidden,
and is exactly why only idempotent effects qualify.

**Cache keys are resolved from what the code read.** The compiler said which reads taint; the
kernel resolves their values, sorts them, and hashes them with the fragment's content address.
There is no key setter — not in the kernel, not in the plan DSL, not on the plugin surface —
and that absence is the enforcement. A public policy on a private fragment throws
`E_PRIVATE_AS_PUBLIC` rather than emitting a header.

**Render is a DAG.** `needs` is data dependency only, so the design's own example reproduces:
nine slots, three waves, a 42.7 ms critical path against a 123.3 ms sequential walk. This is
safe here for one reason — render is provably read-only, so two fragments cannot observe each
other's side effects because they cannot have any. The constraint that made the envelope
design necessary is the constraint that makes concurrent evaluation possible.

**A CPU budget is only enforceable where a render can be preempted.** So preemption is declared
on the executor — three states, because `never`, `at-await` and `always` are three behaviours and
a boolean could not tell them apart, a breach on `inline` is still reported with a message saying it ran
to completion anyway, and declaring one there is a build warning naming the executors where
the limit is real. `pool:` is now one of them: a real `worker_threads` pool that terminates a
render mid-loop, which is the only thing that makes `.budget({ cpu })` a limit rather than a
report. It also surfaced why the other three off-thread kinds were unimplemented —
`ExecutorPort.run` takes a closure, and a closure cannot cross a crash domain, so a job that
runs elsewhere needs an address and a slot without one fails the build.

**Epochs separate data currency from view currency.** Staged frames paint nothing; one
`COMMIT` flips every slot in an epoch at once. Prefetch cannot disturb the present, and
rollback is discarding an epoch. 254 bytes on the client.

**A staged route is an epoch one level up, and that is what instant navigation is.** An epoch
stages values into the slots of the page you are on; it cannot stage a _different_ page, because a
staged write names a region and a region does not exist until its route has rendered. So routes are
staged the same way and keyed by URL: hover a link and the document is fetched, parsed, and painted
nowhere; click it and the commit is a DOM swap rather than a request, so the channel, the resident
templates and the reader's place all survive it. A click on a route that is **not** already staged
is handed back to the browser — a document response streams and a `fetch` of the same document does
not, so waiting on one would make a slow page slower than doing nothing. Measured on the demo in
Chromium: 17 ms staged against 606 ms for the page whose slots are deliberately slow, and at 100 ms
injected RTT 7–19× on the ordinary ones. On loopback, where there is no round trip to remove, a
staged click is _slower_ than letting the browser do it for a page the server answers instantly —
which is the honest floor of the whole idea and is in
[`spec/client/navigation.md`](spec/client/navigation.md) with the table. 665 bytes, in its own
budget entry. `navigation: { scroll: 'preserve' }` in the config keeps the reader's position across
a route change, per link with `data-weft-scroll`; back and forward restore what the entry recorded
either way.

**The surgical refresh is stateless and its delta is shared, and that is now measured.** The
client names the base it holds, the server recovers it through `StorePort`, diffs, and memoizes
under `delta:<tpl>:<from>-><to>`. A thousand clients on one base render cost **one** diff
computation against a per-connection differ's thousand — 0.3 ms against 8.2. A thousand clients
each on a _different_ base share nothing, and the shared path then costs 17.3 ms against 9.2,
because it does the same thousand diffs plus a store round trip for each. Both numbers are in
the report, because the second one is where a deployment gets surprised. Phoenix is not running
here: the per-connection figure is a real per-connection differ over the same templates and the
same transition, so what is compared is the architecture and not any constant factor of
LiveView.

**All three of the design's memoisation levels are real.** The fragment, keyed by its effect
signature. Derived values, where the dependency graph is already on the wire so the set a change
can reach is computable. And template segments, content-addressed — a 500-row list with three
changed rows costs three row renders, and a _reordered_ list costs none. Two lines are drawn
deliberately: only nested templates are memoised, because hashing a text hole costs more than
rendering it, and the memo is process-local because `render` is synchronous and a shared tier
could not answer it. The gate is byte identity with a full render, checked over every scenario
cold and warm.

**The plan is checked against the compiler, never the reverse.** A refusal per rule and five
warnings, each naming the read or the slot that caused it — including the one the design
promises in its strongest terms: `.cache('public')` on a fragment that reads identity fails
the build, naming `identity`.

**Ports replace, plugins extend.** Thirteen ports declared and thirteen implemented, ten of them
bound by the front door with no configuration at all. The last three were the interesting ones,
because building them decided something. `config` is settings from an environment or a Worker
binding, and a setting is deliberately **not** a tracked read — it is a property of the deployment,
so it cannot taint a fragment and cannot enter a key, which is the only reason a key is safe to
log. `db` is where a loader's data comes from, named: the framework never sees a loader, so a query
inside one has no name in the telemetry, no deadline anybody chose and no record of the tags the
render depended on, and the port gives all three back without inventing a query language.
`deployment` is which build is answering, a port because every platform spells a revision
differently and most spell it in an environment variable the kernel may not read. `scheduler` and
`assets` were interfaces the kernel worked around: the first is the kernel's own ordering rule
named so a deployment can replace it, and the second is why every page now emits a 103 carrying its
own stylesheet and runtime instead of the kernel having nobody to ask. And `ctx.data`/`ctx.setting`
live in the front door rather than the kernel because writing them into the request path took it 62
bytes over a ceiling the design fixed — the byte budget deciding an architecture question, and
deciding it correctly: a loader is a front-door concept, so what a loader may reach is the front
door's business.

**None of it is asserted against a hand-built IR.** `packages/kernel/fixtures/cart-route.ts`
assembles a route out of real compiler output and the integration test asserts what falls out —
the `Vary` union, the private class, the resolved key components, the fastest-first arrival
order — rather than what was declared. `packages/plan/fixtures/cart.ts` derives its `SlotFacts`
from the compiled entry, so a fixture asserting a build error has to earn it from real effect
inference. Change what `private.tsx` reads and those fixtures stop failing.

**And the kernel imports nothing but the WinterTC Minimum Common Web API.** That rule now has
a test, and the test failed on its first run: `serveRoute` had been sitting in
`packages/kernel` importing `node:http` for weeks. It lives in `packages/adapters` now.

**The plan is now a route.** `shell(id)` names the document and its boundaries are checked
against the plan's slots — a slot naming a hole the shell does not leave, or a hole nothing
fills, is a build error rather than an empty region in production. `lowerPlan` validates before
it lowers, so an invalid plan cannot become a route at all, and it refuses a slot with no binding
or a guard with no handler. `createRouter` matches by specificity rather than declaration order.
`kernel.serve(request)` is the whole entry point.

Two things there are derived rather than declared: the streaming order (`out-of-order` the moment
any slot asks to stream, `in-order` when none does, because in-order needs no fill mechanism),
and phase A (guards run before a byte leaves, so a declared redirect is a real 302).

**Frames leave the process now, in all three bindings the design names.** A streamed response
with discrete POSTs up, an SSE stream, and a WebSocket, over one binding-agnostic channel. What
each one costs is stated where it bites: SSE cannot carry binary so it pays base64 on every
body, and the two half-duplex bindings answer on the other connection, so an upstream POST whose
downstream has dropped is `E_NO_DOWNSTREAM` rather than a silent 200.

**Intents are the only thing allowed to write**, and they declare what they invalidate. An
undeclared tag throws — not in dev only, because an undeclared read is a missed optimisation and
an undeclared write is a cache invalidation nobody can predict from the code. A form posts and
gets a 303 back where it came from, which is the whole no-JavaScript path; the same dispatch
answers a `fetch` with the outcome. Over a channel the epoch does the interesting work: a client
stages its guess, the server stages the truth into the same epoch and commits, and on failure
the ACK says so and the client discards the epoch — nothing painted, so nothing has to be
un-painted.

## What has to be true next

1. **A capability model behind `CapabilityCheck`.** Intents declare capabilities and an
   unchecked one is refused rather than allowed, which is honest and is not an implementation.
2. **A bandwidth and loss model in the latency proxy.** It delays packets and nothing else, so
   it understates what a slow link does to an 18% byte difference.
3. **Incremental declarative-shadow-DOM parsing on real iOS, Android WebView, and WebKitGTK.**
   If the engines diverge the filler script becomes the primary path, which is survivable and
   changes what can be claimed.
