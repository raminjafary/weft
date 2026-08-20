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

| Construct                                   | Lowers to                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| HTML element, static attributes             | bytes in a segment                                                                 |
| `attr={expr}`                               | an `attr` hole inside the quoted value                                             |
| `disabled={expr}` (known boolean attribute) | an `attr-bool` hole; the name is the value                                         |
| `{expr}` between nodes                      | a `text` hole                                                                      |
| `{'literal'}`, `{42}`                       | folded into the segment — no hole at all                                           |
| `{raw(x)}`                                  | a `trusted-raw` hole whose provenance is the source text of `x`                    |
| `{rows.map((row) => …)}`                    | a `list` hole plus a nested template, sealed first so the parent names its version |
| `onEvent={imported}`                        | a wiring `event` op carrying an intent id derived from the module and export       |
| `signal()` read                             | a hole plus a wiring op, since only a signal can change on the client              |
| `<slot>{fallback}</slot>`                   | a `slot` hole: the base render emits nothing and a later frame fills it            |
| `<>…</>` at the root                        | a template with no wrapper element                                                 |

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

| Code                            | Meaning                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `E_COMPONENT_UNSUPPORTED`       | `<Widget/>` — component composition is not in the prototype     |
| `E_SPREAD_UNSUPPORTED`          | `{...props}` hides what the template can contain                |
| `E_COMPUTED_MEMBER`             | `{o[k]}` has no static binding name                             |
| `E_UNKNOWN_BINDING`             | the identifier is not a prop of this fragment                   |
| `E_SIGNAL_NOT_READ`             | `{n}` where `n` is a signal — write `{n()}`                     |
| `E_DERIVED_SIGNAL_UNSUPPORTED`  | `{n() * 2}` needs client-side computation                       |
| `E_SIGNAL_IN_LIST`              | a row is its own template and cannot close over an outer signal |
| `E_OUT_OF_ROW_SCOPE`            | a row referenced a value that is not its item                   |
| `E_LIST_NOT_SOLE_CHILD`         | a list must be the only child of its element                    |
| `E_HANDLER_NOT_AN_INTENT`       | an inline handler has no stable id                              |
| `E_HANDLER_NOT_IMPORTED`        | a local function has no module to derive an intent id from      |
| `E_VOID_CHILDREN`               | a void element cannot have children                             |
| `E_NESTED_FRAGMENT`             | `<>…</>` is allowed only at the root                            |
| `E_ROOT_NOT_JSX`, `E_NO_RETURN` | a fragment must return JSX                                      |
| `E_EXPRESSION_UNSUPPORTED`      | the expression cannot be resolved to a binding                  |

## Running it

```sh
pnpm install                                                  # the compiler needs Oxc
node packages/compiler/src/cli.ts packages/compiler/fixtures/*.tsx --out build/ir
```

It writes one JSON document per template plus a manifest of ids and versions. The
benchmark compiles its fixtures in-process, so its numbers are always measured against
emitted IR.
