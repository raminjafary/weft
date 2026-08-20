# Versioning contract

Phase zero ships two versioned artifacts before it ships a framework, because a wire
format and a compiler output cannot be versioned retroactively. Adding a version field
later means every client already in the field is unversioned.

| Spec | Id | Version | Reference implementation |
| --- | --- | --- | --- |
| Template IR | `weft.template-ir/1` | 1.1.0 | `packages/ir` |
| Payloads (data, delta) | `weft.payload/1` | 1.1.0 | `packages/ir` |
| Warp frames | `weft.warp/1` | 1.0.0 | `packages/warp` |

## What each version component means

**Major** is a wire break. A reader that speaks major *N* must refuse a document or a
stream announcing major *M ≠ N*, with a named error rather than a best-effort parse.
`E_MAJOR_UNSUPPORTED` for the IR, `E_WARP_MAJOR` for the stream.

**Minor** is additive and forward-compatible in both directions. An older reader
accepts a newer minor, ignores the fields it does not know, and — this is the part that
is easy to get wrong — **must round-trip those fields unchanged** if it re-emits the
document. `parse()` returns them in `forward` and `stringify(ir, forward)` puts them
back. A reader that silently drops unknown fields turns a forward-compatible minor into
data loss.

**Patch** is editorial: wording, defaults that were already implied, added validation of
an invariant that was always required.

## Migrations

`registerMigration(from, to, fn)` upgrades a stored document from an older minor to the
reader's version, and `migrate()` chains them. Two rules are enforced in code:

- A migration may not cross a major (`E_MIGRATION_MAJOR`). Crossing a major is a
  translation between two formats, not an upgrade, and it belongs in a separate tool.
- A missing step is an error (`E_MIGRATION_MISSING`), never a silent pass-through. A
  document older than the reader is either upgraded deliberately or refused.

## Why the IR is versioned before the compiler exists

The compiler is expected to change. The output shape — constant byte segments, holes,
a wiring table — is the interface that resident clients, cache keys, compression
dictionaries, and the negotiated wire forms all depend on. `html` is the one form that
requires nothing resident on the client, which is why it is the fallback whenever
versions disagree: a version mismatch costs a form, never the page.

## Changelog

### Template IR 1.1.0

Both changes came from building the compiler, which is the point of building it early.

- **Added** `anchor` on a wiring entry: the ordinal of the marker comment a text binding
  writes after. Adjacent static and dynamic text merge into a single text node when the
  browser parses HTML, so a dynamic text run is not addressable without a marker.
- **Clarified** `path` as an index into *element* children rather than child nodes. Text
  nodes come and go with the values, so a node-counting path is wrong for any value set
  the compiler did not see.
- **Relaxed** the wiring rule that every entry name a resolvable binding. An `event` op
  names an intent and has no value binding; requiring one was an over-strict rule in
  1.0.0, and a validator rejecting a valid document is a spec bug. Corrected here rather
  than carried, because no reader outside this repository has ever consumed 1.0.0.

A 1.0.0 document is valid 1.1.0 as it stands, so the registered migration only restamps
the version — and it exists because a missing step is an error, never a silent pass.

## Compatibility tests are part of the spec

`packages/ir/test/version.test.ts` and `packages/warp/test/*.test.ts` are the executable
form of this document: forward minors, refused majors, unknown frame kinds skipped
intact, truncated frames reported rather than half-delivered. A change to the
compatibility rules that does not change those tests has not been made.
