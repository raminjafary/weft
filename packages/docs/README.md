# @weftjs/docs

The documentation site, and it is a weft application.

```sh
pnpm docs:dev     # serve it
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
| Wire-format versions | The constants a build stamps on a document — `@weftjs/ir`, and `packages/warp/src/version.ts`    |
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
`@weftjs/inspector` is the live version, a station per mechanism with a control.

## What the site uses, that you can go and look at

| Capability                      | Where                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Nested layouts                  | `app/routes/{guide,tutorial,api}/layout.tsx`, each inside `app/layout.tsx`               |
| Param routes with declared sets | One route serves all 21 guide pages; another serves all 326 error codes                  |
| The L0 tier                     | `weft build` writes the site as 370 files; the kernel serves none of them                |
| A slot as a cache unit          | The contents column is its own region: one entry per section, not per page               |
| Declared refusals               | `/play` and `/search` are the two pages that are not files, and both say why             |
| The compiler's virtual file set | `/play` compiles what you type without writing it anywhere                               |
| An intent, with no JavaScript   | The form on `/guide/intents` posts to `app/intents/feedback.ts` and works                |
| Per-page CSS bundles            | The landing page's 4 KB of hero and band is linked by `/` and by nothing else            |
| A conditional inside a layout   | The breadcrumb is drawn only on pages that are inside a group, by a branch in the layout |
| A component inside the document | The mark is a fragment `app/layout.tsx` composes, at two sizes and two tones             |
| A replaced error page           | `app/layouts/error.tsx` — the same discovery every other document gets                   |
| A read as a cache axis          | `/search?q=` taints `route:q`, so every query is its own content-addressed entry         |

## The look, and where it is decided

The site has a design system rather than a stylesheet, and the split between the two files that
carry it is the whole of it:

- **`app/styles.css`** is the only file that _defines_ a value. One set of tonal ramps generated on
  a shared lightness scale, and two role maps over them — light reads the ramps from the light end,
  dark from the dark end, so a step means the same visual value in both and there is no second
  palette to keep in sync. It also holds the motion vocabulary and the hover glow.
- **`app/layout.css`** _spends_ those values on the document: the header, the footer, the three
  shells a page can sit in, and the article vocabulary every page is made of.

Everything else is colocated, which is what makes the per-page CSS bundle worth having: the
contents rail's sheet is beside the fragment that renders it, and the landing page, the playground
and Quick Start each carry a sheet the framework links to that page and to no other.

Two things had to move for the browser to reach them. `app/hl.ts` and `app/escape.ts` sit at the
top of `app/` rather than in `lib/`, because the framework serves `client.ts` **and its siblings**
to the browser and refuses a path below that directory — deliberately, since the tree is a public
surface and `lib/` is full of modules that open files. `lib/` re-exports both, so nothing that
imported them had to change.

## What the browser gets, and what it is for

`app/client.ts` is the whole of this site's own browser code, and nothing in it may be
load-bearing:

| It adds                    | Over something that already works                                  |
| -------------------------- | ------------------------------------------------------------------ |
| A three-state theme toggle | A palette the stylesheet already picks from `prefers-color-scheme` |
| ⌘K, over the header's form | A `GET` to `/search`, which is the same answer one paint later     |
| A cursor-following glow    | A hover state that is a colour change without it                   |
| A highlighted editor       | A `<textarea>` in a form that compiles on submit                   |
| Live type hints            | The compile beside them, which is the authoritative answer         |

The finder fetches `/search?q=` and lifts `#finder-list` out of the answer, which is why there is
no index in the bundle: the list it shows is the one the page shows, built by the same function
from the same registries. A prebuilt index would buy one round trip and cost a second copy of the
content, downloaded by every reader whether they search or not.

The hints are `app/infer.ts` — a scan that reads the props interface, finds the holes, and says
what escape elision _would_ decide for each. It is a hint and the panel says so, because the
playground's file set is virtual and a virtual compile has no checker to elide by. What it may
claim is gated by a test.

## Structure

```
app/styles.css                    the only file that defines a value: ramps, roles, motion, glow
app/layout.css                    the document: header, footer, the three shells, the article
app/layout.tsx                    the document: head, header, search form, one <slot>, footer
app/client.ts                     the theme, ⌘K, the glow, the editor. Nothing load-bearing
app/hl.ts                         the highlighter, where the browser can also reach it
app/infer.ts                      the live type hints. A scan, and it says so
app/escape.ts                     text into HTML text, beside client.ts for the same reason
app/layouts/error.tsx             this site's 404 and 500, replacing the framework's own
app/routes/<section>/layout.tsx   the section's chrome: rail, article, outline
app/routes/index.data.ts          the landing page, with index.css beside it
app/routes/play.data.ts           the playground, with play.css beside it
app/routes/quick-start/           a section of one, so the page it ends on has a rail
app/routes/guide/[page].data.ts   every guide page, one route
app/routes/errors/[code].data.ts  every refusal, one route
app/routes/search.data.ts         a GET, so a search has a URL and needs no script
app/fragments/chrome/             the mark
app/fragments/docs/contents.tsx   the rail every section shares, and its sheet
app/fragments/examples/*.tsx      the live examples
app/intents/feedback.ts           the one thing on this site that writes
app/lib/shell.ts                  the layout values every page supplies, written once
app/lib/figures.ts                the figures, and the motion language they share
app/lib/rails.ts                  what goes in an outline column
app/lib/landing.ts                the landing page's body
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
