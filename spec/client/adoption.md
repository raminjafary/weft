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
3. **Bind.** Every wiring entry resolves its *own* address and subscribes to its signal.
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

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Adopt the region | 0.047 ms | 0.095 ms | 0.040 ms |
| Parse the same markup | 0.076 ms | 0.060 ms | 0.140 ms |
| Apply a 12-path delta surgically | 0.0017 ms | 0.0029 ms | 0.0015 ms |
| One signal write to one node | 0.29 µs | 1.7 µs | 0.71 µs |

Adoption costs about what parsing the region costs — less in Chromium and WebKit, more in
Firefox — which is the honest reading of "startup is cheap": it is cheap because it is
proportional to bindings, not because it is free.

The delta figure is the one that changed a conclusion. Before this runtime existed the
harness measured a delta by re-projecting the whole region, and reported it *worse* than
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
