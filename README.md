# Weft

**A TypeScript fullstack framework that negotiates how UI reaches the browser.**

It runs wherever you deploy it. On a host that keeps a process — Fly, Railway, Render, a container,
a bare pod — the channel is a WebSocket. On one that keeps none, a serverless function on Vercel or
Lambda or Workers, the same channel becomes a request and its response, and everything the client
asks for still works: intents, surgical refreshes, and a whole route staged before it is clicked.
Nothing degrades silently — whatever a host cannot do is a named line on the handshake.

The wire form of a piece of UI — full markup, a surgical delta, a patch — is chosen per request from
a set of encodings the compiler has proven equivalent, instead of being frozen at build time.

A folder is an application. There is no bundler, no virtual DOM, and no component code running in
the browser: the compiler seals your pages into templates, the server fills them, and the client
runtime binds what is already there.

[![npm](https://img.shields.io/npm/v/@weftjs/core?label=%40weftjs%2Fcore&color=blue)](https://www.npmjs.com/package/@weftjs/core)
[![npm](https://img.shields.io/npm/v/create-weft?label=create-weft&color=blue)](https://www.npmjs.com/package/create-weft)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >= 22.18](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg)
![runtime deps: 1](https://img.shields.io/badge/third--party%20runtime%20deps-1-brightgreen.svg)

---

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

Two templates. `app` is the default — a layout, three routes, a fragment with its own CSS, a slot,
and a real mutation you can press. `minimal` is one route and nothing else.

```sh
npm create weft my-app -- --template minimal
```

Already inside a project? The framework's own CLI scaffolds too:

```sh
npx weft create my-app --template app
```

Every file the scaffold writes is a file the framework will actually read, and each one says what it
is for. Nothing is a placeholder.

---

## A glimpse

**The route table is the file tree.** The plan that places everything on a page is generated from it
— no wiring, and no config file you must have.

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

**A page is a fragment.** It is a declaration the compiler reads and never runs, so it compiles to
data rather than to a function — which is why rendering it ten times adds ten items of content and
no template.

```tsx
// app/routes/index.tsx
import { fragment } from '@weftjs/core'

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

**Its data file is what the route declares** — and deliberately not a cache key, because keys are
derived from what the compiler saw the page read.

```ts
// app/routes/index.data.ts
import { asset, defineRoute } from '@weftjs/core'

export default defineRoute({
  head: { title: 'my-app', description: 'A weft application.' },
  cache: { class: 'public', ttl: '1h' },
  load: () => ({ name: 'my-app', logo: asset('/logo.svg'), steps: [] }),
})
```

`cache: { class: 'public' }` on a page that read identity fails the build, with `identity` named.

**Mutations are intents.** They run on the server, they declare what they invalidate, and they work
with JavaScript switched off — a form posts and gets a 303 back where it came from; the same
dispatch answers a `fetch`.

```ts
// app/intents/counter.ts
import { defineIntent } from '@weftjs/core'

export const bump = defineIntent<{ by: number }>({
  name: 'counter.bump',
  writes: ['counter'],
  input: (raw) => ({ by: Math.trunc(Number((raw as { by?: unknown }).by ?? 1)) }),
  async run(ctx, input) {
    count += input.by
    await ctx.revalidate('counter')
    return { refresh: ['body'], data: { count } }
  },
})
```

An intent that touches state it did not declare is refused. The declaration is also what tells every
open connection which regions just went stale — open the page in two tabs, press the button in one,
and the other updates without asking.

**No client code required.** Adoption, intents, the channel and control wiring are reached through
attributes — `data-weft-intent`, `data-weft-control`, `data-weft-apply` — so an application can ship
none at all. The demo ships none.

---

## The numbers

Everything here is measured, reproducible from this repository, and reversed in public when it turns
out to be wrong — [`spec/FINDINGS.md`](spec/FINDINGS.md) is the claim-by-claim ledger. Apple M4,
Node 24.18, loopback, 300 samples.

### The falsification test the design set for itself

_If the pre-encoded-buffer shell does not beat a tuned React Router 7 app on TTFB in a reproducible
test, the central premise is wrong._ A route whose data takes 40 ms, 40 ms of injected RTT, and
[a real RR7 app](benchmarks/rr7) in two configurations:

| Candidate                                                 | TTFB p50     | Last byte | Bytes |
| --------------------------------------------------------- | ------------ | --------- | ----- |
| Weft segments                                             | 43.46 ms     | 84.67 ms  | 6,289 |
| String-concat SSR, streaming                              | 43.48 ms     | 84.84 ms  | 6,289 |
| **RR7, tuned** — promise loader, Suspense, `onShellReady` | **44.65 ms** | 90.78 ms  | 7,687 |
| Await the loader, then render                             | 84.75 ms     | 84.78 ms  | 6,289 |
| **RR7, default shape** — awaited loader, `onAllReady`     | **95.35 ms** | 95.40 ms  | 6,370 |

**The premise survives and the framing does not.** 1.03× faster to first byte is 1.2 ms on a 43 ms
number, and a design marketed on that would be marketing 1.2 ms. What the test does establish is
worth more: **streaming is the whole game.** The two blocking candidates pay their query before
their first byte — 1.95× and 2.19× worse — and no renderer improvement recovers it. Weft cannot be
configured into that failure, because a fragment that reads something slow is a hole by
construction. RR7 can, and its default shape is the slow one. The edge that is left sits on the axes
nobody markets: 6.7% faster to last byte, 18% fewer bytes for the same content.

### Streaming — the largest advantage measured anywhere here

A slot is a hole the shell refuses to wait for. With the slow region first, 80 ms against 20 ms:

|                           | Chromium  | Firefox   | WebKit    |
| ------------------------- | --------- | --------- | --------- |
| in-order, fast region     | 103 ms    | 104 ms    | 103 ms    |
| out-of-order, fast region | **22 ms** | **23 ms** | **22 ms** |

**4.7× earlier**, for 329 bytes of inline script, with identical final DOM in all three engines.

### Bytes per server-driven update

One row's quantity and price change:

| Form    | Raw   | Brotli |
| ------- | ----- | ------ |
| `html`  | 6,289 | 605    |
| `delta` | 371   | 187    |

**16.9× smaller raw, 3.2× after brotli** — and nothing else in the field offers it without a
stateful process per connection.

### The client runtime

Adoption walks the DOM the parser built and records where each value lives, with no component code
executing. 50-row region, ~200 bindings, p50:

|                                  | Chromium  | Firefox   | WebKit    |
| -------------------------------- | --------- | --------- | --------- |
| Adopt the region                 | 0.044 ms  | 0.105 ms  | 0.050 ms  |
| Parse the same markup            | 0.076 ms  | 0.065 ms  | 0.140 ms  |
| Apply a 12-path delta surgically | 0.0018 ms | 0.0029 ms | 0.0021 ms |
| One signal write to one node     | 0.29 µs   | 1.7 µs    | 0.71 µs   |

A delta applied as designed — one write per changed value, into DOM that already exists — is
**22–67× cheaper** than the parse it replaces.

<details>
<summary><b>More numbers</b> — server throughput, repeat visits, shared refresh, navigation</summary>

**Server render throughput.** Pre-encoded byte segments against string concatenation, both rendering
the same compiled templates, so this compares the mechanism and nothing else.

| Scenario      | Segments            | String SSR |       |
| ------------- | ------------------- | ---------- | ----- |
| shell, 707 B  | 1,165,022 renders/s | 594,914    | 1.96× |
| cart, 12 rows | 236,539             | 167,419    | 1.41× |
| feed, 50 rows | 62,492              | 43,807     | 1.43× |

The 1.4–1.96× lives in server capacity; it is invisible to latency.

**Repeat visits.** Templates persist in IndexedDB, are advertised to the server as a coarse digest,
and arrive as `TPL` frames only when the client does not already hold them:

| Boot path, p50    | Chromium    | Firefox | WebKit  |
| ----------------- | ----------- | ------- | ------- |
| First visit       | 2.50 ms     | 6.00 ms | 3.00 ms |
| Repeat visit      | 0.70 ms     | 3.00 ms | 1.00 ms |
| Protocol bytes    | 1,124 → 132 | same    | same    |
| `TPL` frames sent | 2 → 0       | same    | same    |

IndexedDB rather than a service worker, because WKWebView gates service workers behind app-bound
domains — the traffic where a repeat-visit gain matters most is the traffic that does not have them.

**The shared surgical refresh.** The client names the base it holds, the server recovers it, diffs,
and memoizes under `delta:<tpl>:<from>-><to>`. A thousand clients on one base cost **one** diff —
0.3 ms against a per-connection differ's 8.2. A thousand clients each on a _different_ base share
nothing, and the shared path then costs 17.3 ms against 9.2. Both are in the report, because the
second is where a deployment gets surprised.

A region whose values are not projectable — a `raw()` value, an isolated instance, a `slot` hole —
takes the rung between delta and markup: a `patch`, applicable by a client holding no copy of the
template. 4.3–6.0× smaller than the region raw, 1.9–2.6× after brotli, 3.3–3.9× cheaper to apply
than the parse it replaces — and on a 141-byte region it is _larger_ than the markup after
compression, which is in [`spec/kernel/surgical.md`](spec/kernel/surgical.md) with the reason it is
still the right answer there.

**Instant navigation.** Hover stages a route into an epoch that paints nowhere; a click commits it as
a DOM swap. 17 ms staged against 606 ms on the demo's deliberately slow page, and 7–19× on ordinary
ones at 100 ms injected RTT. On loopback a staged click is _slower_ than letting the browser do it,
which is the honest floor of the idea and is in
[`spec/client/navigation.md`](spec/client/navigation.md) with the table.

</details>

### Byte budgets, which are gates rather than reports

A test fails the moment an entry crosses its ceiling.

| Entry                                     | brotli     | Ceiling |
| ----------------------------------------- | ---------- | ------- |
| Client runtime, everything                | **6,137**  | 6,144   |
| Content route — adopt and bind            | **2,251**  | 5,120   |
| App route — adopt, bind, patch, epochs    | **3,190**  | 12,288  |
| Server kernel — the document request path | **8,273**  | 8,320   |
| Front door — the code, bundled            | **13,725** | 14,336  |

Fifteen entries in all, each with its own stated ceiling rather than a share of one — see
[`DESIGN.md`](DESIGN.md#byte-budgets-which-are-gates-rather-than-reports) for the full table, the
watermarks that moved, and why the front-door row is the code rather than the download.

---

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

**There is no bundler.** Client modules are TypeScript with their types stripped by Node and two
bare specifiers rewritten, so what runs in the browser is the file on disk.

**Every URL the browser fetches carries a digest and is immutable for a year.** `weft dev` serves
the same bytes at stable names with `no-store`, because a stylesheet you just edited served as
immutable is a framework that lies to you for a year.

---

## What is in the box

- **A compiler** that turns TSX into a template IR, infers what each fragment reads, and derives the
  cache class from it. A key you can hand-write is a key that can disagree with the code, so there
  is no setter for one anywhere in the framework.
- **A request lifecycle that is a state machine.** Five states, and the streaming phase is a
  _different context type_ with no envelope methods on it — so the mistake every other framework
  documents cannot be written here.
- **Render as a DAG.** `needs` is data dependency only: nine slots, three waves, a 42.7 ms critical
  path against a 123.3 ms sequential walk. Safe because render is provably read-only.
- **Static output where a page earns it.** A page that reads nothing is a file; a page whose
  parameters are a declared set is several. `weft build` proves each one by rendering it twice under
  deliberately different requests, and prints the reason for every page that stayed dynamic.
- **Epochs.** Staged frames paint nothing; one `COMMIT` flips every slot at once. 254 bytes on the
  client.
- **Live regions.** A region is a fragment that lives somewhere else — this process, a service
  binding, another pod — and the same region composed in-process and over a binding produces
  byte-identical markup. Rolling one is a registry write, not a redeploy.
- **Authority in two questions.** A capability is a property of the caller; a signature is a property
  of the call. Deny by default, deny on failure, and a capability no role can grant fails the build
  rather than becoming a 403 nobody can explain.
- **Fourteen ports, fourteen implementations**, eleven bound by the front door with no
  configuration. A port that is not bound refuses by name and never approximates.
- **A kernel that imports nothing but the WinterTC Minimum Common Web API.** That rule has a test,
  and the test failed on its first run.
- **One third-party runtime dependency in the whole framework**: `oxc-parser`, in the compiler.

[`DESIGN.md`](DESIGN.md) is the long form — each of these with its argument, its measurement, and
the things it refuses to do.

---

## Running this repository

```sh
pnpm install
pnpm build      # ten packages, in dependency order
pnpm demo       # six shapes of page        :4173
pnpm inspect    # every mechanism, running  :4180
pnpm docs:dev   # the documentation site    :4190
```

All three are weft applications. `demo/` imports `weft` and nothing else; `@weftjs/inspector` reaches
into the kernel, the plan layer and the adapters, because taking those apart is what it is for; and
**the documentation site is itself a weft application** — 14 routes, 27 sealed templates, and 370
files after a build, most of it generated from the source rather than written beside it so it cannot
drift.

```sh
pnpm release:dry   # what a release would bump, write and publish — writing nothing
pnpm release       # bump, changelog, commit, tag, push, publish, GitHub release
```

A release is cut from `main` from a laptop. There is no CI, so the release script does the checking a
pipeline would: nothing is written until formatting, lint, types, the build and the tests have
passed, every tarball has been packed and inspected, and every name has been confirmed publishable.
A commit's scopes decide which packages move, and everything depending on one of those moves with it.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the rest: what each package does, how to run the tests and
the benchmark lanes, how to take a feature from a spec document to a shipped gate, how a release
works and how to undo one, and the conventions.

---

## Packages

The version in each row is what the last release put on the registry; `pnpm release` writes this
table.

<!-- versions:start -->

| Package             | Version                                                   | What it is                                                                    |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@weftjs/core`      | [`0.1.1`](https://www.npmjs.com/package/@weftjs/core)     | The framework. The CLI, the conventions, and what an application imports      |
| `create-weft`       | [`0.1.1`](https://www.npmjs.com/package/create-weft)      | `npm create weft` — a shim over the templates that ship inside `@weftjs/core` |
| `@weftjs/ir`        | [`0.1.1`](https://www.npmjs.com/package/@weftjs/ir)       | The template IR: what a compiled fragment is                                  |
| `@weftjs/warp`      | [`0.1.0`](https://www.npmjs.com/package/@weftjs/warp)     | The frame vocabulary that carries it                                          |
| `@weftjs/compiler`  | [`0.1.1`](https://www.npmjs.com/package/@weftjs/compiler) | TSX to IR, on Oxc, with the type-driven escape class                          |
| `@weftjs/client`    | [`0.1.0`](https://www.npmjs.com/package/@weftjs/client)   | Adoption, signals, deltas, patches, navigation                                |
| `@weftjs/kernel`    | [`0.1.1`](https://www.npmjs.com/package/@weftjs/kernel)   | Routing, the request lifecycle, cache keys, waves, epochs, surgical refresh   |
| `@weftjs/plan`      | [`0.1.1`](https://www.npmjs.com/package/@weftjs/plan)     | The plan DSL, validation against inferred effects, plugins, `weft why`        |
| `@weftjs/adapters`  | [`0.1.1`](https://www.npmjs.com/package/@weftjs/adapters) | The fourteen ports, implemented                                               |
| `@weftjs/bench`     | _not published_                                           | The measurement harness, and the gates it enforces                            |
| `@weftjs/docs`      | _not published_                                           | The documentation site, which is a weft application                           |
| `@weftjs/inspector` | _not published_                                           | A station per capability, each with a control you can turn                    |

<!-- versions:end -->

---

## Documentation

| Where                                  | What it is                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm docs:dev`                        | Quick Start, a 21-page Guide, Tutorial, Examples, API, Glossary, Errors, a playground |
| [`spec/`](spec/)                       | The reference: each mechanism, its refusals, and what it deliberately does not do     |
| [`spec/FINDINGS.md`](spec/FINDINGS.md) | Every claim a measurement reversed, with both numbers                                 |
| [`DESIGN.md`](DESIGN.md)               | The long form, and the full spec-to-implementation map                                |
| `pnpm inspect`                         | The same capabilities, running, with a control per station                            |

Three of those are gates rather than documents. Every spec document must have an inspector station
and a guide page that introduces it; all 1,367 importable names must carry a doc comment; all 326
named refusals must say something other than their own name. Each is a test, and each fails the
build when it stops being true.

---

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). Conventional Commits, exact dependency versions, oxlint and
Prettier, and a checklist to run before you push.

## License

[MIT](LICENSE)
