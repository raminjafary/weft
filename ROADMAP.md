# Roadmap

What is built is described in [`README.md`](README.md) and the specs under
[`spec/`](spec/). This file is only what is not built, in the order it makes sense to build
it, with the reason each item is where it is.

Two rules carry over from phase zero and apply to everything below. A claim that is not
measured is not made. A capability that does not exist is refused with a named error rather
than approximated.

---

## Near term — the runtime the design describes

### 1. Runtime cache key resolution

`packages/kernel/src/cache.ts`. The compiler records _which_ reads taint a fragment and
derives its class, `Vary`, key components and flag axes. Nothing turns those into an actual
key at request time. This is the last piece that makes effect inference load-bearing rather
than descriptive, and everything about caching waits behind it.

Design is already written in [`spec/compiler/effects.md`](spec/compiler/effects.md).

### 2. Cache policy declarations

`.cache('public' | 'private', { ttl })` on a fragment, validated against what the compiler
inferred. The design promises a specific build error — _a `.cache('public')` declaration on
a slot that reads identity is a build error naming the read that caused it_ — and there is
currently nothing for `requiresTtl` to contradict.

Depends on nothing; can run in parallel with 1.

### 3. Effect writes and invalidation

`EffectSet.writes` and `.envelope` are empty because invalidation happens in intents and API
routes, and neither exists. Needs the request state machine below.

### 4. The two-phase envelope

`ctx.setCookie()`, `ctx.status()`, `ctx.redirect()` — separated from the render phase, so a
fragment cannot mutate the response while producing markup. `E_ENVELOPE_IN_RENDER` already
exists and fires; the phase it should be legal in does not.

### 5. Slots inside components

`<Widget>content</Widget>` is `E_COMPONENT_CHILDREN_UNSUPPORTED`. A component takes props
only. Children need a slot mechanism inside a nested template, which is a different problem
from the streaming `slot` hole and should not reuse it by accident.

### 6. Components inside list rows

`E_COMPONENT_IN_LIST`. A row is its own template and cannot carry an instance today. Worth
doing once component composition has been used enough to know what it costs.

### 7. Routing and the request state machine

No routing, no plan system, no epochs, no navigation, no form negotiation, no intent
transport. This is the largest single body of unbuilt work and the point at which the
project stops being a set of verified mechanisms and becomes a framework.

### 8. iOS WebKit on a real device

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
| Reference  | Every error code with the source that triggers it and the fix; the authoring surface; `ctx` in full                                                             |
| The IR     | The document, hole by hole, generated from `spec/ir/template-ir-2.md` and checked against the real emitter                                                      |
| Playground | The editor described below                                                                                                                                      |
| Findings   | `spec/FINDINGS.md` rendered, including the reversals                                                                                                            |

### The playground

An editor pane, and tabs over the result: **HTML**, **IR**, **wire bytes**, **effects**,
**errors**.

- The compiler runs in the browser. It is Oxc plus AST walks and already has no Node
  dependency in the hot path; the file reading in `compileFiles` needs a virtual file
  system to work against instead.
- Multiple files, because cross-module composition is a headline feature and cannot be
  shown in one buffer. A file tree with two or three tabs is enough.
- The **errors** tab is a first-class view, not a footer. Every refusal in the reference
  section links to a playground URL that reproduces it. A compiler whose value is what it
  refuses has to make refusal legible.
- The **effects** tab shows the inferred read set, the derived cache class, the `Vary`
  header, the key components, and — once contagion is visible — which instances were
  isolated and why.
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
| **The wire forms**      | `html`, `bundle`, `split`, `patch`, `delta`                | A form picker and a byte counter, with brotli sizes; the equivalence check running live                                        |
| **Deltas**              | One changed value becoming one DOM write                   | Edit any value; a highlight on exactly the nodes that were written                                                             |
| **Controls**            | A `prop` binding surviving a user's edit                   | Type into the input, then push a new value; an attribute-only mode to show the bug it fixes                                    |
| **Escaping**            | Escape classes, including `trusted-raw` and its provenance | Paste markup into a value and watch where it is and is not escaped                                                             |
| **Warp**                | `WARP`/`SHELL`/`TPL` frames in the document                | A frame inspector; a switch for a cold visit against a warm one                                                                |
| **Residency**           | Repeat visits with templates already held                  | A "forget everything" button; boot path timing for both states                                                                 |
| **Negotiation**         | A client that speaks an older IR                           | A version picker; watch forms drop and `html` survive                                                                          |
| **Byte budgets**        | The runtime measured against its ceiling                   | Per-entry breakdown, updated from the real bundle                                                                              |

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

The demo depends on the runtime being real, so it lands **after** cache key resolution and
policy declarations, and its caching and negotiation stations depend on the request state
machine. The docs site and its playground depend on none of that and can start immediately.

---

## Deliberately not planned

- **A virtual DOM, or a diffing renderer.** The delta form addresses holes directly and is
  20–93× cheaper than the parse it replaces. There is nothing to reconcile.
- **A `data` wire form.** Cut in IR 2.0.0 after measurement: 1% smaller after brotli and
  1.07–1.33× slower to apply than `html`. See [`spec/FINDINGS.md`](spec/FINDINGS.md).
- **Escape elision as a throughput claim.** Kept for correctness and for native codec
  boundaries. Measured at nothing.
- **Zero-JavaScript out-of-order streaming.** Not possible: slot assignment needs a host
  that is still open, and keeping it open is in-order streaming. The 329-byte filler is the
  price of fastest-first, not a gap to close.
