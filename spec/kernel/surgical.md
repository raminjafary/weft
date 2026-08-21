# Surgical updates without a stateful server

Phoenix LiveView is the strongest prior art in this whole design, and the one thing it
structurally cannot do defines the opportunity. LiveView holds the previous render in a
process per connected user, so a diff is computed per connection and can never be shared. Ten
thousand users watching one price list produce ten thousand identical diffs in ten thousand
processes.

Keep the render state on the client instead. The client names the base render it holds; the
server recovers that base from the store, recomputes, diffs, and memoizes the result under the
transition. Any stateless isolate anywhere can serve it.

## The flow

```
client →  HELD    s12=a91f-abc123        // template a91f, base render abc123
          REFRESH s12 form=auto

server:  1. recover base abc123 through StorePort            base:a91f:abc123
         2. recompute
         3. diff dynamics → {total:"12,400 IQD"}
         4. memoize under the transition                     delta:a91f:abc123->def456
         5. record the new base                              base:a91f:def456

server →  DELTA   s12 base=abc123 next=def456 {total:"12,400 IQD"}

client:  the wiring table says total → a text node. one write.
         no diffing, no template execution, no vdom.
```

`surgicalRefresh()` is that, and `packages/kernel/test/refresh.test.ts` runs it end to end.

## Why the shared delta is the point

The delta is a pure function of two content-addressed states, so it is cacheable by exactly
the machinery that already exists — no new subsystem. The second client making the same
transition gets `memoized: true` and pays a store read. The ten-thousandth pays a store read.

This is the largest efficiency argument for content-addressing the whole design, and it is
unavailable to any framework holding render state per connection.

## The ladder, and a correction to the design

The design's degradation ladder has three rungs: base missing → send `data`; template not
resident → send `html`. **This repository has two**, because the `data` form was cut in IR
2.0.0 after measurement — 1% smaller after brotli and 1.07–1.33× slower to apply than `html`.
See `spec/FINDINGS.md`.

So a client that holds the template but whose base the server cannot recover falls straight to
`html` rather than to a projected value set. `selectForm()` implements it:

| Resident | Base recovered | `delta` derivable | Result                                 |
| -------- | -------------- | ----------------- | -------------------------------------- |
| yes      | yes            | yes               | `delta`                                |
| yes      | yes            | no (slot hole)    | `html`                                 |
| yes      | no             | —                 | `html`, or the declared fallback       |
| no       | —              | —                 | `bundle` if RTT ≥ 100 ms, else `split` |
| —        | —              | —                 | `html`, always available               |

Two rules hold throughout. A form the client did not accept at negotiation is never selected.
A form the template cannot serve is never selected — and `derivableForms()` already refuses
`delta` for a template with a `slot` hole or an isolated instance, because a hole this render
does not fill is not projectable from values the parent holds.

Every step degrades, which is what makes this deployable rather than clever. The fast path is
an optimisation over a correct slow path, never a replacement for it.

## Push invalidation, travelling the other way

`StorePort.invalidate(tags)` returns the keys it dropped. `createStaleRegistry()` maps
connection → slot → key, and `staleFor(dropped, reason)` turns those keys into `STALE` frames
for exactly the connections holding them.

```
STALE  s12 reason=tag:cart:42
```

The client then decides: refresh now, on next focus, or never. That is push invalidation of
server-rendered regions without turning the application into a realtime app.

## What this does not do yet

- **No transport.** `HELD`, `REFRESH` and `STALE` are parsed, produced and tested as frames.
  Nothing carries them over a live connection, because there is no Warp transport binding.
- **No incremental recompute.** Step 2 re-runs the whole fragment. The design's three
  memoisation levels — fragment, derived value, template segment — exist only at the fragment
  level, which is `StorePort` and was already there.
- **No `patch` form.** It is in `derivableForms()` and no encoder produces it.
- **Base renders are stored unbounded.** They are tagged `tpl:<version>` so a template change
  can clear them, but nothing expires an old base, and a real deployment needs a TTL here.
- **The delta is not served from a CDN.** It is cacheable by construction and only ever read
  from `StorePort`.
