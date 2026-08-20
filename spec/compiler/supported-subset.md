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

| Construct | Lowers to |
| --- | --- |
| HTML element, static attributes | bytes in a segment |
| `attr={expr}` | an `attr` hole inside the quoted value |
| `disabled={expr}` (known boolean attribute) | an `attr-bool` hole; the name is the value |
| `{expr}` between nodes | a `text` hole |
| `{'literal'}`, `{42}` | folded into the segment — no hole at all |
| `{raw(x)}` | a `trusted-raw` hole whose provenance is the source text of `x` |
| `{rows.map((row) => …)}` | a `list` hole plus a nested template, sealed first so the parent names its version |
| `onEvent={imported}` | a wiring `event` op carrying an intent id derived from the module and export |
| `signal()` read | a hole plus a wiring op, since only a signal can change on the client |
| `<slot>{fallback}</slot>` | a `slot` hole: the base render emits nothing and a later frame fills it |
| `<>…</>` at the root | a template with no wrapper element |

## Escape elision is syntax-only, and that is a real limit

The compiler marks a hole `proven-safe` only when the syntax alone proves the value
cannot be markup: a numeric or boolean literal, unary `!`/`-`/`+`/`~`, arithmetic and
comparison operators, or a signal declared with a numeric or boolean initialiser. String
concatenation with `+` and the logical operators pass values through, so they stay
`escape`.

Everything else — including a prop the author knows is a number — defaults to `escape`.
That default is correct and it costs measurable throughput: the same templates with
elision applied to numeric props render 5–12% faster. **Recovering that requires the
type checker**, which is the strongest argument for wiring `tsc`'s type information into
the pass rather than staying syntax-only.

## Addressing: what building the compiler changed about the IR

Two IR decisions did not survive contact with a real lowering pass, and both were fixed
in IR 1.1.0.

**Element paths, not node paths.** A path is now an index into an element's *element*
children, not its child nodes. Text nodes appear and disappear with the values — an
empty interpolation produces no text node at all — so any path counting child nodes is
wrong for a value set the compiler never saw.

**Anchors for text.** Adjacent static and dynamic text merge into one text node when the
browser parses the HTML, so a dynamic text run is not addressable on its own. The
compiler emits a `<!>` marker comment before a dynamic text hole, and after it when a
static text sibling follows, and the wiring entry carries the marker's ordinal. At
adoption the client collects marker comments in document order — one pass, no component
code — and writes into the node after marker *k*. A dynamic text that is its element's
only child needs no marker and no anchor.

Marker ordinals are counted per template instance, in document order, skipping the
subtrees of list holes, because each row is its own template instance with its own
markers. This is why a list must be the only child of its element: it keeps row content
out of the parent's addressing entirely, and it means a row count can change without
moving any sibling.

## Every refusal

| Code | Meaning |
| --- | --- |
| `E_COMPONENT_UNSUPPORTED` | `<Widget/>` — component composition is not in the prototype |
| `E_SPREAD_UNSUPPORTED` | `{...props}` hides what the template can contain |
| `E_COMPUTED_MEMBER` | `{o[k]}` has no static binding name |
| `E_UNKNOWN_BINDING` | the identifier is not a prop of this fragment |
| `E_SIGNAL_NOT_READ` | `{n}` where `n` is a signal — write `{n()}` |
| `E_DERIVED_SIGNAL_UNSUPPORTED` | `{n() * 2}` needs client-side computation |
| `E_SIGNAL_IN_LIST` | a row is its own template and cannot close over an outer signal |
| `E_OUT_OF_ROW_SCOPE` | a row referenced a value that is not its item |
| `E_LIST_NOT_SOLE_CHILD` | a list must be the only child of its element |
| `E_HANDLER_NOT_AN_INTENT` | an inline handler has no stable id |
| `E_HANDLER_NOT_IMPORTED` | a local function has no module to derive an intent id from |
| `E_VOID_CHILDREN` | a void element cannot have children |
| `E_NESTED_FRAGMENT` | `<>…</>` is allowed only at the root |
| `E_ROOT_NOT_JSX`, `E_NO_RETURN` | a fragment must return JSX |
| `E_EXPRESSION_UNSUPPORTED` | the expression cannot be resolved to a binding |

## Running it

```sh
pnpm install                                                  # the compiler needs Oxc
node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
```

It writes one JSON document per template plus a manifest of ids and versions. The
benchmark compiles its fixtures in-process, so its numbers are always measured against
emitted IR.
