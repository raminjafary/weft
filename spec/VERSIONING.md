# Versioning contract

Phase zero ships two versioned artifacts before it ships a framework, because a wire
format and a compiler output cannot be versioned retroactively. Adding a version field
later means every client already in the field is unversioned.

| Spec             | Id                   | Version | Reference implementation |
| ---------------- | -------------------- | ------- | ------------------------ |
| Template IR      | `weft.template-ir/2` | 2.5.0   | `packages/ir`            |
| Payloads (delta) | `weft.payload/2`     | 2.5.0   | `packages/ir`            |
| Warp frames      | `weft.warp/1`        | 1.2.0   | `packages/warp`          |

## What each version component means

**Major** is a wire break. A reader that speaks major _N_ must refuse a document or a
stream announcing major _M ≠ N_, with a named error rather than a best-effort parse.
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

### Warp 1.2.0 — ACK travels down

`ACK` was declared at `0x06`, in the up range, and used for the result of an intent — which
travels from the server to the client. The direction had been decided by where the name sat in
the table, next to `INTENT`, rather than by which way the bytes go.

Nothing static caught it. `codec.test.ts` had a gate asserting every frame's declared direction
agrees with its code range, and that gate passed: the code and the direction agreed with each
other, and neither agreed with what the frame was for. What caught it was the first intent over
a real socket, where the decoder rejected the server's own answer as `E_WRONG_DIRECTION`.

The design pairs `INTENT` with `ACK`, so the name stays and the code moves to `0x22`, down. A
client-to-server acknowledgement had no stated meaning, and nothing had ever emitted `0x06`, so
no reader can be holding one — which is what makes this a minor rather than a break.

**`0x06` is retired, not freed.** `RETIRED` in `frames.ts` records it and a test refuses to let
any future frame take the code. A code reused for a second purpose is the one version mistake a
length prefix cannot protect a reader from, because the frame parses cleanly and means
something else.

### Warp 1.1.0 — REDIRECT and COOKIE

Two frames for what a sealed response can still carry in-band, which is layer three of the
envelope design. `REDIRECT` (`0x20`) is acted on by the client and degrades to a meta refresh
with no JavaScript. `COOKIE` (`0x21`) carries non-`HttpOnly` values only.

Additive and genuinely forward-compatible, unlike the IR's last two minors: the frame
vocabulary is length-prefixed, so a reader that does not know a code skips it and reports it as
`UNKNOWN` rather than misinterpreting it. Adding frame types is explicitly allowed; redefining
`SHELL`, `SLOT`, `DATA` or `DELTA` is not, because they are the shared language that makes tier
decomposition, form negotiation and remote fragments the same mechanism.

Neither frame is a substitute for the real thing, and the spec says so where a reader will meet
it: a crawler will not follow a `REDIRECT` frame, and `HttpOnly` is precisely the property a
body cannot grant.

### Template IR 2.5.0 — children

Two additions, and they are one feature. A `children` hole is the place a component keeps for
the markup its caller wrote; `children` on a component hole is the sealed template holding that
markup for this call site. The child names the place and never the content, which is what lets
one `<Card/>` serve five call sites out of one sealed template.

The content is sealed in the **caller's** binding namespace rather than projected through props.
That is the decision the rest follows from: children read the caller's props and the caller's
signals, so `{note}` inside a `<Card>` is the same `note` the caller interpolates anywhere else,
a delta addresses it by the caller's name for it, and the two templates share one derived table
so their ids cannot collide. A projection would have needed a name for every binding the markup
happened to touch, which is a contract the call site never wrote down.

Because a component may hand its own children on to another one, the fill is a **frame** rather
than a field: `{children}` means the markup of the frame that was open where it was written, and
`outer` is that frame's caller. `<Card><Panel>{children}</Panel></Card>` therefore means Card's
caller's markup, which is the only reading that makes a wrapper composable.

A `children` hole must be the only child of its element, exactly as a list must. Both rules buy
the same thing: the content owns the element's child positions outright, so a call site cannot
move an address the shared child template was compiled against.

Additive, and — like the component hole and `isolated` before it — **not silently
forward-compatible**. An older reader meeting an unknown hole kind has no way to render it, and
one meeting an unknown field on a component hole would render the instance with an empty middle.
A version disagreement costs the resident forms and falls back to `html`, which is the
protection every other mismatch gets. In practice the protection is stronger than the rule: a
template version is a hash of its content, so a client that has not seen this template does not
claim to hold it and is sent markup.

The registered migration from 2.4.0 restamps and changes nothing else, because a 2.4.0 document
simply has neither field.

### Template IR 2.4.0 — isolated instances

`isolated` on a component hole means the parent does not render that instance: it is its
own cache unit, and the kernel composes the two at stream time the way it fills a slot. The
compiler sets it when a child is private and its caller is not, so that one fragment
reading identity does not make a whole shared route private.

Like the component hole itself, this is additive but not silently forward-compatible: a
reader that ignores the flag would inline private bytes into a shared entry. A version
disagreement costs the resident forms and falls back to `html`, which is the protection
that matters here.

### Template IR 2.3.0 — the component hole

A `component` hole renders a sealed child template through a projection: `props` maps each
child prop name to the parent binding that supplies it. Nothing is inlined, so one
`<Badge/>` used five times is one template used five times, and a resident client stores
one copy.

An instance occupies exactly one element position in the parent, which is why a component
must render a single root element — the same rule a list row already lives under, and for
the same reason: sibling positions must not move with the content.

A delta addresses an instance by name, the way it addresses a row by index — `c0.label`.
That is what lets a value computed inside a component reach the DOM without the parent
knowing anything about it. Two rules travel across the boundary with it: a prop the caller
fed from a signal is client-owned on the other side, so a value the child derives from it
is recomputed rather than sent; and a component's reads are its caller's reads, so a child
that reads identity makes its caller private.

This is the one additive change that is not silently forward-compatible. An older reader
meeting an unknown hole kind has no way to render it, so a version disagreement here costs
the resident forms and falls back to `html` — the same protection every other mismatch
gets, rather than a best-effort projection of a hole it does not understand.

### Template IR 2.2.0 — the derived table

`derived` carries values computed from other bindings, encoded as an expression tree
rather than compiled to a function. The server evaluates it to render, and the client
evaluates the same tree inside a computed, which is what makes `{qty() * 100}` reactive
without shipping a component. The operator set is closed and every operator in it is
total over JSON values, so an evaluator on either side is a switch with no escape hatch —
an unknown operator is `E_DERIVED_EXPR` at validation, not a surprise at runtime.

Two rules split ownership. A derived value that reaches a signal is the client's: the
server renders it once from the signal's initial value and never speaks about it again.
Everything else is the server's, and rides in the delta like any other value. A delta
that carried a client-owned derived value would overwrite whatever the user had already
done to it.

Declaration order is evaluation order, so one derived value may read another declared
before it and never one declared after (`E_DERIVED_FORWARD_READ`). That is what keeps the
table acyclic without a graph walk.

Additive, so a minor: a 2.1.0 document simply has no derived values, and the registered
migration defaults the field rather than rewriting anything.

### Template IR 2.1.0 — anchors on holes

`anchor` moved from wiring entries onto holes as well, so any consumer can locate any
text value rather than only the ones a signal writes to. A delta writes server-owned
values, and without this a client could not find them: it had to re-project the whole
region, which made the `delta` form measure _worse_ than sending markup. Applied through
per-hole addressing it is 20-93x cheaper than the parse it replaces.

Additive, so a minor: a 2.0.0 document is valid as it stands, its text holes simply carry
no anchor and fall back to the element path. The registered migration restamps the
version and changes nothing else.

Also clarified rather than changed: `path` addresses from a container whose element
children are the template's top-level nodes, so a single root element sits at `[0]` just
as it would inside a fragment. The compiler previously put it at `[]`, which made `[]`
mean the root element in one case and the container in another — an ambiguity no consumer
had yet hit because no consumer existed.

### Template IR 2.0.0 — the `data` form was cut

A form left the vocabulary, so a 1.x document is no longer valid. That is a wire break,
which means a major: `weft.template-ir/2`, and **no migration**, because a migration may
not cross a major. A 1.x document is refused with `E_SPEC_MISMATCH` rather than upgraded.

The evidence, all of it from the harness:

- **Bytes.** Raw, `data` was half the size of `html`. After brotli it was 599 bytes
  against 605 — a 1% difference, because compression already removes the template
  redundancy that `data` removed semantically.
- **Client work.** Turning a payload into DOM cost 1.16-1.33x _more_ for `data` than for
  `html` in Chromium, Firefox, and WebKit alike. Values have to be parsed and projected
  before anything can be handed to the HTML parser, and the parser is native code.
- **Redundancy.** The decisive argument is architectural rather than numeric. A `data`
  refresh into a resident template is a `delta` that has declined to diff. There is no
  regime where it is the best available form: a full-region refresh is cheaper as `html`,
  and a partial one is cheaper as `delta`.

`delta` stays. It is 16.9x smaller raw and 3.2x smaller after brotli, and nothing else in
the field offers it without a stateful process per connection.

Cutting a form is a real win and not only a simplification: form negotiation's cost is a
combinatorial correctness problem, and every form removed is a column that never has to
be differentially tested again.

### Template IR 1.1.0

Both changes came from building the compiler, which is the point of building it early.

- **Added** `anchor` on a wiring entry: the ordinal of the marker comment a text binding
  writes after. Adjacent static and dynamic text merge into a single text node when the
  browser parses HTML, so a dynamic text run is not addressable without a marker.
- **Clarified** `path` as an index into _element_ children rather than child nodes. Text
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
