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
| Template IR, `weft.template-ir/2` | [`spec/ir/template-ir-2.md`](spec/ir/template-ir-2.md), `packages/ir`                         | 2.4.0 — derived values, components, contagion                       |
| Warp frames, `weft.warp/1`        | [`spec/warp/warp-1.md`](spec/warp/warp-1.md), `packages/warp`                                 | 1.1.0 — `REDIRECT` and `COOKIE` for a sealed response               |
| Versioning contract               | [`spec/VERSIONING.md`](spec/VERSIONING.md)                                                    | Majors refuse, minors round-trip                                    |
| What measurement changed          | [`spec/FINDINGS.md`](spec/FINDINGS.md)                                                        | Five reversed, two clarified, one gate that fired on its first run  |
| Device and engine reality         | [`spec/baseline/devices.md`](spec/baseline/devices.md)                                        | Written before the numbers                                          |
| Template compiler                 | [`spec/compiler/supported-subset.md`](spec/compiler/supported-subset.md), `packages/compiler` | TSX to IR, on Oxc, with type-driven escape elision                  |
| Client runtime                    | [`spec/client/adoption.md`](spec/client/adoption.md), `packages/client`                       | Adoption, surgical deltas, resident templates over Warp             |
| Signal graph                      | [`spec/client/signals.md`](spec/client/signals.md), `packages/client`                         | Linked edges, bitflag status, push-pull with a lazy check           |
| Effect inference                  | [`spec/compiler/effects.md`](spec/compiler/effects.md), `packages/compiler`                   | Reads inferred, cache class derived, ambient reads banned           |
| Route streaming                   | [`spec/kernel/streaming.md`](spec/kernel/streaming.md), `packages/kernel`                     | Slots streamed in order or fastest-first                            |
| Routing                           | [`spec/kernel/routing.md`](spec/kernel/routing.md), `packages/kernel`, `packages/plan`        | A URL matches a plan; the plan lowers to a route; `serve()` runs it |
| Request lifecycle                 | [`spec/kernel/lifecycle.md`](spec/kernel/lifecycle.md), `packages/kernel`                     | A state machine, two-phase envelope, 103 Early Hints, deferral      |
| Ports                             | [`spec/kernel/ports.md`](spec/kernel/ports.md), `packages/kernel`, `packages/adapters`        | Thirteen declared, six implemented, the rest refuse by name         |
| Runtime cache keys                | [`spec/kernel/cache.md`](spec/kernel/cache.md), `packages/kernel`                             | Reads resolved into a key; no setter exists anywhere                |
| Executors, waves, epochs          | [`spec/kernel/locus.md`](spec/kernel/locus.md), `packages/kernel`, `packages/client`          | DAG scheduling, CPU budgets, staged epochs with atomic commit       |
| Stateless surgical updates        | [`spec/kernel/surgical.md`](spec/kernel/surgical.md), `packages/kernel`                       | `HELD` recovers a base, the delta is memoized by its transition     |
| The plan layer                    | [`spec/plan/plan.md`](spec/plan/plan.md), `packages/plan`                                     | Plan DSL, validation against inferred effects, plugins, `weft why`  |
| Benchmark harness                 | `packages/bench`                                                                              | All six axes measured                                               |
| What is not built yet             | [`ROADMAP.md`](ROADMAP.md)                                                                    | The runtime, a docs site with a playground, a demo of every feature |
| React Router 7 candidate          | [`benchmarks/rr7`](benchmarks/rr7)                                                            | The phase-zero gate, tuned and default shapes                       |

## Running it

No build step — Node 22.18+ strips the types. One install, for the compiler's parser.

```sh
pnpm install                                                # Oxc, for the compiler only

node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
node packages/compiler/src/cli.ts fixtures/*.tsx --no-types   # syntax-only elision
node packages/bench/src/cli.ts list                         # axes, scenarios, candidates
node packages/bench/src/cli.ts verify                       # every wire form must agree
node packages/bench/src/cli.ts client                      # adopt and patch, in three engines
node packages/bench/src/cli.ts budget                      # bundle each entry against its byte budget
node packages/bench/src/cli.ts slots                       # both stream orders, and the shadow-DOM probe
node packages/bench/src/cli.ts run                          # measure and write a report
node packages/bench/src/cli.ts run --transport buffered      # the intercepted-webview path
node packages/bench/src/cli.ts run --axes shell-ttfb --scenarios slow-feed \
  --latency 40 --external benchmarks/rr7/candidates.json    # the gate, against RR7
node packages/bench/src/cli.ts ir cart                       # the compiled, sealed IR
npm run typecheck                                            # TypeScript 7, clean
node --test packages/*/test/*.test.ts                        # 125 conformance tests
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

| Entry                                     | Raw    | gzip   | brotli    | Budget |
| ----------------------------------------- | ------ | ------ | --------- | ------ |
| Client runtime, everything                | 8,525  | 3,272  | **2,996** | 6,144  |
| Content route — adopt and bind            | 6,120  | 2,282  | **2,082** | 5,120  |
| App route — adopt, bind, patch, epochs    | 8,494  | 3,258  | **2,982** | 12,288 |
| Server kernel — the document request path | 21,779 | 8,269  | **7,360** | 8,192  |
| Server kernel — plus the Warp channel     | 28,792 | 10,787 | **9,583** | 12,288 |

Comfortably inside on the client, and a content route still drops by never importing the
update path, which is the module-level version of paying only for what you use.

Those client figures grew by about 1,300 bytes across the signal graph rewrite, derived
values, component adoption, property bindings, and staged epochs. It is recorded here rather
than smoothed over, because a byte budget that only ever moves in reports is not a gate.

**The kernel is the tight one, and the claim is scoped.** The design says "target under 8 KB
server-side"; that number covers **the document request path** — lifecycle, envelope, routing,
key derivation, wave dispatch, the stream — and the channel path has its own stated ceiling
rather than a share of the same one. 7,360 B brotli against 8,192, so 832 bytes of headroom.
Routing spent 231; taking the plugin ordering graph and the dev-only read guard out of the
request path returned 473, because neither was ever request work. A reachability gate keeps them
out. [`spec/kernel/budgets.md`](spec/kernel/budgets.md) says what each figure covers and why a
new capability gets its own entry instead of drawing on someone else's headroom.

The first attempt measured the whole barrel and came out 29% over — the gross-versus-marginal
mistake the design warns about in the same paragraph as the byte budget, made immediately.

Read the client headroom carefully too. **This runtime still does less than the design's
runtime will.** No navigation, no form negotiation, no intent transport. What the numbers
establish is a baseline and a gate: about 3 KB of brotli headroom on the client, and a test
that fails the moment an entry crosses its ceiling.

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

**A CPU budget is only enforceable where a render can be preempted.** So `preemptible` is
declared on the executor, a breach on `inline` is still reported with a message saying it ran
to completion anyway, and declaring one there is a build warning naming the executors where
the limit is real.

**Epochs separate data currency from view currency.** Staged frames paint nothing; one
`COMMIT` flips every slot in an epoch at once. Prefetch cannot disturb the present, and
rollback is discarding an epoch. 254 bytes on the client.

**The surgical refresh is stateless and its delta is shared.** The client names the base it
holds, the server recovers it through `StorePort`, diffs, and memoizes under
`delta:<tpl>:<from>-><to>`. The second client making that transition pays a store read; so
does the ten-thousandth. LiveView would compute the diff ten thousand times.

**The plan is checked against the compiler, never the reverse.** A refusal per rule and five
warnings, each naming the read or the slot that caused it — including the one the design
promises in its strongest terms: `.cache('public')` on a fragment that reads identity fails
the build, naming `identity`.

**Ports replace, plugins extend.** Thirteen ports declared; six implemented; the rest refuse
with `E_PORT_UNIMPLEMENTED` rather than approximating. A plugin's dependency graph is inferred
from `reads` and `provides`, so most middleware becomes concurrent without anyone opting in,
and a plugin that reads state it did not declare throws — the one rule that keeps effect
tracking honest.

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

## What has to be true next

1. **A Warp transport binding.** `HELD`, `REFRESH`, `STALE` and `COMMIT` are produced, parsed
   and tested as frames, and nothing carries them over a live connection.
2. **Intents.** `EffectSet.writes` stays empty until there is something that writes, which is
   also what invalidation and `revalidateTag` wait behind.
3. **A stampede lease in the request path.** `StorePort.lease` is implemented and the kernel
   does not take one, so two concurrent misses render twice.
4. **A bandwidth and loss model in the latency proxy.** It delays packets and nothing else, so
   it understates what a slow link does to an 18% byte difference.
5. **Incremental declarative-shadow-DOM parsing on real iOS, Android WebView, and WebKitGTK.**
   If the engines diverge the filler script becomes the primary path, which is survivable and
   changes what can be claimed.
