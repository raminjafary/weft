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
  "irVersion": "2.4.0",
  "id": "app/routes/cart#lines", // authoring identity, stable across edits
  "version": "9f2c…", // content address, 32 lowercase hex (SHA-256/128)
  "encoding": "base64",
  "segments": ["PHVsPg==", "…"], // constant bytes, already UTF-8
  "holes": [/* see below */],
  "wiring": [/* see below */],
  "signals": [{ "id": "qty", "type": "number", "init": 1 }],
  "derived": [/* see below */],
  "forms": ["html", "bundle", "split", "patch", "delta"],
  "effects": { "reads": [], "writes": [], "envelope": [], "residency": "server" },
}
```

### Invariants

| Rule                                                                                | Error                             |
| ----------------------------------------------------------------------------------- | --------------------------------- |
| `segments.length === holes.length + 1` — rendering interleaves them                 | `E_SEGMENT_COUNT`                 |
| `holes[i].index === i`                                                              | `E_HOLE_INDEX`                    |
| An attribute hole names its attribute                                               | `E_HOLE_ATTR`                     |
| `escape: "trusted-raw"` names the source that vouched for it                        | `E_RAW_UNVOUCHED`                 |
| A wiring entry's binding is a hole or a declared signal, except on `event` ops      | `E_WIRING_UNKNOWN_BINDING`        |
| `anchor` appears only on a `text` op, and is a non-negative ordinal                 | `E_ANCHOR_OP`, `E_ANCHOR_SHAPE`   |
| An event names an intent, never server code                                         | `E_WIRING_INTENT`                 |
| `nested` appears only on a `list` hole, and is a sealed version                     | `E_NESTED_KIND`, `E_NESTED_SHAPE` |
| A derived value's expression is well formed and its operators are in the closed set | `E_DERIVED_EXPR`                  |
| A derived value reads nothing declared at or after itself                           | `E_DERIVED_FORWARD_READ`          |
| A derived id is declared once, and is not also a signal                             | `E_DERIVED_DUPLICATE`             |
| Declared forms are derivable from the holes                                         | `E_FORM_UNPROVABLE`               |
| `html` is always offered                                                            | `E_FORM_FLOOR`                    |
| `version` addresses the content it claims to                                        | `E_VERSION_MISMATCH`              |

## Holes

```ts
{ index, kind, escape, binding, path, attr?, provenance?, nested?, props?, children?, isolated? }
```

| kind            | Position                                   | Renders                                              |
| --------------- | ------------------------------------------ | ---------------------------------------------------- |
| `text`          | Between nodes or inside an element         | the escaped value                                    |
| `attr`          | Inside an attribute value                  | the escaped value, quote-escaped                     |
| `attr-bool`     | Where an attribute name would go           | the name if truthy, nothing otherwise                |
| `attr-presence` | Where a whole `name="value"` pair would go | the pair, or nothing                                 |
| `list`          | Between nodes                              | each item, projected through `nested` if named       |
| `node`          | Between nodes                              | a pre-rendered subtree                               |
| `slot`          | A streaming hole                           | **nothing** — the content arrives in a later frame   |
| `component`     | One element position                       | a sealed child template, fed by `props`              |
| `children`      | The whole content of its element           | the markup the caller wrote between the tags         |
| `variant`       | One element position                       | a sealed nested template, when its binding is truthy |

Where these come from in source, and every construct the compiler refuses, is in
[the compiler's supported subset](../compiler/supported-subset.md).

`variant` is the one way a sealed template holds a choice of markup without its byte layout
depending on a value: the hole is always there and always costs the same, and what varies is
only whether the nested template is written into it. `{on && <A/>}` is one of these; `{on ? <A/>
: <B/>}` is two adjacent ones, over `on` and `!on`. Both shapes are sealed, both travel, and
exactly one renders — so neither the layout nor the version depends on the value, which is what
keeps the delta addressable.

`escape` is the compiler's escape-elision decision: `escape` escapes, `proven-safe`
skips because the value's type makes escaping a no-op, `trusted-raw` skips and must say
who vouched. The renderer additionally scans a value it was told to escape and skips
the work when the scan proves it unnecessary, so elision that the compiler missed still
costs nothing at runtime.

### A list row naming its own item: `rowValue` and `rowIndex`

A row's holes are normally filled from the item's fields, which is why an item has to be an
object — `names.map((n) => <li>{n}</li>)` over a `string[]` is refused, for no reason a reader of
that line would guess without this. `rowValue` records the binding when a row names the item
directly, so whatever renders the rows knows to wrap each one; absent is the fast path, same as
`rowIndex`.

`rowIndex` is absent unless the row callback names a second parameter, and absent is the fast
path too: a row that does not ask for its index is rendered against the item object with no
per-row allocation. Only a list that asks pays, which matters because the row loop is the hot
one — the feed scenario renders fifty of them per request. The index is supplied by whatever
renders the rows rather than carried in the item, because it is a fact about position, not value:
two identical items at different positions are still one row template and one cache entry.

## Wiring table

```ts
{ path, op, binding, attr?, event?, intent? }
```

`path` is a list of child indices from the fragment root. The client adopts existing
DOM by position rather than executing component code, which is what makes startup O(1)
in component count rather than O(n). `op: "event"` must carry `intent` — the client
names an intent id, never a server function, so renaming an export does not change the
wire and a stale client gets a clean rejection instead of a silent mismatch.

## Derived values

```jsonc
{
  "id": "d0",
  "expr": {
    "k": "bin",
    "op": "*",
    "a": { "k": "ref", "id": "qty" },
    "b": { "k": "lit", "v": 100 },
  },
}
```

A value computed from other bindings, encoded rather than compiled. Five node shapes —
`ref`, `lit`, `un`, `bin`, `cond` — and a closed operator set: `! - + ~` and
`+ - * / % ** < > <= >= === !== == !=`. Every one of them is total over JSON values and
free of effects, so the server's evaluator and the client's are the same switch, and a
`ref` to a binding that is not there reads as `null` rather than throwing. Half a render
is worse than a wrong number.

A `ref` may name a prop the render supplies, which the document never sees, so an unknown
read is not an error. What is an error is naming a derived value declared at or after
this one: declaration order is evaluation order, and that is what keeps the table acyclic
without a graph walk.

`cond` is `a ? b : c`, with `a ?? b` and `a || b` lowered to it — a _value_, not a shape, which
is what makes it expressible at all: a sealed template's byte layout is fixed, so
`on ? <b/> : <i/>` cannot be a hole, but `on ? 'yes' : 'no'` is one value arriving in one hole
and costs the layout nothing. There is no separate coalesce flag: `a || b` is already this node
over plain truthiness, and `a ?? b` is this node over a `!== null` test, since a `ref` to an
absent binding already reads as `null` on both sides — naming the operand twice in the tree
saves an arm in two evaluators whose byte budgets fail the build over less. Operands are
`a`/`b`/`c` rather than `test`/`then`/`else` for the same reason `bin` uses `a` and `b`: the
keys are the encoding and they travel on every frame. Evaluation is lazy in the branches — the
one not taken must not touch bindings the render never read — but `readsOf` still walks both,
because whether a value is client-owned is a property of the expression, not of one evaluation.

**Ownership follows the reads.** A derived value that reaches a signal is the client's.
The server renders it once from the signal's initial value, and a delta must never carry
it — the user may have moved it since. Everything else is the server's, resolved at
render and shipped in the delta like any other value. The compiler emits a wiring entry
for exactly the client-owned ones, so `{qty() * 100}` is reactive and `{price / 100}` is
not, without either being declared.

A delta also carries nothing the client has no hole to write into. A prop that appears
only inside an expression — `price` above — has no hole of its own, so only `d0` travels.

## Components

```jsonc
{
  "kind": "component",
  "binding": "c0",
  "path": [0, 0],
  "nested": "075b…", // the sealed child
  "props": { "tone": "t", "label": "d0" }, // child prop -> parent binding
  "children": "9c41…", // the markup this call site wrote between the tags, sealed
  "isolated": false, // when true, the parent does not render it: its own cache unit
  "escape": "trusted-raw",
  "provenance": "app/cart#Badge",
}
```

An instance is a projection, never a value. The child's value set is built by reading each
prop out of the parent's, which is why a component costs no new value plumbing: a literal
prop is a `lit` in the parent's derived table, and a computed one is an ordinary derived
entry.

The instance occupies **one element position**, so a component must render a single root
element. Without that rule the positions of every sibling after it would depend on what
the child rendered, and an element path would stop being a stable address.

A delta addresses an instance by name — `c0.label` — the way it addresses a row by index.
The path syntax is the same walk; only the step differs. Two rules cross the boundary with
the projection:

- **Ownership.** A prop the caller fed from a signal is client-owned inside the child,
  which the child cannot know on its own. A value the child derives from such a prop is
  recomputed on the client and must not be sent, exactly as if it had been derived from a
  signal directly.
- **Reads.** A component's effect set is unioned into its caller's — unless the child is
  private and the caller is not. Then the instance is `isolated`: the parent leaves a
  boundary and does not render it, the kernel fills it from a separate render, and the
  parent's entry stays shareable. One private fragment must not make a whole route private,
  and containment is a change of shape rather than an exception in the union. See
  [contagion](../compiler/effects.md).

An isolated instance costs the `delta` form on its parent, the same way a `slot` does.

## Children

```jsonc
{
  "kind": "children",
  "binding": "children",
  "path": [0, 1], // the element whose only child the markup is
  "escape": "trusted-raw",
  "provenance": "app/cart#Card",
}
```

A component that declares a `children` prop keeps a place for the markup its caller wrote and
knows nothing else about it. The content is named on the **caller's** hole, not here, because
the child template is shared: one `<Card/>` used at five call sites is one sealed template and
five contents.

The content is sealed in the **caller's binding namespace**. Nothing is renamed on the way in,
so `{note}` inside a `<Card>` is the same `note` the caller interpolates anywhere else — the
same value, the same wiring, the same delta path. The two templates therefore share one derived
table, or both would allocate `d0` for different expressions against one value set.

Filling is a **frame**, not a field: the pair of a content template and the values it reads,
plus the frame that was open where the markup was written. A component that hands its own
children on to another one — `<Card><Panel>{children}</Panel></Card>` — needs the inner
`{children}` to mean Card's caller's markup, and only a stack gives that reading.

Like a list, a `children` hole must be the **only child of its element**. A call site's content
occupies element positions inside a template that was compiled without seeing it, so the content
owns those positions outright or every sibling address after it would depend on the call site.

A `children` hole is markup from a template the client already holds, exactly as `list` and
`component` are, so it does not cost the `delta` form the way a `raw()` value does.

## Content addressing

`version` is SHA-256 over a canonical fingerprint, truncated to 128 bits. The
fingerprint covers `spec`, `irVersion`, `id`, holes, wiring, signals, derived, forms, and
every segment with its length — and deliberately **excludes `meta`**, so editing a comment
does not invalidate every resident client's copy.

Template versions are cache-key inputs, compression-dictionary ids, and the thing a
client claims to hold in `RESIDENT`, so they get a real digest. Base-render ids, used
only to recover the base a `delta` is computed against, use a fast 64-bit hash: a
collision there means the base cannot be recovered and the region is re-sent as `html`,
which is a performance event and not a correctness one.

## Which forms a template can serve

Derived, never declared by hand. `html`, `bundle` and `split` are always available.

`patch` requires every hole whose _value_ is markup — a `raw()` value — to be the only child of its
element. A raw value that is not produced an unknown number of nodes after a marker comment, and
nothing in the template says where they end, so a structural write has no boundary to address. Every
other hole is addressable, `slot` holes included: a patch never writes into a hole this render does
not fill.

`delta` additionally requires every hole to be value-projectable, which a structural `slot` hole is
not. Declaring either anyway is `E_FORM_UNPROVABLE`.

`remote` is the exception, and it is exempt rather than special-cased: the bytes are not this
deployment's, so no property of these holes could prove an equivalence about them. A region
renders on the other side of a tier boundary and answers in its own forms. What stands in for the
proof is the check on arrival — see [the composition spec](../kernel/composition.md).

## What a client is sent

A `TPL` frame carries only addressing and wiring — `{ version, holes, wiring, derived }` — never
the segments or the effect set. The segments are markup the client already holds in its DOM, and
the effects are a server concern: a client that received them would be paying bytes for a read set
it cannot act on, and would be handed a description of the server's own cache keys. `clientView(ir)`
is that projection, written once because three call sites had each been building it by hand.

## Payloads

```jsonc
{
  "spec": "weft.payload/2",
  "form": "delta",
  "tpl": "9f2c…",
  "base": "a1b2…",
  "changed": { "rows[3].qty": 4 },
}
```

A delta is keyed by value path, so changing one row of a list costs one entry. A change
in list _length_ is structural and sends the list whole — a diff that tried to be clever
about insertions would have to reason about identity, which is the case that is known to
go wrong. Applying a delta to its base and rendering must produce bytes identical to
rendering the new values directly; that check runs in the harness for every scenario.

A path walks the same structures the client adopted: `rows[3]` steps into a row, `c0` steps
into an instance, and `rows[3].c0.label` does both. Children need no step of their own — the
markup shares the caller's namespace, so a value read only inside a `<Card>` travels under the
caller's name for it.

**Where the reconstruction check stops.** A delta addresses the client's tables, and `applyDelta`
inverts those steps back into value paths when it is given the template: `c0.label` is the prop
binding behind `label`. A hole inside an instance that has no prop behind it is a value the child
_computed_ — `{amount / 100}` — and the caller's value set has no name for it at all, because
inverting it would mean inverting arithmetic. That is `E_DELTA_NOT_INVERTIBLE` rather than a
dropped entry: a reconstruction that quietly skipped a changed value would render something
plausible and wrong. The delta itself is unaffected — the client writes the value into the node
it belongs to — but the byte-equality check is not available for that template, and saying so is
better than a gate that silently covers less than it claims.

### Closed in 2.1.0: surgical application

A delta's whole justification is writing only what changed, and in 2.0.0 only _wired_
bindings — signal reads — carried addressing. A value that came from the server had a
hole with an element `path` but no anchor, so a client could not locate its text node and
had to re-project the whole region; the `delta` form measured 1.28x _worse_ than sending
markup because of it.

2.1.0 put `anchor` on holes as well as wiring entries. Applied through per-hole
addressing, a delta is 20-93x cheaper than the parse it replaces, and the harness checks
in every engine that one changed path is one DOM write.

## Rendering: two entry points, not one

`renderHole(hole, value)` renders one hole from a single value. It is not enough for a
`component`, `variant` or `children` hole — none of those has a single value to render from, so
its arms write nothing at all, correctly, because `writeTemplate` has already handled them by the
time a normal render reaches there. A caller that walks a template _itself_, rather than calling
`render`, has to use `renderHoleIn(hole, values)` instead, which is given the whole value set and
takes the same three arms `writeHole` does.

Using the wrong one is how every `<Mark/>` in a layout once rendered nothing: the component arm of
`renderHole` returned zero bytes, the shell was sent without it, and nothing anywhere refused,
because a hole that writes nothing is indistinguishable from a hole whose value was empty.

## Version history

Every step below is a minor, so an older reader accepts it and simply lacks the field; each
migration function restamps and otherwise leaves the document alone unless noted.

- **2.5.0 → 2.6.0** narrowed `forms`: `patch` is derived rather than unconditional, because a
  `raw()` value that is not its element's only child produces nodes with no boundary a structural
  write can address. A 2.5.0 document may advertise `patch` for a template that cannot serve it —
  `validate` names it `E_FORM_UNPROVABLE`, refusing the form where it is declared rather than
  declining later, in a refresh.
- **2.4.0 → 2.5.0** added the `children` hole kind and the `children` field on a component hole:
  the markup a call site wrote between the tags, sealed as its own template in the caller's
  binding namespace.
- **2.3.0 → 2.4.0** added `isolated` on a component hole: the instance is its own cache unit and
  the parent does not render it.
- **2.2.0 → 2.3.0** added the `component` hole kind, projecting a parent's values through a sealed
  child template.
- **2.1.0 → 2.2.0** added `derived`, the table of values computed from other bindings. A 2.1.0
  document simply has none, so the migration is a default rather than a rewrite.
- **2.0.0 → 2.1.0** put `anchor` on holes as well as wiring entries — see "Closed in 2.1.0" above.
  The 1.x chain went with the major, because a migration may not cross one.
