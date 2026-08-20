# Adoption, and how a value is addressed

The claim this exists to test: **startup is a function of how many bindings a fragment
has, not how many components it has.** Solid executes every component once on hydration.
React executes on hydration and again on interaction. Adoption executes none — it walks
the DOM the HTML parser already built and records where each value lives.

Reference implementation in `packages/client`, exercised in every engine by
`node packages/bench/src/cli.ts client`.

## The pass

1. **Collect markers.** One `TreeWalker` over comment nodes, in document order, skipping
   the subtrees of list holes because each row is its own template instance with its own
   markers.
2. **Resolve holes.** Element paths are followed by index; text holes take the node after
   their marker, or the element's only text child when the compiler emitted no marker.
3. **Bind.** Every wiring entry resolves its _own_ address and subscribes to its signal.
   Events add a listener that reports an intent id.

No component code runs, nothing is re-rendered, and the markup is never re-parsed.

## Addressing, in full

Three rules, and each exists because a simpler one is wrong.

**Element paths, not node paths.** A path indexes `children`, not `childNodes`, from a
container whose element children are the template's top-level nodes. Text nodes come and
go with the values — an empty interpolation leaves none at all — so any path that counts
child nodes is wrong for a value set the compiler never saw. A single root element is at
`[0]`, exactly as it would be inside a fragment, so the two cases address alike.

**Markers for text.** Adjacent static and dynamic text merge into one text node when the
browser parses HTML, so a dynamic run is not addressable on its own. The compiler emits
`<!>` before it, and after it when static text follows, and the hole carries that
marker's ordinal. A hole that is its element's only text child needs neither.

**A row is addressed from itself.** A list hole's rows share one parent, so a row cannot
be found by an index fixed at compile time. Each row element is adopted as its own
template instance with `origin: 'element'`, which is why the compiler refuses a row whose
root is a fragment — the parent's children could not be divided into rows.

## What the checks caught

The conformance suite is not decoration. Two of its checks exist because they failed:

- **One value can occupy several holes.** A quantity is an input's value, an output's
  text, and a button's disabled flag. The first implementation kept one target per
  binding, so a write reached only the last of the three. The `quantity` fixture and the
  "a signal write reaches the DOM through the wiring table" check exist to keep that
  fixed.
- **A template with no wiring measures an empty loop.** The signal-write benchmark
  originally ran against a template whose wiring table was empty, so `set()` updated a
  number and touched no DOM — a number that looked excellent and meant nothing. The write
  axis now reports nothing at all when a template wires nothing.

Comparisons are made against the DOM, never against `innerHTML`: a marker written as
`<!>` serialises back as `<!---->`, so string equality would compare serialisation syntax
rather than the tree the browser ended up with.

## Measured, on one machine

50-row region, ~200 bindings, p50, per engine.

|                                  | Chromium  | Firefox   | WebKit    |
| -------------------------------- | --------- | --------- | --------- |
| Adopt the region                 | 0.047 ms  | 0.095 ms  | 0.040 ms  |
| Parse the same markup            | 0.076 ms  | 0.060 ms  | 0.140 ms  |
| Apply a 12-path delta surgically | 0.0017 ms | 0.0029 ms | 0.0015 ms |
| One signal write to one node     | 0.29 µs   | 1.7 µs    | 0.71 µs   |

Adoption costs about what parsing the region costs — less in Chromium and WebKit, more in
Firefox — which is the honest reading of "startup is cheap": it is cheap because it is
proportional to bindings, not because it is free.

The delta figure is the one that changed a conclusion. Before this runtime existed the
harness measured a delta by re-projecting the whole region, and reported it _worse_ than
sending markup. Applied as designed it is 20-93× cheaper than the parse it replaces,
which is what the form was for.

## Not built yet

- Nothing computes. A signal writes to the nodes it is bound to; there are no derived
  values, and the compiler refuses `{n() * 2}` for that reason.
- Nothing resumes. Adoption assumes the templates are already in hand, so the resident
  set, `TPL` frames, and version negotiation are not exercised here.
- An `input` binding sets the attribute, not the property, so a user's edit is not
  reconciled. The IR has a `prop` op for this and the runtime does not honour it yet.
- No comparison against React Router 7 hydration, which would need a client build the
  benchmark app does not have. The parse column is the honest neighbour instead.

## Residency, and what a repeat visit actually saves

A returning visitor is supposed to do no wiring construction, because a wiring table is
content-addressed by template version and can simply be kept. That is now measured rather
than asserted, and the measurement is also Warp's first end-to-end run: the document
carries the first frames as binary, and a `TPL` frame is sent only for a template the
client does not already hold.

How a client says what it holds: a `weft-resident` cookie carrying an 8-character prefix
of each held version. The uplink cannot be a frame here, because the initial document
request happens before any channel exists. The prefix is a compromise — the design calls
for something probabilistic and bucketed, and this is not that yet; a precise list of held
templates is an identifying surface. Sending nothing at all is always allowed, and costs
exactly one thing: every visit is a first visit.

Storage is IndexedDB, not a service worker. WKWebView gates service workers behind
app-bound domains, so a generic iOS webview does not have them, and that is the traffic
where a repeat-visit gain would matter most. Where IndexedDB is unavailable too the store
degrades to memory and the claim degrades with it, honestly: the reported figure carries
the storage tier next to it.

50-row region, p50 of the boot path, per engine:

|                | Chromium    | Firefox | WebKit  |
| -------------- | ----------- | ------- | ------- |
| First visit    | 2.50 ms     | 6.00 ms | 3.00 ms |
| Repeat visit   | 0.70 ms     | 3.00 ms | 1.00 ms |
| Protocol bytes | 1,124 → 132 | same    | same    |
| `TPL` frames   | 2 → 0       | same    | same    |

Decomposed on Chromium, first visit against repeat: decode 0.40 → 0.10, open and read the
resident set 1.20 → 0.30, store what arrived 0.40 → 0, adopt 0.50 → 0.20.

### The claim needs one correction

"Zero wiring construction" is true and it is not the same as zero startup work. What a
repeat visit skips is receiving, parsing, and storing templates — 2 frames, ~1 KB, and the
IndexedDB writes. What it still pays is **adoption**, because the DOM in front of it is
new every time and the bindings have to be found again. Adoption is per-visit by nature;
only the table it builds from is cached.

Firefox and WebKit report `performance.now()` in far coarser steps than Chromium, so their
figures here are quantised to about a millisecond. The ratios are directional; the
protocol-byte counts are exact.

### Not measured

Time to the interactive mark is reported alongside but is not the headline, because it is
dominated by fetching an unbundled runtime with caching switched off — seven module
requests that no real deployment would make. Caching was disabled deliberately, so that a
repeat visit could not be flattered by the HTTP cache holding the runtime; the cost is
that the absolute number means little. A bundled runtime with a byte budget is the thing
that would make it meaningful.
