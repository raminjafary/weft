# What the compiler lowers, and what it refuses

`packages/compiler` turns a `.tsx` fragment into the template IR. It parses with Oxc and
walks the AST — writing a JS/TS parser is not a defensible use of time, and the passes
that matter are AST walks on top of one.

The rule the prototype follows everywhere: **refuse rather than guess.** Every
unsupported construct raises a `CompileError` with a code and a source location. A
compiler that silently miscompiles a template is worse than one that stops.

## Authoring surface

```tsx
import { fragment, signal, raw } from 'weft'
import { setQuantity } from './intents.ts'

export default fragment(({ epoch, rows, total }) => (
  <>
    <ul class="lines" data-epoch={epoch}>
      {rows.map((row) => (
        <li data-sku={row.sku} onInput={setQuantity}>
          <span class="name">{row.name}</span>
        </li>
      ))}
    </ul>
    <p class="total">Total: {total} IQD</p>
  </>
))
```

No sigils, no `'use client'`, no directives. `fragment` and `signal` are ordinary
imports, and the compiler recognises them by resolving the import rather than by name.

| Construct                                     | Lowers to                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| HTML element, static attributes               | bytes in a segment                                                                  |
| `attr={expr}`                                 | an `attr` hole inside the quoted value                                              |
| `disabled={expr}` (known boolean attribute)   | an `attr-bool` hole; the name is the value                                          |
| `{expr}` between nodes                        | a `text` hole                                                                       |
| `{'literal'}`, `{42}`                         | folded into the segment — no hole at all                                            |
| `{raw(x)}`                                    | a `trusted-raw` hole whose provenance is the source text of `x`                     |
| `{rows.map((row) => …)}`                      | a `list` hole plus a nested template, sealed first so the parent names its version  |
| `{rows.map((row, i) => …)}`                   | the same, plus `rowIndex` on the hole: the position, supplied per row               |
| `onEvent={imported}`                          | a wiring `event` op carrying an intent id derived from the module and export        |
| `signal()` read                               | a hole plus a wiring op, since only a signal can change on the client               |
| `{a * 2}`, `{qty() > 9}`, `{(a + b) / 2}`     | a hole plus a `derived` entry: the expression tree, wired only if it reads a signal |
| `{on ? a : b}`, `{a ?? 'none'}`, `{a \|\| b}` | the same, through a `cond` entry: a conditional **value**, filling one hole         |
| ``{`row-${id}`}``                             | the same, lowered to a `+` chain — a template literal introduces no node of its own |
| `<slot>{fallback}</slot>`                     | a `slot` hole: the base render emits nothing and a later frame fills it             |
| `<Widget a={x} />`                            | a `component` hole: a sealed child template plus a prop-to-binding projection       |
| `<Card>…</Card>`                              | the same, plus the markup between the tags sealed as its own template               |
| `{children}` in a fragment declaring it       | a `children` hole: the place a caller's markup goes                                 |
| `<>…</>` at the root                          | a template with no wrapper element                                                  |
| `{on && <A/>}`, `{on ? <A/> : <B/>}`          | one `variant` hole per branch: each shape sealed, the binding says which renders    |

## Derived values

An arithmetic or comparison expression becomes a `derived` entry in the IR — the
expression tree, not compiled code — and a hole bound to it. The server evaluates it to
render; the client evaluates the same tree inside a computed, so `{qty() * 100}` moves
when the signal does without a component ever running.

Whether it is wired follows from what it reads. An expression that reaches a signal is
the client's and gets a wiring entry; one over props alone is the server's and gets none.
Nothing is declared, both cases are written identically, and the split is visible in the
IR rather than in a convention.

The operator set is closed: `! - + ~` and `+ - * / % ** < > <= >= === !== == !=`. An
operator outside it is `E_OPERATOR_UNSUPPORTED` rather than a silent fallback to
server-only evaluation, because a value that stops updating is harder to notice than a
build error.

A ternary is a `cond` entry, and `??` and `||` lower onto the same node — `a || b` is
`a ? a : b`, and `a ?? b` is the same over a `!== null` test, which catches undefined too
because a `ref` to an absent binding reads as `null` on both sides. The node is lazy in its
arms: a branch not taken is not evaluated, so a `??` does not touch bindings the render
never read. `readsOf` still visits every branch, because which arm is taken is a value
while what the expression _reads_ is a property of the expression — and the cache key and
the client-owned set are both computed from the latter.

A template literal is not a node. `+` on a string already concatenates, so `` `row-${id}` ``
lowers to a `+` chain of the binary node that already existed and the client gains nothing
to evaluate it with.

Three things are still outside the set, and for one reason between them: a fragment body is
a declaration the compiler reads and never runs — `fragment()` throws if called — so there
is no evaluation for them to happen in, and shipping one to the client is the closure this
design exists not to send.

- **A call.** `{a.toUpperCase()}` is `E_EXPRESSION_UNSUPPORTED`. Compute it in the loader.
- **`&&`.** `{on && <b/>}` reads as a shape rather than a value, and lowering it to one
  would render the string `false` where the author expected nothing. It is refused with the
  alternative named.
- **A branch a signal decides.** See "Conditional shapes" below: the shape itself is supported, but
  `{sig() && <A/>}` is `E_BRANCH_ON_SIGNAL` because nothing on the client swaps sealed subtrees.

The escape class still comes from the syntax: arithmetic and comparison cannot produce
markup and are `proven-safe`, while `+` can concatenate a string and stays `escape`. A
`cond` escapes too, and deliberately without inspecting its arms: elision is a claim about
a _type_, the checker answers that for whole holes rather than for arms, and escaping a
number costs the same bytes as not escaping it while being wrong costs an injection.

Scope rules do not change. A signal read inside an expression inside a list row is still
`E_SIGNAL_IN_LIST` — a row is its own template, and the expression is lowered through the
same classifier every other interpolation uses.

## Components

`<Widget a={x} />` lowers to a `component` hole: the sealed child template, plus a map from
each child prop to the parent binding that supplies it. Nothing is inlined, so one child
used five times is one template used five times. A literal prop folds into the parent's
derived table as a constant, so `<Badge tone="warn"/>` needs nothing supplied at render.

The compiler checks the use site against what the child declares — a missing prop and an
unknown prop are both build errors, because a component whose contract is discovered at
render time is a component whose contract is not checked at all.

**Props of a composed fragment are wired.** A caller may hand a prop a signal, and the
child cannot know that from its own source, so every fragment that some other fragment in
the module renders gets a wiring entry for each prop-driven hole. A fragment nobody
composes carries none — the client skips a wiring entry with no source, so a caller that
passes a plain value costs nothing at runtime and the byte cost lands only where
composition actually happens.

**Across modules.** `<Widget/>` resolves against the fragments declared in the file first,
exported or not, then against imports. Cross-module composition needs an order — a parent
cannot name a child's version before the child is sealed — so it is `compileFiles` that
supports it: the build parses every file, resolves which fragments are rendered from where,
sorts by dependency, and compiles children first. Modules come back in the order the caller
asked for, not the order they had to be built in. Two modules that render each other are
`E_COMPONENT_CYCLE` naming the path, never unrolled. `compileFile` on its own still sees
only its own module, which is why an unresolved tag is `E_COMPONENT_UNRESOLVED`.

Whether a fragment wires its props is decided for the whole build, not per file: an export
another module renders is composable, and one nobody renders is not. That means a fragment
gains prop wiring the first time somebody composes it, and its version moves. That is
correct — a composable template is not the same template — but it is worth knowing before
it surprises you.

**Children.** A fragment that destructures a prop named `children` may interpolate it, and a
caller then writes markup between the tags. The markup is sealed as a template of its own and
named on the caller's hole rather than on the child's, because the child template is shared:
one `<Card/>` at five call sites is one sealed child and five contents.

```tsx
const Card = fragment(({ title, children }) => (
  <section class="card">
    <h2>{title}</h2>
    <div class="body">{children}</div>
  </section>
))

export default fragment(({ heading, note }) => (
  <Card title={heading}>
    <p>{note}</p>
  </Card>
))
```

The content stays in the **caller's** binding namespace. `note` is the caller's prop, wired from
the caller's signals, addressed by the caller's name for it in a delta — nothing is projected and
nothing is renamed, because a projection would need a name for every binding the markup happened
to reach and the call site never wrote one down. The two templates share one derived table for
the same reason: two `d0` entries against one value set would be two different expressions.

`{children}` must be the **only child of its element**, which is `E_CHILDREN_NOT_SOLE_CHILD` —
the same rule a list lives under, and for the same reason. The content occupies element positions
inside a template compiled without ever seeing it, so it owns those positions outright or every
sibling address after it depends on the call site. Wrap it in an element of its own and the
constraint disappears.

Children compose the way you would want: a component may pass its own children on, and the inner
`{children}` still means its caller's markup rather than its own, because the fill is a frame
with an `outer` rather than a value on the hole.

**Rows.** A row may carry an instance. The row is still its own template and still content-
addressed, so a reordered list costs no row render — the instance is part of the row's content,
not a per-index identity. Row scope is unchanged: an instance's props come from the row's item,
and reaching outside it is `E_OUT_OF_ROW_SCOPE` exactly as any other interpolation would be.

**Events.** `<Badge onClick={save}/>` binds the intent to the instance's root element, which is
addressable because a component renders exactly one. The wiring entry lives in the caller, so a
listener at one call site does not enter the shared child template.

**Contagion.** A component's reads compose into its caller's, except that a private child
inside a non-private caller is isolated into its own cache unit instead. Instances inside a row
or inside children markup are the caller's markup too, so their reads compose the same way —
but a private one there is `E_PRIVATE_COMPONENT_NESTED`, because isolation is a cut in a
template's segment stream and only a hole at the top level of a template has one. See
[effects](effects.md).

## Controls

`<input value={n()}>` renders the attribute — that is what the parser builds the control
from — and wires a `prop` op, so the client writes `element.value` rather than the
attribute. The two stop agreeing the moment a user types, and after that a write to the
attribute changes nothing anyone can see. The IR has carried a `prop` op since 2.0.0 and
the runtime now honours it.

Which attributes bind to the property is a small table keyed by tag: `value`, `checked` and
`indeterminate` on `input`, `value` on `textarea` and `select`, `selected` on `option`,
`value` on `progress`. The same attribute on an element that is not a control stays an
attribute.

## Effects

What a fragment reads is inferred, and an untracked ambient read is a hard error. That has
its own page: [effects and the ban](effects.md).

## Escape elision asks the type checker

Two passes decide whether a hole is `escape` or `proven-safe`.

**Syntax**, which proves a handful of shapes safe on its own: a numeric or boolean
literal, unary `!`/`-`/`+`/`~`, arithmetic and comparison operators, or a signal declared
with a numeric or boolean initialiser. String concatenation with `+` and the logical
operators pass values through, so they stay `escape`.

**Types**, for everything else. `{total}` cannot be classified by looking at it — it is
safe when `total` is a number and unsafe when it is a string, and the expression says
neither. The compiler builds a TypeScript program over the files being compiled and asks
the checker, treating a value as unable to contain markup only when every constituent of
its type is numeric or boolean. `any` and `unknown` are not proofs and escape.

`--no-types` falls back to the syntax pass alone, which is correct and more conservative.
Type diagnostics are printed and never fatal: a template still lowers.

One honest note on what this buys. It does **not** measurably speed up the JavaScript
renderer, which already elides at runtime by scanning a value and writing it untouched
when the scan finds nothing — 16,780 ns per render with four holes elided against 16,503
without. What it buys is an escape class that is true rather than conservative, which
matters for any consumer that cannot afford the scan: a native codec crossing a WASM
boundary per hole, or a client projecting values into a resident template.

### Where the types come from

TypeScript 7's package entry point exposes only `version` — the checker lives behind
`typescript/unstable/sync`, a client to the native compiler running as a separate
process. The oracle uses that: `updateSnapshot` for the file set, `getTokenAtPosition`
from `typescript/unstable/ast` to find the token at a span, then `parent` walking to widen
to the whole expression, then `checker.getTypeAtLocation`.

Three consequences worth knowing before touching this file:

- **`unstable` means unstable.** This is the one place in the repository bound to an API
  that can move between TypeScript releases. `--no-types` is the escape hatch, and the
  fallback is a correct compile rather than a failed one.
- **The checker is project-based.** A file must belong to a `tsconfig.json` for its types
  to be known; a file outside every project gets `other` for everything, which escapes.
  The oracle's tests write a `tsconfig.json` next to their fixtures for that reason.
- **The checker is a process.** `dispose()` is not optional, and `compileFiles` shuts it
  down in a `finally`.

## Addressing: what building the compiler changed about the IR

Two IR decisions did not survive contact with a real lowering pass, and both were fixed
in IR 1.1.0.

**Element paths, not node paths.** A path is now an index into an element's _element_
children, not its child nodes. Text nodes appear and disappear with the values — an
empty interpolation produces no text node at all — so any path counting child nodes is
wrong for a value set the compiler never saw.

**Anchors for text.** Adjacent static and dynamic text merge into one text node when the
browser parses the HTML, so a dynamic text run is not addressable on its own. The
compiler emits a `<!>` marker comment before a dynamic text hole, and after it when a
static text sibling follows, and the wiring entry carries the marker's ordinal. At
adoption the client collects marker comments in document order — one pass, no component
code — and writes into the node after marker _k_. A dynamic text that is its element's
only child needs no marker and no anchor.

Marker ordinals are counted per template instance, in document order, skipping the
subtrees of list holes, because each row is its own template instance with its own
markers. This is why a list must be the only child of its element: it keeps row content
out of the parent's addressing entirely, and it means a row count can change without
moving any sibling.

## Every refusal

| Code                              | Meaning                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `E_COMPONENT_UNRESOLVED`          | `<Widget/>` names no fragment in this module or in the file set        |
| `E_COMPONENT_CYCLE`               | a fragment renders itself, directly or through a sibling               |
| `E_COMPONENT_PROP_MISSING`        | a use site does not supply a prop the child declares                   |
| `E_COMPONENT_PROP_UNKNOWN`        | a use site supplies a prop the child does not declare                  |
| `E_COMPONENT_CHILDREN_UNDECLARED` | markup between the tags of a component that declares no `children`     |
| `E_CHILDREN_AS_PROP`              | `children={x}` — children are markup, written between the tags         |
| `E_CHILDREN_NOT_A_VALUE`          | `{children}` used as an attribute or inside an expression              |
| `E_CHILDREN_NOT_SOLE_CHILD`       | `{children}` must own its element's child positions                    |
| `E_PRIVATE_COMPONENT_NESTED`      | a private child inside a row or inside children has no boundary to cut |
| `E_COMPONENT_NOT_SINGLE_ROOT`     | an instance occupies one element position, so it needs one root        |
| `E_SPREAD_UNSUPPORTED`            | `{...props}` hides what the template can contain                       |
| `E_COMPUTED_MEMBER`               | `{o[k]}` has no static binding name                                    |
| `E_UNKNOWN_BINDING`               | the identifier is not a prop of this fragment                          |
| `E_SIGNAL_NOT_READ`               | `{n}` where `n` is a signal — write `{n()}`                            |
| `E_OPERATOR_UNSUPPORTED`          | the operator is outside the set the client can evaluate                |
| `E_SIGNAL_IN_LIST`                | a row is its own template and cannot close over an outer signal        |
| `E_OUT_OF_ROW_SCOPE`              | a row referenced a value that is not its item                          |
| `E_ITEM_NOT_A_VALUE`              | `{row}` — interpolate one of its fields                                |
| `E_LIST_NOT_SOLE_CHILD`           | a list must be the only child of its element                           |
| `E_ROW_NOT_SINGLE_ROOT`           | a row must be one element, or rows cannot be told apart                |
| `E_MAP_PARAM`                     | the row callback needs a single named parameter                        |
| `E_HANDLER_NOT_AN_INTENT`         | an inline handler has no stable id                                     |
| `E_HANDLER_NOT_IMPORTED`          | a local function has no module to derive an intent id from             |
| `E_VOID_CHILDREN`                 | a void element cannot have children                                    |
| `E_NESTED_FRAGMENT`               | `<>…</>` is allowed only at the root                                   |
| `E_BRANCH_NOT_SOLE_CHILD`         | a conditional element beside a sibling, whose index would then vary    |
| `E_BRANCH_ON_SIGNAL`              | a branch decided by a signal, which the client cannot swap             |
| `E_ROOT_NOT_JSX`, `E_NO_RETURN`   | a fragment must return JSX                                             |
| `E_FRAGMENT_ARGUMENT`             | `fragment()` takes a function                                          |
| `E_ATTRIBUTE_UNSUPPORTED`         | an attribute value that is neither a literal nor an expression         |
| `E_RAW_EMPTY`                     | `raw()` with nothing to vouch for                                      |
| `E_EXPRESSION_UNSUPPORTED`        | the expression cannot be resolved to a binding                         |
| `E_PARSE`                         | the file is not parseable                                              |

## Running it

```sh
pnpm install                                                  # the compiler needs Oxc
node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
```

It writes one JSON document per template plus a manifest of ids and versions. The
benchmark compiles its fixtures in-process, so its numbers are always measured against
emitted IR.

## Conditional shapes

`{on && <A/>}` is a `variant` hole: the branch is sealed as its own template, and the hole writes it
only when the binding is truthy. `{on ? <A/> : <B/>}` is two of them, over `on` and a `!on` added to
the derived table.

The byte layout does not vary, which is the property that keeps the template sealed. Both holes are
always in the parent and both branches always travel; what a value decides is which one is written.
A falsy branch writes nothing at all rather than a placeholder, so the choice costs no bytes.

A branch is lowered in the enclosing fragment's scope and shares its derived table — the rule a
component's children already follow. So a branch reads that fragment's props and signals by name and
needs no projection, and the negated arm is one `!` in a table both arms already share.

Two refusals hold it together. `E_BRANCH_NOT_SOLE_CHILD`: a conditional element must be the only
child of its element, because a falsy branch writes nothing and a sibling after it would sit at a
different element index depending on a value — the rule a list lives under, for the same reason.
And `E_BRANCH_ON_SIGNAL`: a `variant` emits no wiring entry, so nothing on the client swaps one
sealed subtree for another; a branch a signal decides would render once and never move, which is
refused rather than shipped as a control that looks live.

A conditional whose arms are _values_ is still one hole and a `cond` entry. The arms decide which
lowering applies: markup arms seal templates, value arms do not, and a conditional mixing the two is
refused rather than guessed at.

## A row's position

`{rows.map((row, i) => …)}` names the index, and the hole records the binding as `rowIndex`. The
position is supplied by whatever renders the rows rather than carried in the item, because it is a
fact about where a row sits and not about its value — so two identical items at different positions
are still one row template and one cache entry.

A list that does not name an index keeps the fast path: no `rowIndex`, no per-row spread. That
distinction is worth the field, because the row loop is the hot one — the feed scenario renders fifty
rows a request and throughput is measured on it.

Everything else about row scope is unchanged. A value from outside the row is still
`E_OUT_OF_ROW_SCOPE`, and a signal read inside one is still `E_SIGNAL_IN_LIST`: the index is the one
exception, and the position is what justifies it.
