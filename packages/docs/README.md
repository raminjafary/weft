# @weft/docs

The documentation site, and it is a weft application.

```sh
pnpm docs         # serve it
pnpm docs:build   # build it, and read which pages became files
```

Not a documentation generator pointed at this repository, and not a static-site tool with a plugin.
`packages/docs` is an application in the same sense the demo is — routes from the file tree, a plan
generated from it, and one command to serve it — because "the framework can express its own
documentation site" is a claim worth being able to make, and the only way to make it is to do it.

## Every example is live

An example is a real fragment under `app/fragments/examples/`. Which means:

- The repository's own `tsc` type-checks it, which is what makes the escape-elision example honest:
  elision is a type question, and a snippet nobody checked has no types to elide by.
- `weft build` compiles it. **An example that does not compile is a build that does not pass**, so a
  broken example cannot ship.
- `fragmentIR` hands the page the _same_ sealed template the renderer beside it used, so the holes,
  the escape decisions, the read set and the version on the page are that template's rather than a
  second compilation's that could disagree.
- The source shown is `CompiledFragment.source` — the bytes that produced those holes, carried by
  the build rather than re-read from a path that may have changed since.

There is no separate compile step and no snapshot to keep in sync. `test/docs.test.ts` renders all
of them, because a page that swallowed a failure would print an empty box.

## Two sections are generated, so they cannot drift

| Section         | Where it comes from                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------ |
| API reference   | Each package's public entry, parsed; its re-exports followed; every export with its doc comment  |
| Error reference | Every `packages/*/src`, scanned for named refusals, with the message and the file that raises it |

Adding an export adds a row. Adding a refusal adds a page. The tests scan the same trees
independently and fail when something is present in the source and absent here — which is what makes
"the whole API is documented" a gate rather than a claim. What the API page does _not_ claim is that
every export has prose: it publishes the ratio and marks each entry that has none, because a blank
space a reader mistakes for a simple function is worse than an admission.

## What the site uses, that you can go and look at

| Capability                      | Where                                                                       |
| ------------------------------- | --------------------------------------------------------------------------- |
| Nested layouts                  | `app/routes/{guide,tutorial,api}/layout.tsx`, each inside `app/layout.tsx`  |
| Param routes with declared sets | One route serves every guide page; another serves all ~330 error codes      |
| The L0 tier                     | `weft build` writes the site as 361 files; the kernel serves none of them   |
| A slot as a cache unit          | The contents column is its own region: one entry per section, not per page  |
| A declared refusal              | `/play` is the one page that is not a file, and `notStaticBecause` says why |
| The compiler's virtual file set | `/play` compiles what you type without writing it anywhere                  |

## Structure

```
app/layout.tsx                    the document: head, header, one <slot>
app/routes/<section>/layout.tsx   the section's chrome: contents, body, outline
app/routes/guide/[page].data.ts   every guide page, one route
app/routes/errors/[code].data.ts  every refusal, one route
app/fragments/examples/*.tsx      the live examples
app/lib/surface.ts                the API walk
app/lib/errors.ts                 the refusal scan
app/lib/play.ts                   the playground, on a virtual file set
```
