# weft

**A TypeScript fullstack framework that negotiates how UI reaches the browser.**

The wire form of a piece of UI — full markup, a surgical delta, a patch — is chosen per request from
a set of encodings the compiler has proven equivalent, instead of being frozen at build time.

A folder is an application. There is no bundler, no virtual DOM, and no component code running in
the browser: the compiler seals your pages into templates, the server fills them, and the client
runtime binds what is already there.

## Quick start

```sh
npm  create weft@latest my-app
pnpm create weft my-app
yarn create weft my-app
bun  create weft my-app
```

```sh
cd my-app
npm install
npm run dev          # http://localhost:3000
```

Or add it to a project you already have:

```sh
npm install @weft/core
npx weft create my-app --template minimal
```

## A folder is an application

```
app/
  layout.tsx               the document. Its <slot> holes are what a route fills
  routes/index.tsx         /
  routes/[slug].tsx        /:slug
  routes/x.data.ts         x.tsx's head, cache policy, loader, guard and slots
  routes/x.css             linked only by the pages that render x
  routes/x.scoped.css      the same, narrowed to the elements x.tsx declares
  fragments/<name>.tsx     a component, referenced by name from a route's slots
  slots/<name>.tsx         fills the layout hole of that name on every route
  intents/**.ts            mutations. The manifest is generated from this directory
public/                    served as written, and again at a URL carrying its digest
weft.config.ts             what this deployment binds
```

A page is a fragment — a declaration the compiler reads and never runs:

```tsx
// app/routes/index.tsx
import { fragment } from '@weft/core'

export default fragment(({ name, steps }: Props) => (
  <>
    <h1>{name} is running.</h1>
    <ol>
      {steps.map((step) => (
        <li>{step.what}</li>
      ))}
    </ol>
  </>
))
```

Its data file is what the route declares — and deliberately not a cache key, because keys are
derived from what the compiler saw the page read:

```ts
// app/routes/index.data.ts
import { defineRoute } from '@weft/core'

export default defineRoute({
  head: { title: 'my-app', description: 'A weft application.' },
  cache: { class: 'public', ttl: '1h' },
  load: () => ({ name: 'my-app', steps: [] }),
})
```

Mutations are intents. They run on the server, declare what they invalidate, and work with
JavaScript switched off — a form posts and gets a 303 back where it came from, and the same dispatch
answers a `fetch`:

```ts
// app/intents/counter.ts
import { defineIntent } from '@weft/core'

export const bump = defineIntent<{ by: number }>({
  name: 'counter.bump',
  writes: ['counter'],
  async run(ctx, input) {
    count += input.by
    await ctx.revalidate('counter')
    return { refresh: ['body'], data: { count } }
  },
})
```

## The CLI

```sh
weft dev              # serve, and rebuild what changes
weft dev --devtools   # plus this application's routes, keys and bytes as pages
weft dev --profile    # record what every render costs, and plan the next build from it
weft build            # sealed templates, the generated plan, the manifest, revved assets
weft start            # serve the build. No compiler runs
weft create <name>    # a new application, with a page you can open
weft routes           # the route table, as the file tree produced it
weft why /            # the plan the framework generated for a route, chain included
weft verify --probe   # ask every region what it is serving, and exit non-zero on disagreement
weft upload --to <url> --header <k=v>   # PUT the build to an object store
```

## Some numbers

|                                                |                                                      |
| ---------------------------------------------- | ---------------------------------------------------- |
| Out-of-order streaming, fast region on screen  | **4.7× earlier**, in all three engines               |
| A server-driven update as a delta              | **16.9×** fewer bytes raw, 3.2× after brotli         |
| Applying that delta against parsing the markup | **20–93× cheaper**                                   |
| Client runtime, everything                     | **6,109 B** brotli, against a gated ceiling of 6,144 |
| Server kernel, the document request path       | **8,118 B** brotli, against 8,192                    |
| Third-party runtime dependencies               | **1** — `oxc-parser`, in the compiler                |

Everything is measured, reproducible, and reversed in public when it turns out to be wrong. The
tables, the methodology and the claim-by-claim ledger are in the
[repository README](https://github.com/raminjafary/weft#readme).

## Documentation

- [README](https://github.com/raminjafary/weft#readme) — features, benchmarks, and how it works
- [DESIGN.md](https://github.com/raminjafary/weft/blob/main/DESIGN.md) — the long form, and every refusal with its argument
- [`spec/`](https://github.com/raminjafary/weft/tree/main/spec) — the per-capability reference
- `pnpm docs:dev` in the repository — Quick Start, a 21-page Guide, Tutorial, Examples, API, Glossary and an Error Reference

## License

MIT
