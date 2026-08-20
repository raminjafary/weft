# Template IR, version 2

`weft.template-ir/2` — the compiler's output for one template. Reference implementation
in `packages/ir`, conformance tests in `packages/ir/test`.

A template compiles to constant UTF-8 byte segments with typed holes between them.
Rendering is therefore a copy of already-encoded bytes plus whatever escaping the
compiler could not prove unnecessary, and it is the same operation on the server (the
`html` form) and on the client (the `data` form). That identity is the entire basis for
negotiating the wire form of a fragment at runtime.

Major 2 is smaller than major 1 by one form. See [the changelog](../VERSIONING.md) for
why `data` was cut; the short version is that measurement did not support it.

## Document

```jsonc
{
  "spec": "weft.template-ir/2",
  "irVersion": "2.0.0",
  "id": "app/routes/cart#lines",     // authoring identity, stable across edits
  "version": "9f2c…",                 // content address, 32 lowercase hex (SHA-256/128)
  "encoding": "base64",
  "segments": ["PHVsPg==", "…"],      // constant bytes, already UTF-8
  "holes": [ /* see below */ ],
  "wiring": [ /* see below */ ],
  "signals": [{ "id": "qty", "type": "number", "init": 1 }],
  "forms": ["html", "bundle", "split", "patch", "delta"],
  "effects": { "reads": [], "writes": [], "envelope": [], "residency": "server" }
}
```

### Invariants

| Rule | Error |
| --- | --- |
| `segments.length === holes.length + 1` — rendering interleaves them | `E_SEGMENT_COUNT` |
| `holes[i].index === i` | `E_HOLE_INDEX` |
| An attribute hole names its attribute | `E_HOLE_ATTR` |
| `escape: "trusted-raw"` names the source that vouched for it | `E_RAW_UNVOUCHED` |
| A wiring entry's binding is a hole or a declared signal, except on `event` ops | `E_WIRING_UNKNOWN_BINDING` |
| `anchor` appears only on a `text` op, and is a non-negative ordinal | `E_ANCHOR_OP`, `E_ANCHOR_SHAPE` |
| An event names an intent, never server code | `E_WIRING_INTENT` |
| `nested` appears only on a `list` hole, and is a sealed version | `E_NESTED_KIND`, `E_NESTED_SHAPE` |
| Declared forms are derivable from the holes | `E_FORM_UNPROVABLE` |
| `html` is always offered | `E_FORM_FLOOR` |
| `version` addresses the content it claims to | `E_VERSION_MISMATCH` |

## Holes

```ts
{ index, kind, escape, binding, path, attr?, provenance?, nested? }
```

| kind | Position | Renders |
| --- | --- | --- |
| `text` | Between nodes or inside an element | the escaped value |
| `attr` | Inside an attribute value | the escaped value, quote-escaped |
| `attr-bool` | Where an attribute name would go | the name if truthy, nothing otherwise |
| `attr-presence` | Where a whole `name="value"` pair would go | the pair, or nothing |
| `list` | Between nodes | each item, projected through `nested` if named |
| `node` | Between nodes | a pre-rendered subtree |
| `slot` | A streaming hole | **nothing** — the content arrives in a later frame |

Where these come from in source, and every construct the compiler refuses, is in
[the compiler's supported subset](../compiler/supported-subset.md).

`escape` is the compiler's escape-elision decision: `escape` escapes, `proven-safe`
skips because the value's type makes escaping a no-op, `trusted-raw` skips and must say
who vouched. The renderer additionally scans a value it was told to escape and skips
the work when the scan proves it unnecessary, so elision that the compiler missed still
costs nothing at runtime.

## Wiring table

```ts
{ path, op, binding, attr?, event?, intent? }
```

`path` is a list of child indices from the fragment root. The client adopts existing
DOM by position rather than executing component code, which is what makes startup O(1)
in component count rather than O(n). `op: "event"` must carry `intent` — the client
names an intent id, never a server function, so renaming an export does not change the
wire and a stale client gets a clean rejection instead of a silent mismatch.

## Content addressing

`version` is SHA-256 over a canonical fingerprint, truncated to 128 bits. The
fingerprint covers `spec`, `irVersion`, `id`, holes, wiring, signals, forms, and every
segment with its length — and deliberately **excludes `meta`**, so editing a comment
does not invalidate every resident client's copy.

Template versions are cache-key inputs, compression-dictionary ids, and the thing a
client claims to hold in `RESIDENT`, so they get a real digest. Base-render ids, used
only to recover the base a `delta` is computed against, use a fast 64-bit hash: a
collision there means the base cannot be recovered and the region is re-sent as `html`,
which is a performance event and not a correctness one.

## Which forms a template can serve

Derived, never declared by hand. `html`, `bundle`, `split`, and `patch` are always
available. `delta` additionally requires every hole to be value-projectable, which a
structural `slot` hole is not — declaring it anyway is `E_FORM_UNPROVABLE`.

## Payloads

```jsonc
{ "spec": "weft.payload/2", "form": "delta", "tpl": "9f2c…", "base": "a1b2…",
  "changed": { "rows[3].qty": 4 } }
```

A delta is keyed by value path, so changing one row of a list costs one entry. A change
in list *length* is structural and sends the list whole — a diff that tried to be clever
about insertions would have to reason about identity, which is the case that is known to
go wrong. Applying a delta to its base and rendering must produce bytes identical to
rendering the new values directly; that check runs in the harness for every scenario.

### Known gap: a delta cannot yet be applied surgically

A delta's whole justification is writing only what changed, and today only *wired*
bindings — signal reads — carry addressing. A value that came from the server has a hole
with an element `path` but no anchor, so a client cannot locate its text node and has to
re-project the whole region. The measured client cost of `delta` reflects that
re-projection, not the design's intent.

Closing this means putting anchors on holes rather than only on wiring entries, which is
an additive change and therefore a minor. It is deliberately not done here: the client
runtime that would consume it does not exist yet, and inventing addressing that nothing
reads is how a format acquires fields nobody honours.
