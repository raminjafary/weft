# Roadmap

What is built is described in [`README.md`](README.md) and the specs under
[`spec/`](spec/). This file is only what is not built, in the order it makes sense to build
it, with the reason each item is where it is.

Two rules carry over from phase zero and apply to everything below. A claim that is not
measured is not made. A capability that does not exist is refused with a named error rather
than approximated.

A third rule now applies to anything that adds to the server. Byte ceilings are per entry and
each one states what it covers — see [`spec/kernel/budgets.md`](spec/kernel/budgets.md). A new
capability on the server gets its own measured entry and its own stated ceiling; it does not
draw on the document request path's headroom.

A fourth applies to the applications in this repository. `demo/` may import `weft` and nothing
else, and its `package.json` depends on `weft` alone so it cannot do otherwise by accident. When a
page there needs something the front door does not offer, that is a gap in the front door — which
is the only reason to keep a demo at all.

---

## Where the design's own build order stands

The nine phases are from [the architecture proposal](docs/weft-and-warp.html).

| Phase                                 | State                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Prove the physics, version the IR | Done. RR7 gate measured, IR versioned from commit one, harness gates every claim                                                                                           |
| 2 · Kernel and ports                  | Request state machine, two-phase envelope, 103 Early Hints, deferral, routing, intents, a stampede lease, thirteen ports declared and seven implemented                    |
| 3 · Client runtime                    | Signals, wiring, adoption, deltas, residency, epochs, budget, a frame router, optimistic intents with rollback. Missing: navigation, which is blocked on phase 7 discovery |
| 4 · The plan layer                    | Done. Plan DSL, effect inference, runtime keys, plugin DAG, `weft why`, `.incremental()`, and plans generated from a folder convention rather than authored                |
| 5 · Negotiation and locus             | Done. Resident digests, form selection, `STALE`, epochs with atomic commit, executors, per-slot budgets, all three transport bindings, a real worker pool                  |
| 6 · Stateless surgical updates        | Done. `HELD` flow, base recovery, memoized deltas over a live channel, three levels of incremental recompute, and the shared-delta comparison measured                     |
| 7 · Discovery and authority           | Intents dispatch and declare their writes; `CapabilityCheck` is the seam a capability model plugs into. Missing: lazy plan extension, an implemented model, signed intents |
| 8 · Profile-guided planning           | Generated plans are done, from a convention rather than a profile. Missing: `weft profile`, chunk packing, V8 compile hints                                                |
| 9 · Composition and topology          | Composition is in-process. `remote` is a declared wire form with no implementation                                                                                         |

---

## Near term — closing the seams that were opened

### 1. Devtools: the inspector, pointed at your application

`@weft/inspector` is thirty-four stations demonstrating what the framework does, and it does that
with fixtures of its own — a fragment that reads nothing, one that reads the clock, one that reads
identity. That is documentation which runs, and it is the right shape for it. It is not devtools.

Devtools is the other thing: show me _my_ routes, _my_ effect sets, why _my_ fragment resolved to
`private`, _my_ byte report. Nothing about that needs a second application in the process, which is
why mounting the inspector inside an app was the wrong way to get it — the payoff would have been a
URL prefix on somebody else's fixtures, and the cost was namespaced fragment tables, prefixed
patterns and two merged intent manifests.

**What it reads.** Everything, already in memory, by the time a request is served:

| What it shows                                               | Where it already is                           |
| ----------------------------------------------------------- | --------------------------------------------- |
| Every route, its slots, delivery, cache class, live regions | `app.routes[].plan`                           |
| Every fragment's reads, holes, wire forms, sealed version   | `app.compiled.fragments`                      |
| Why this key — which read put `identity` in it              | `resolveKey().reason`, written for `weft why` |
| The intent manifest, id to module and export                | `app.intents.entries`                         |
| Every revved asset and its bytes                            | `app.assets.manifest`                         |
| Which stylesheet each page links                            | `app.routes[].css`                            |

**What it is.** `weft routes` and `weft why` as pages, plus the byte report, behind
`defineConfig({ devtools: true })` and dev-only. One framework-owned route reading `App`. No
second compile, no namespacing, no merged manifests.

**Why it is not the inspector.** A framework that bundled its own demo could not be byte-measured
without it, and this repository has a budget gate that would then be measuring the wrong thing.
The inspector stays a separate package you install and run; devtools ships with the framework
because it is about the framework rather than about a demonstration of it.

### 2. Instant navigation, and what is already prepared for it

The hard primitive exists and is tested. The thing that would compose it into "navigate and
it is already there" does not.

**What is available.** Three layers of preparation, and they cover more than assets.

- **Bytes.** 103 Early Hints (`kernel/src/hints.ts`), `PreloadLink` carrying `preload` and
  `modulepreload`, fed by `AssetPort.criticalFor(route)` and `chunksFor(route)`. This is the
  CSS-and-JS layer, and it is the least interesting part.
- **Templates.** The `WARM` frame asks the server to push `TPL` for versions the client does
  not hold, and the resident store (`client/src/resident.ts`, IndexedDB) keeps them across
  visits. The structure of a page you have not visited can be resident before you go there,
  so adoption on arrival costs only bindings.
- **Data, resolved and unpainted.** The real one. An epoch is exactly "fully fetched, fully
  resolved, painting nothing": any number of staged epochs coexist with `live`, and one
  `COMMIT` flips every slot staged in one of them at once. Prefetch being unable to disturb
  the present falls out of that rather than being built, which is the design's own argument
  for separating data currency from view currency. The client frame router honours it —
  a `DELTA` carrying an `epoch` header performs zero DOM writes, and a region's base
  deliberately does not advance until the commit paints it, with a test asserting exactly
  that nothing is written.

**What is missing.**

- **Navigation itself.** Phase 3's stated gap. Nothing intercepts a link, requests the target
  route's slots under an epoch, and commits on click. `NAV` (0x1d) is a declared frame code
  with no implementation. Regions are keyed by slot on the current page, so there is no notion
  of a staged _route_: tomorrow's prices can be staged into today's page, a different page
  cannot.
- **Knowing a route's slot set before arriving there.** Lazy plan extension is phase 7 and not
  started. Without it there is nothing to ask for.
- **Off-main-thread rendering, server side.** `ExecutorPort` declares `pool`, `isolate`,
  `binding` and `svc`; `inline`, `deferred` and `client` are implemented, and `deferred` is
  honest about being a fresh macrotask preemptible at await points rather than a worker
  thread. That is why `.budget({ cpu })` is advisory on it. See the worker-pool item below.
- **Off-main-thread rendering, client side.** Nothing runs in a worker. `applyDelta` writes the
  DOM and cannot leave the main thread by nature; what could be prepared off-thread — parsing
  a `TPL`, resolving derived values — is not.

**What it would take.** A navigation module on the client that, on hover or viewport entry,
sends `WARM` for the target's templates and a `REFRESH` scoped to the target route under a
fresh epoch, then commits that epoch on click. The transport exists now and the epoch
semantics exist; what is missing is a route-scoped staging model and something that knows a
route's slot set before arrival. So: real, and blocked on phase 7's discovery rather than on
the transport.

### 3. L0: fragments that read nothing

A fragment classified `static` could be resolved at build time and served by a CDN with the
kernel never invoked — the fastest tier by a wide margin, and free. Today it renders and caches
like anything else, which means the cheapest thing in the design is not implemented.

### 4. Plans from a profile

Plans are generated now — from a folder convention, which is what `weft build` writes to
`routes.json` and what makes placement diffable in review rather than authored. What is still
missing is the other half of phase 8: a plan generated from _measurement_. `weft profile` does
not exist, so nothing observes which slots are worth speculating, which chunks belong together, or
which templates deserve a V8 compile hint.

The convention was the harder half and it came first for the reason item 1 used to give: a
scaffold whose generated project still contained a hand-written plan and a hand-written bindings
object would have hidden nothing.

### 5. Slots inside components

`<Widget>content</Widget>` is `E_COMPONENT_CHILDREN_UNSUPPORTED`. A component takes props only.
Children need a slot mechanism inside a nested template, which is a different problem from the
streaming `slot` hole and should not reuse it by accident.

### 6. Components inside list rows

`E_COMPONENT_IN_LIST`. A row is its own template and cannot carry an instance today.

### 7. iOS WebKit on a real device

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

**Where it is.** Built, as `@weft/inspector` — thirty-four stations, each a route file under
`app/routes/s/`, served by `pnpm inspect`. It is a weft application, which was the point: if the
convention could not express the framework's own inspector, that would be worth knowing.

It is a separate package from `demo/` because it is a separate thing. The demo is five shapes of
page and depends on `weft` alone, so it cannot reach past the front door even by accident — which
is what makes it useful, since a page there needing something means the front door is missing it.
The inspector imports `@weft/kernel`, `@weft/plan`, `@weft/adapters` and `@weft/warp` directly,
because taking those apart is its job.

What remains is on the list above as item 1: the inspector demonstrates mechanisms with fixtures of
its own, and it is not devtools pointed at your application.

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

The stations are built and the showcases are built. The docs site and its playground depend on
neither and can start now — the compiler already has no Node dependency in its hot path, and only
`compileFiles` needs a virtual file system.

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
