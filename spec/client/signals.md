# The signal graph

`packages/client/src/signal.ts`. Three node kinds — a signal, a computed, a watcher —
one edge type, and a flush queue. It exists to serve the wiring table: a value changes,
and the nodes the server rendered it into are written, once.

## Why it was rewritten

The first version was a value and a `Set` of subscribers. That is enough to write a
signal into a DOM node and nothing more. It had no computed nodes, so the compiler had to
refuse `{n() * 2}` outright — the first thing anyone writing a real fragment hits. Adding
computeds to a `Set`-based graph without a pull phase produces the two failures every
naive reactive system has: a diamond runs its effect twice, and a computed that recomputes
to the same value still writes the DOM.

## Shape

**Edges are doubly linked in both directions.** One `Link` sits in the dependency's
subscriber list and in the subscriber's dependency list at the same time. Removing an
edge is four pointer writes with no hashing and no allocation, and a subscriber that
re-runs walks its existing links in order and reuses them rather than rebuilding a
collection. A `Set` per node allocates on every run and cannot be walked from the other
side at all, which is what a pull phase needs.

**Status is bitflags on one integer.** `MUTABLE`, `WATCHING`, `DIRTY`, `PENDING`,
`QUEUED`, `TRACKED`. A node's whole state is one machine word and a check is a mask.

**Propagation is push, then pull.** A write marks its direct subscribers `DIRTY` and
everything further downstream `PENDING`, and enqueues the watchers it reaches. `PENDING`
means "a dependency of a dependency moved" — a question, not an answer. Answering it is
the pull half, and it happens once at flush rather than once per edge crossed:
`checkDirty` walks up the pending edges recomputing only the computeds that claim to have
moved, and stops at the first one that actually did. A computed whose recompute lands on
the same value ends the propagation there, and the effect below it never runs.

## Two ways to subscribe

`effect(fn)` runs now, tracks whatever it reads, and re-runs when any of it changes. It
is the auto-tracking front door.

`subscribe(run)` is the narrow one: a watcher bound to exactly one dependency, tracking
nothing, that does **not** run on creation. Adoption wires one binding to one node and the
value is already in the DOM, so a watcher that ran on creation would rewrite what the
server just rendered. That is the whole reason the two exist separately.

## What it costs

Measured back to back on one machine against the implementation it replaced, on the
`isolated-dom-update` axis — one signal write reaching one node through the wiring table:

| Engine   | `Set` of subscribers | linked graph |
| -------- | -------------------- | ------------ |
| Chromium | 0.28 µs              | 0.31 µs      |
| Firefox  | 1.7 µs               | 1.7 µs       |
| WebKit   | 0.72 µs              | 0.74 µs      |

The one-edge case got **slower**, by roughly 7% on Chromium and 3% on WebKit. The old
code went straight from `set` to the subscriber call; this one pushes through propagate,
a queue, and a flush. The axis expects a tie and this is still a tie, but it is not free
and should not be reported as a win.

Those two columns stay as they were measured, back to back on one machine, because that is
the only way the comparison is worth anything — the `Set` implementation no longer exists
and cannot be re-run. The linked graph on its own, on the current build, is 0.52 µs on
Chromium, 1.41 µs on Firefox and 1.32 µs on WebKit. Read the pair above as the A/B it was
and this line as where the surviving half stands now; a machine, a browser version and two
years of engine work are all in the difference between them.

The runtime grew from 1,695 to 2,583 bytes brotli against a 6,144 ceiling, and a content
route from 1,096 to 1,939 against 5,120. Both figures include the derived-value evaluator
that landed with it.

What it buys shows up one step out. On the `derived` scenario, one signal write reaching a
node **through a computed** is not separable from the direct write at this sample size in
any of the three engines — the harness refuses the comparison rather than reporting a
difference inside its own noise. Laziness, diamond dedup, and dynamic dependencies came
in at no measurable per-write cost.

## Not built

- No scheduler. The flush is synchronous at the end of the outermost `batch`, or
  immediately on a write outside one. Nothing is deferred to a microtask or a frame.
- No `computed` invalidation across a delta. A delta writes DOM targets directly; a
  server-owned value is not a signal, so nothing recomputes from it.
- No cycle detection. The IR forbids a forward read in the derived table, which is where
  cycles would come from today, but a hand-built graph could still make one.
