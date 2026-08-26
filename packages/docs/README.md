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
  the escape decisions, the read set, the wiring and the version on the page are that template's
  rather than a second compilation's that could disagree.
- The source shown is `CompiledFragment.source` — the bytes that produced those holes, carried by
  the build rather than re-read from a path that may have changed since.

There is no separate compile step and no snapshot to keep in sync. `test/docs.test.ts` renders all
of them, because a page that swallowed a failure would print an empty box.

Three of the examples exist because the compiler refused the first version of them, and the file
says so where it happens: a list beside a sibling is `E_LIST_NOT_SOLE_CHILD`, `items.length` in a
hole is `E_EXPRESSION_UNSUPPORTED`, and reading an outer value inside a row is
`E_OUT_OF_ROW_SCOPE`. A refusal a reader can see in a file that ships is worth more than a
paragraph about it.

## What is generated, so it cannot drift

| Section              | Where it comes from                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| API reference        | Each package's public entry, parsed; its re-exports followed; every export with its doc comment  |
| Error reference      | Every `packages/*/src`, scanned for named refusals, with the message and the file that raises it |
| CLI reference        | The `HELP` string `weft --help` prints, parsed into commands and options                         |
| Byte budgets         | `packages/bench/src/budget.ts`, so the ceiling on the page is the one the gate compares against  |
| Wire-format versions | The constants a build stamps on a document — `@weft/ir`, and `packages/warp/src/version.ts`      |
| Wire-form sizes      | `render`, `patchPayload` and `deltaPayload` over one example, measured when the page renders     |
| Search               | The site's own registries, matched per request. No index is built and none is downloaded         |

Adding an export adds a row. Adding a refusal adds a page. Adding a CLI flag adds a line. The tests
scan the same trees independently and fail when something is present in the source and absent here —
which is what makes "the whole API is documented" a gate rather than a claim. What the API page does
_not_ claim is that every export has prose: it publishes the ratio and marks each entry that has
none, because a blank space a reader mistakes for a simple function is worse than an admission.

The generated version table caught its own hand-written counterpart: `spec/VERSIONING.md` said warp
was `1.7.0` while `packages/warp/src/version.ts` said `1.8.0`. A test now asserts the two agree.

## The guide covers the framework, and that is a gate

Every guide page names the spec documents it introduces, and `test/docs.test.ts` checks the relation
in both directions — a name that does not exist fails, and **a spec document no page introduces
fails too**. There is no exemption list. Shipping a mechanism means writing the paragraph a reader
can find, in the same change.

The three things still do three jobs. This site is the introduction, in order, with examples that
run. `spec/` is the reference: the mechanism, its refusals, and what it deliberately does not do.
`@weft/inspector` is the live version, a station per mechanism with a control.

## What the site uses, that you can go and look at

| Capability                      | Where                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Nested layouts                  | `app/routes/{guide,tutorial,api}/layout.tsx`, each inside `app/layout.tsx`       |
| Param routes with declared sets | One route serves all 21 guide pages; another serves all 326 error codes          |
| The L0 tier                     | `weft build` writes the site as 370 files; the kernel serves none of them        |
| A slot as a cache unit          | The contents column is its own region: one entry per section, not per page       |
| Declared refusals               | `/play` and `/search` are the two pages that are not files, and both say why     |
| The compiler's virtual file set | `/play` compiles what you type without writing it anywhere                       |
| An intent, with no JavaScript   | The form on `/guide/intents` posts to `app/intents/feedback.ts` and works        |
| A read as a cache axis          | `/search?q=` taints `route:q`, so every query is its own content-addressed entry |

## Structure

```
app/layout.tsx                    the document: head, header, search form, one <slot>
app/routes/<section>/layout.tsx   the section's chrome: contents, body, outline
app/routes/guide/[page].data.ts   every guide page, one route
app/routes/errors/[code].data.ts  every refusal, one route
app/routes/search.data.ts         a GET, so a search has a URL and needs no script
app/fragments/examples/*.tsx      the live examples
app/intents/feedback.ts           the one thing on this site that writes
app/lib/pages.ts                  the guide's registry: order, groups, specs covered, examples
app/lib/content.ts                the prose, per page
app/lib/surface.ts                the API walk
app/lib/errors.ts                 the refusal scan
app/lib/cli.ts                    the help text, parsed
app/lib/budgets.ts                the byte ceilings, parsed
app/lib/versions.ts               the wire-format versions, from the constants
app/lib/wire.ts                   html vs patch vs delta, measured on one example
app/lib/search.ts                 the index, which is the registries above
app/lib/play.ts                   the playground, on a virtual file set
```
