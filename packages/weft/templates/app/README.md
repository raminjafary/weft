# **NAME**

A weft application. A folder is the application: the route table is the file tree, and the plan
that places everything on a page is generated from it.

```
pnpm install
pnpm dev
```

## The convention

```
app/
  layout.tsx            the document. Its <slot> holes are what a route fills
  layout.css            its stylesheet
  styles.css            linked on every page, after the framework's own
  routes/
    index.tsx           /
    counter.tsx         /counter
    counter.data.ts     its head, cache policy, loader and slots
    counter.css         linked only by the pages that render it
    guide/[topic].tsx   /guide/:topic
  fragments/card.tsx    a component, referenced by name from a route's slots
  layouts/error.tsx     the 404 and the 500. Delete it and you get the framework's
  slots/footer.tsx      fills the layout's footer hole on every route
  intents/counter.ts    mutations. The manifest is generated from this directory
public/                 served as written, and again at a URL carrying its digest
weft.config.ts          what this deployment binds
```

Two files per route at most. `x.tsx` renders and `x.data.ts` declares; a page that needs no data
is one file.

## Commands

| Command       | What it does                                                             |
| ------------- | ------------------------------------------------------------------------ |
| `weft dev`    | Serves, and rebuilds what changes without restarting the process         |
| `weft build`  | Sealed templates, the generated plan, the intent manifest, revved assets |
| `weft start`  | Serves the build. No compiler runs                                       |
| `weft routes` | The route table, as the file tree produced it                            |
| `weft why /`  | The plan the framework generated for a route                             |

## Things worth knowing

**You do not write cache keys.** A route declares a class and a ttl; the key is derived from what
the compiler saw the page read. Declaring `public` on a fragment that reads identity fails the
build and names the read.

**You do not write CSS to look finished.** The framework ships a stylesheet. A `.css` beside any
`.tsx` is linked by the pages that render it and by no others.

**Mutations work with JavaScript off.** An intent is dispatched over the channel when there is one
and answered with a 303 from a form post when there is not — one dispatch, two representations.

**The error page is yours.** `app/layouts/error.tsx` is discovered like any other named document
and replaces the framework's own for both a 404 and a 500. Writing the file is the whole of the
registration. It is handed the status, the framework's name for what happened, a sentence, the path
that was asked for, and — in `weft dev` only — the stack.

**Assets are revved.** `asset('/logo.svg')` returns a URL with the file's digest in it, immutable
for a year. `weft build` writes every one of them to `.weft/assets/` with a manifest, so the
directory can be handed to a CDN as it is.
