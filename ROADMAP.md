# Roadmap

What is built is described in [`README.md`](README.md) and the specs under
[`spec/`](spec/). This file is only what is not built, in the order it makes sense to build
it, with the reason each item is where it is.

Two rules carry over from phase zero and apply to everything below. A claim that is not
measured is not made. A capability that does not exist is refused with a named error rather
than approximated.

---

## Where the design's own build order stands

The nine phases are from [the architecture proposal](docs/weft-and-warp.html).

| Phase                                 | State                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Prove the physics, version the IR | Done. RR7 gate measured, IR versioned from commit one, harness gates every claim                                                             |
| 2 · Kernel and ports                  | Request state machine, two-phase envelope, 103 Early Hints, deferral, routing, thirteen ports declared and six implemented                   |
| 3 · Client runtime                    | Signals, wiring, adoption, deltas, residency, epochs, budget. Missing: navigation, intent transport                                          |
| 4 · The plan layer                    | Plan DSL, effect inference, runtime keys, plugin DAG, `weft why`, and a plan that lowers to a served route. Missing: generated plans         |
| 5 · Negotiation and locus             | Resident digests, form selection, `STALE`, epochs with atomic commit, executors, per-slot budgets. Missing: a transport binding, a real pool |
| 6 · Stateless surgical updates        | `HELD` flow, base recovery through the store, memoized deltas. Missing: incremental recompute, a LiveView benchmark                          |
| 7 · Discovery and authority           | Not started. No lazy plan extension, render intents, capability checks, signed intents                                                       |
| 8 · Profile-guided planning           | Not started. No `weft profile`, generated plans, chunk packing, V8 compile hints                                                             |
| 9 · Composition and topology          | Composition is in-process. `remote` is a declared wire form with no implementation                                                           |

---

## Near term — closing the seams that were opened

### 1. A Warp transport binding

`HELD`, `REFRESH`, `STALE`, `COMMIT`, `REDIRECT` and `COOKIE` are produced, parsed and tested
as frames. Nothing carries them over a live connection, so every one of phases 5 and 6's flows
is exercised in a test and never over a wire.

The design names three bindings — streamed response with discrete POSTs up, SSE, WebSocket.
The first is already half-built: the document response _is_ the first frames.

### 2. Intents, and therefore invalidation

`EffectSet.writes` and `.envelope` are still empty because nothing writes. Intents unblock
invalidation, `revalidateTag`, optimistic epochs driven by a real mutation, the `INTENT` and
`ACK` frames, and method-aware routing — the table is path-only today because a method match
would have nothing to dispatch to.

### 3. The last 346 bytes of the kernel

The document request path is 7,846 B brotli against the design's 8,192, and routing spent 244 of
the headroom. Intents and an epoch transport do not fit in what is left.

Two honest options, and the choice should be deliberate rather than discovered: accept that the
8 KB figure describes a smaller kernel than the design's full feature list, or move something
currently in the request path behind a port. Either way it is a decision, and it is due before
the next thing goes in rather than after.

### 4. A stampede lease in the request path

`StorePort.lease` is implemented and tested and the kernel never takes one, so two concurrent
misses render twice. This is a small change with a large effect under load, and it is the
difference between a cache and a cache that helps during an incident.

### 5. L0: fragments that read nothing

A fragment classified `static` could be resolved at build time and served by a CDN with the
kernel never invoked — the fastest tier by a wide margin, and free. Today it renders and caches
like anything else, which means the cheapest thing in the design is not implemented.

### 6. Generated plans, and plans from a convention

`lowerPlan` takes a plan, some `SlotFacts` derived from compiler output, and a bindings object.
The first is derived; the other two are written by hand. A file convention or a profile that
emits both is phase 8, and it is what makes a plan diffable in review rather than authored.

### 7. A real worker pool

`deferred` is preemptible at await points and is not a worker thread; it says so. A CPU budget
is only a hard limit on a genuinely separate crash domain, so `pool:` is what makes
`.budget({ cpu })` mean anything.

### 8. Slots inside components

`<Widget>content</Widget>` is `E_COMPONENT_CHILDREN_UNSUPPORTED`. A component takes props only.
Children need a slot mechanism inside a nested template, which is a different problem from the
streaming `slot` hole and should not reuse it by accident.

### 9. Components inside list rows

`E_COMPONENT_IN_LIST`. A row is its own template and cannot carry an instance today.

### 10. Incremental recompute

`.incremental()` is recorded in a plan, warns when there is nothing to memoize, and is read by
nothing. The design's three memoisation levels exist only at the coarsest — fragment, keyed by
effect signature, which is `StorePort`. Derived-value and template-segment memoisation are the
opt-in part, and the literature is explicit that structural change to the computation graph is
the hard case, which is why it stays per-slot rather than becoming a mode.

### 11. A LiveView benchmark

Beating LiveView on shared-delta efficiency is the specific claim phase 6 exists to make, and
it has not been measured against LiveView. The mechanism is built and the comparison is not.

### 12. iOS WebKit on a real device

Playwright's WebKit is a desktop proxy and is labelled as one everywhere it appears. A
WKWebView on a device has app-bound-domain rules, host-app request interception, and OS
suspension that the proxy does not. No claim about iOS is honest until this runs.

---

## The documentation site

**Goal.** Somebody who has never seen this project can read a guide, run the code in the
page, and change it. Nothing is a screenshot; every example is live.

**Why it is on the roadmap and not in a wiki.** The compiler is the thing that has to be
explained, and the only convincing explanation is _here is the TSX, here is the IR it
lowered to, here is the HTML that renders, here are the bytes on the wire_. That is a
playground, not prose.

### What it contains

| Section    | Content                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start here | What a fragment is, what the compiler refuses, and why refusing is the point                                                                                    |
| Guides     | Templates and holes · signals and derived values · components and composition · effects and caching · streaming and slots · the wire forms · Warp and residency |
| Reference  | Every error code with the source that triggers it and the fix; the authoring surface; `ctx` in full, in both phases                                             |
| The IR     | The document, hole by hole, generated from `spec/ir/template-ir-2.md` and checked against the real emitter                                                      |
| Playground | The editor described below                                                                                                                                      |
| Findings   | `spec/FINDINGS.md` rendered, including the reversals                                                                                                            |

### The playground

An editor pane, and tabs over the result: **HTML**, **IR**, **wire bytes**, **effects**,
**keys**, **errors**.

- The compiler runs in the browser. It is Oxc plus AST walks and already has no Node
  dependency in the hot path; the file reading in `compileFiles` needs a virtual file
  system to work against instead.
- Multiple files, because cross-module composition is a headline feature and cannot be
  shown in one buffer. A file tree with two or three tabs is enough.
- The **errors** tab is a first-class view, not a footer. Every refusal in the reference
  section links to a playground URL that reproduces it. A compiler whose value is what it
  refuses has to make refusal legible.
- The **effects** tab shows the inferred read set, the derived cache class, the `Vary`
  header, the key components and flag axes, and which instances were isolated and why.
- The **keys** tab shows the same reads resolved against a request you can edit — change a
  cookie, watch the key change. This is the one thing that makes "the key is derived, never
  written" convincing rather than assertable.
- Sharable URLs: the state is the file set, compressed into the fragment.

### Build notes

- Static site. No server, so it can be hosted anywhere and cannot drift from the repo.
- The examples in the guides are the fixtures in `packages/compiler/fixtures/`, not copies
  of them. A guide that shows code the test suite does not compile is a guide that will
  rot.
- Generated pages carry the version of the IR they were generated against.

---

## The demo site

**Goal.** Every capability this framework has, shown working, with a control that lets you
feel the mechanism rather than read about it. Explicitly: **not a subset**. If a feature is
in the specs, it has a station here.

**Why it is separate from the docs site.** Documentation explains; a demo convinces. The
demo is allowed to be dramatic — injected latency, artificial slowness, side-by-side races
against a control — in ways a guide should not be.

### The stations

Each one is a page with the thing running, a control panel, and a live readout of what it
cost.

| Station                 | What it shows                                              | The control you get                                                                                                            |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Streaming**           | A route with slow regions streaming into slots             | A **latency slider** per region, plus a slider for the round-trip time; watch first byte, each region's arrival, and the total |
| **Streaming order**     | `in-order` against `out-of-order`, same page, side by side | A toggle, and the slow region's delay; the 329-byte filler cost shown as a number that appears when you switch                 |
| **Blocking control**    | The same route awaiting its loader, for contrast           | The same sliders, so the 2.19× is something you produce rather than read                                                       |
| **Adoption**            | A server-rendered region becoming interactive              | A binding count slider — the point is that cost tracks bindings, not components                                                |
| **Signals**             | One signal driving several nodes                           | Write frequency; a counter of DOM writes against signal writes                                                                 |
| **Derived values**      | `{qty * 100}` recomputing on the client                    | Edit the signal; a toggle to show that a derived value which lands on the same result writes nothing                           |
| **Components**          | Composition, cross-module, one child used many times       | A count of instances against the number of sealed templates — it stays at one                                                  |
| **Contagion**           | A private fragment inside a shared route                   | A switch making the child private; watch the route's cache class stay `shared` and the instance become its own unit            |
| **Effects and caching** | The inferred read set of a live fragment                   | Toggle each `ctx` read on; watch the class, `Vary`, and key components change                                                  |
| **Cache keys**          | The same reads resolved into a key                         | Edit a cookie, a header, a flag; watch the key change and the hit turn into a miss                                             |
| **Routing**             | A path matching a plan, and the plan becoming a route      | Type a path; watch which pattern wins, what params it captured, and the plan that lowered                                      |
| **Shell boundaries**    | A plan whose slots disagree with the shell's holes         | Add a slot the shell does not have; watch the build refuse it and name the boundaries it does leave                            |
| **The envelope**        | Phase A against phase B                                    | Try to set a cookie in a render and watch the type refuse it; move it to a guard and watch a real 302                          |
| **Early hints**         | 103 against a flush-to-discover baseline                   | A toggle, and the shell's critical link set; watch when the browser starts fetching                                            |
| **Waves**               | The DAG, its waves, and the critical path                  | Drag a `needs` edge; watch the critical path move and the sequential figure stay where it was                                  |
| **Budgets**             | A slot over its CPU budget                                 | A slowness slider and an `onExceed` picker; watch the same breach produce five different pages                                 |
| **Epochs**              | Data arrived, not painted                                  | A "stage" button and a "commit" button, with a half-typed form to prove the commit did not disturb it                          |
| **Shared deltas**       | Ten clients making one transition                          | A client count; watch computations stay at one while deliveries climb                                                          |
| **The wire forms**      | `html`, `bundle`, `split`, `patch`, `delta`                | A form picker and a byte counter, with brotli sizes; the equivalence check running live                                        |
| **Deltas**              | One changed value becoming one DOM write                   | Edit any value; a highlight on exactly the nodes that were written                                                             |
| **Controls**            | A `prop` binding surviving a user's edit                   | Type into the input, then push a new value; an attribute-only mode to show the bug it fixes                                    |
| **Escaping**            | Escape classes, including `trusted-raw` and its provenance | Paste markup into a value and watch where it is and is not escaped                                                             |
| **Warp**                | `WARP`/`SHELL`/`TPL` frames in the document                | A frame inspector; a switch for a cold visit against a warm one                                                                |
| **Residency**           | Repeat visits with templates already held                  | A "forget everything" button; boot path timing for both states                                                                 |
| **Negotiation**         | A client that speaks an older IR                           | A version picker; watch forms drop and `html` survive                                                                          |
| **Byte budgets**        | The runtime and the kernel measured against their ceilings | Per-entry breakdown, updated from the real bundle                                                                              |

### Build notes

- Every number on the page comes from the same code that produces the benchmark report.
  The demo may not have its own measurement path — a demo that measures differently from
  the harness is a demo that will disagree with it.
- The latency sliders drive the existing TCP proxy in `benchmarks/`, not a `setTimeout`. It
  already exists and already delays both directions.
- A station for a capability that is not built yet shows the refusal and links to the
  roadmap entry. Better an honest empty station than a mock.
- The station list is checked against the spec table of contents in CI, so a new capability
  that ships without a station fails the build. That is the mechanism that makes "not
  missing a single one" true a year from now rather than only on the day it is written.

### Sequencing

Every station is a route, and routes now exist, so the demo is unblocked. Its caching and
negotiation stations still want a Warp transport binding. The docs site and its playground depend
on none of that and can start immediately — the compiler already has no Node dependency in its
hot path, and only `compileFiles` needs a virtual file system.

---

## Deliberately not planned

- **A virtual DOM, or a diffing renderer.** The delta form addresses holes directly and is
  20–93× cheaper than the parse it replaces. There is nothing to reconcile.
- **A `data` wire form.** Cut in IR 2.0.0 after measurement: 1% smaller after brotli and
  1.07–1.33× slower to apply than `html`. See [`spec/FINDINGS.md`](spec/FINDINGS.md). It cost
  a second time when the surgical-refresh ladder came out two rungs instead of three, and it
  was still the right call.
- **Escape elision as a throughput claim.** Kept for correctness and for native codec
  boundaries. Measured at nothing.
- **Zero-JavaScript out-of-order streaming.** Not possible: slot assignment needs a host
  that is still open, and keeping it open is in-order streaming. The 329-byte filler is the
  price of fastest-first, not a gap to close.
- **A cache key that can be written by hand.** There is no setter, and a plugin may add an
  axis but never a key. This is the one extension point the design refuses on purpose.
- **HTTP trailers as an escape from the sealed envelope.** They look like one. Browsers do
  not apply them to these semantics.
