# L0: the documents that are files

The cache ladder in [`cache.md`](cache.md) ends at a tier the design describes and the kernel
never had: a fragment that reads nothing "could be resolved at build time and served by a CDN
with the kernel never invoked — the fastest tier by a wide margin, and free." Until now it
rendered and cached like anything else, which meant the cheapest thing in the design was the one
thing not implemented.

It is implemented at the level of a **document** rather than a fragment, and that is the whole
of the design decision. A static fragment inside a page that reads something is already handled
— it is a slot with a content-addressed key and a store hit. What a fragment alone cannot be is
a _file_: a file answers a URL, and a URL is a route. So L0 asks whether **this page**, whole,
is decided before any request exists.

## Two decisions, and why one of them is not enough

`weft build` writes a document only when both halves agree.

**Structural**, from what the compiler and the plan already know:

| Refused           | When                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `L0_PARAMS`       | the pattern takes a parameter, so there is no single URL to write        |
| `L0_READS`        | the layout or any fragment on the page has a non-empty read set          |
| `L0_ISOLATED`     | a fragment composes a private instance the kernel fills separately       |
| `L0_LIVE`         | a slot is refreshed over the channel                                     |
| `L0_REFRESH`      | a slot declares a refresh interval, which is a statement that it changes |
| `L0_BUDGET_FOR`   | a slot takes its budget from the request, so its render can vary with it |
| `L0_OUT_OF_ORDER` | a slot streams — see below                                               |
| `L0_GUARD`        | the route has a guard, which decides in the envelope phase               |

**Empirical**, by rendering the route through the real kernel twice, under two requests that
differ in everything a static document is allowed to be indifferent to — cookies, locale,
device, an arbitrary header, the query string, every flag flipped to its last declared value,
and a clock ten years apart — and requiring identical bytes:

| Refused         | When                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `L0_VARIES`     | the two renders differ. The reason names the axis, found by one-at-a-time |
| `L0_DEGRADED`   | a slot degraded to its placeholder while the build rendered it            |
| `L0_STATUS`     | it answered anything other than 200                                       |
| `L0_SET_COOKIE` | the response carries a `Set-Cookie`                                       |
| `L0_FAILED`     | rendering it threw                                                        |

The structural half alone would be wrong, and the reason is worth stating plainly: **the effect
set does not cover the route's own declaration.** A fragment's reads are inferred by the
compiler and the untracked-effect ban keeps that set complete — but `load`, an `html` thunk and
a `head` function live in a `.data.ts`, which nothing compiles. A page whose fragments read
nothing and whose loader reads a cookie is classified `static` and is not. The probe is what
catches it, and it catches it by measurement rather than by declaration, which is the standard
every other claim in this repository is held to.

`L0_DEGRADED` came out of the implementation rather than the design. The kernel degrades a slot
that throws to its placeholder, which is right for a request and wrong for a file: written out,
the failure becomes a page that looks deliberate and never fails again. The first document this
feature ever produced contained one.

## What is still not caught, and is therefore stated

A loader that reads the wall clock or the environment **directly** — not through `ctx` — is
invisible to both halves unless the value it read reaches the bytes. That is exactly the case
the compiler's ban exists to prevent, and the ban does not reach `.data.ts` because `.data.ts`
is not compiled. The probe varies everything the framework can vary; it cannot vary something
the framework never touched.

**A query key the probe does not invent is the same hole, and it is reachable by accident.** The
query axis sends `?weft-probe=1&sort=price`, so a loader reading `ctx.query('sort')` is caught. One
reading `ctx.query('src')` is not: it gets `undefined` under both probes, the bytes match, and the
page is written as a file that ignores the parameter it exists to read. The empirical half cannot
close this — no fixed query string covers every key an application might read — and the structural
half cannot either, because a loader is not compiled.

So the route declares it. `defineRoute({ static: false, notStaticBecause: '…' })` is refused as
`L0_DECLARED` with that text as the reason, checked before the derivations that would otherwise
prove the page invariant. It is an opt-_out_: a page that forgot it is a page whose author believed
the derivation, and the derivation is right nearly always. The documentation site's playground is
the case that found this — its whole body is `?src` compiled — and it is the reason the field
exists rather than an example invented for it.

The honest fix would be to _observe_ rather than guess: every read goes through `Reads`, which
already records what was actually read, so a render whose observed set contains an unenumerable key
could be refused by name. That is not built, and the reason is a byte budget rather than a design
argument — surfacing the observation means a field on `KernelTrace`, `entry-request.ts` has fourteen
bytes of headroom against the design's own 8 KB figure, and a capability that does not fit needs a
seam. See [`budgets.md`](budgets.md).

## Why a streaming slot is refused

An out-of-order document is filled in **completion order** — `Promise.race` over the inflight
slots — so the byte order of the response is a property of that render rather than of the page.
Two renders of the same static page can legitimately differ. Rendering L0 documents in-order
instead would have produced a better file and a worse guarantee: the bytes would then not be the
ones this application serves. So it is refused, and the refusal names the fix. A page with
nothing slow on it gives up nothing by buffering its slots, and the plan already derives
`in-order` when none of them streams.

## What the build writes

```
.weft/static/
  index.html                  /
  app/article/index.html      /app/article
  manifest.json               every document, and every refusal with its reason
```

The directory can be handed to a CDN as it is. `manifest.json` carries, per document, the path
it answers, the file, its byte count, an ETag over its contents, and the headers the build's own
render produced. The refusals are in the same file, because a tier nobody can see is a tier
nobody uses — and the page its author most wants to hear about is the one that nearly made it.

## What `weft start` does with them

The table is loaded once and consulted before anything else on a GET or a HEAD. On a hit the
response is the file, its captured headers, its ETag and `x-weft-tier: l0`; a matching
`If-None-Match` is a 304. Everything below that line — key derivation, the plan, the wave
scheduler, the store, the stream — is work with a known answer.

`weft dev` serves none of them. A dev server answering with a document it rendered before your
last edit is a dev server that lies to you.

**One header is deliberately not the render's.** With no declared policy the kernel emits
`no-store`, because a kernel cannot know whether the thing it just rendered may be held. Here it
can: the document was proved invariant under every axis the framework can vary, so it is served
`public, max-age=0, must-revalidate` with an ETag, and `no-store` would have contradicted the
ETag beside it. A route that declares a policy still gets the one it declared.

**A shared cache may answer with it only if the deployment says so.** `max-age=0, must-revalidate`
lets a CDN store a document and forbids it from ever answering with one, so every navigation to a
page that had been rendered at build time still cost an origin round trip — a tier a shared cache
cannot hold is not really a tier. The window is a number the deployment states rather than one the
framework assumes, because the thing that makes it safe is outside the framework: a deploy that
purges the caches in front of the application. `documents: { shared, stale }` in the config sets it,
and then the header is `public, max-age=0, s-maxage=<shared>, stale-while-revalidate=<stale>`.
`must-revalidate` is dropped in that form, because `s-maxage` grants a window and `must-revalidate`
takes it back on the same line. Unset, the header is unchanged, and the browser's half — revalidate,
get a 304 against the ETag — is unchanged either way.

## Two directories

`public/` is copied. A file in it goes out at the path it was written at, byte for byte, and it is
never immutable — that URL does not name its contents, so a promise to hold it is one the next
build cannot keep. It is where `robots.txt` and a verification file belong, because those have to
be at a URL somebody else chose.

`app/assets/` is processed. Nothing in it is reachable at the path it was written at; every file is
published once under a digest of its own contents and may be held for a year. A page reaches it
through `asset('fonts/inter.woff2')` and a stylesheet reaches it through an ordinary relative
`url()`, which the build rewrites to the revved href.

The rewrite is the reason the directory exists. A font is referenced from a stylesheet, and a
`url()` was a string nothing touched — so the asset that most wants to be immutable was the one
that could not be, whichever directory it was in. Resolution is against the directory the sheet is
in, because that is what a relative URL in CSS already means. Anything that is not relative is left
alone: an absolute path names a URL rather than a file, a scheme belongs to somebody else, `data:`
is already the bytes, and `#blur` points into the document being styled. A relative `url()` that
resolves to nothing is `E_NO_ASSET` at build time rather than a 404 found by a reader.

## The gate

Byte identity, asserted from one deployment against itself
([`demo/test/static.test.ts`](../../demo/test/static.test.ts)): for every document the build
wrote, the file is fetched, then its entry is removed from the table so the same request falls
through to the kernel, and the two responses must be identical. The tier is invisible except in
the headers, which is the only property that makes it safe to have.

The comparison is deliberately not against `weft dev`. Dev serves stable asset URLs that must
never cache and a build serves revved ones, so those two documents differ for a reason that has
nothing to do with L0.

## Where the numbers are

Two of the demo's seven routes are files: `/` at 4,332 B and `/app/article` at 3,035 B. The
other five are refused by name — two for parameters, two for reads, one for a streaming slot.
`weft build` prints the table.

What that is worth is measured rather than asserted —
[`packages/bench/src/measure/l0.ts`](../../packages/bench/src/measure/l0.ts), run as
`node packages/bench/src/cli.ts l0`. One process, one connection, 200 warm samples, and the only
difference between the two runs is whether the document is in the table: removing it is not a
simulation of the kernel path, it is the kernel path.

| Document       | Bytes | L0 ttlb  | Kernel ttlb, warm store |       |
| -------------- | ----- | -------- | ----------------------- | ----- |
| `/`            | 4,332 | 0.073 ms | 0.239 ms                | 3.29× |
| `/app/article` | 3,035 | 0.070 ms | 0.252 ms                | 3.60× |

The kernel run has a **warm** store, which is deliberately the case that flatters it least: the
slots have already been rendered and the difference is only the key derivation, the plan, the
wave dispatch and the stream. Cold, the gap is the render as well. The measurement refuses to
run if the two paths do not produce the same byte count, because a saving measured against a
different document is not a saving.

Both figures are sub-millisecond on a loopback with no network in the way, so the honest reading
is not "3× faster pages" — it is what one origin process has left to spend on the requests that
do need it. The tier's real argument is the directory: these two documents need no origin at
all.

## A file per URL, when the URLs are a set somebody declared

The refusal used to be unconditional and its reason was sound: a pattern with a parameter has no
single URL a file could answer. What it was missing is that a route saying its `category` is one of
two things has _two_ URLs, and each one is as provable as any other document.

```ts
export default defineRoute({
  params: { category: ['pantry', 'household'] },
  slots: { … },
})
```

Four decisions make that safe rather than convenient.

**Nothing is inferred.** A list of categories is the application's knowledge. A framework that
guessed at it would write files for URLs nobody asked for, and be wrong in a way nobody would
notice until a category was added.

**A partial enumeration is refused.** Every parameter in the pattern has to be declared or the route
is `L0_PARAMS` with the missing ones named. Writing files for some URLs of a route and leaving the
rest to the kernel is the one outcome nobody could debug — two visitors on one route getting answers
from two different tiers, for reasons neither the build nor the request can explain.

**A `route:` read of a declared parameter stops being a refusal**, and it is the read that makes the
enumeration worth doing. Every other read is a function of a request nobody can enumerate — a
cookie, an identity, a clock. A declared parameter is a function of a set that is written down.

**Each combination is proved on its own.** The invariance probe runs per URL, not per route: a
passing test for `pantry` says nothing about `household`, and a loader that reads a cookie only when
the category is one of them is exactly the bug this catches. And there is a ceiling — 1,000
documents per route, `L0_TOO_MANY` past it, because three parameters with fifty values each is
125,000 files and a build that wrote them would look like it was working.

A wildcard is still refused. A set nobody can enumerate is not a set.

## Uploading it, over HTTP and nothing else

`weft upload --to <url> --header <k=v>` PUTs the build directory to an object store. There is no
SDK, no credential chain and no provider-shaped configuration, because there does not need to be:
every object store worth using accepts an authenticated `PUT` at a URL, and the authentication is a
header the deployment already knows how to produce. A framework that took a dependency on one
provider's client would have to take one on the next, and the thing being uploaded is a directory of
files with paths and headers, which is what HTTP is for.

Three properties, each a decision rather than a detail:

- **An immutable object already there is skipped.** Every asset URL carries a digest of its
  contents, so a URL that exists already has the right bytes — and a HEAD is cheaper than a PUT by
  the size of the object.
- **A document is never skipped.** An L0 path is a stable URL whose contents change with every
  build, which is the exact inverse. It goes up with the `Cache-Control` the build proved it may
  carry, read from the manifest rather than re-derived — deriving it twice is how a file and an
  origin come to disagree.
- **A failure is per object and does not stop the upload.** A half-uploaded deployment is bad; a
  half-uploaded deployment nobody can enumerate is worse. `weft upload` exits non-zero and prints
  every object with its status.

## What a production build stops shipping

`stripTypeScriptTypes` with `mode: 'strip'` replaces type annotations with whitespace and keeps
comments — right for a source map, wrong for a payload. This framework explains itself at length in
its own modules and every byte of that was reaching browsers that cannot read it.

Removing it halves the client payload: the documentation site went from 59,719 to 29,369 bytes
brotli, the demo from 50,048 to 25,835. `weft dev` keeps every comment, because the one reader who
wants them is the one with devtools open on their own machine.

It is done by **parsing**, not by pattern. `//` inside a string is not a comment, `/*` inside a
template literal is not a comment, and `/` is a comment, a division or a regular-expression
delimiter depending on what came before it. A tokenizer that gets that wrong removes a slice of a
working program and ships it, silently. So `stripComments` lives in `@weftjs/compiler`, which
already owns the only third-party parser this framework has; the spans come from the parser, a block
comment that spanned lines leaves a newline behind because it may have been the only statement
separator there was, and `/*!`, `@license` and `@preserve` are kept.

`weft start` transforms each module once and memoises it by URL. The path already carries a digest
of the bundle, so a URL that would produce different bytes is a different URL. It was 4.7 ms per
request for the boot module before, which a CDN deployment never noticed and every host that keeps
a process paid forever.

## What a document says about itself

Three things the framework supplies to a layout, because all three are its own knowledge and a
hand-maintained copy goes stale the first time somebody adds a file.

**`preload`** — `<link rel="modulepreload">` for every module the page will fetch. With no bundler a
browser finds the graph by following imports, so a module three deep is three round trips away;
naming the set in the head collapses that to one. Walked from the real import graph, which is the
same walk the byte budget measures — one function with two callers, because when they were two
walks the figure drifted from what was served. `import()` is not followed: a dynamic import is the
code a page decided _not_ to need yet.

**`canonical`** — built from the route's own pattern rather than from the request, which is the
point of the tag: a request carrying a tracking parameter or an alternate casing is the same page,
and the route is what says so. It carries `og:url` with it.

**`sitemap.xml`** — written by `weft site` from the documents it just published, so it cannot name a
page that does not exist or miss one that does. Documents only; an asset is not a page.

The last two need an origin, and the origin is the one thing a build genuinely cannot derive — the
same output is served from a preview URL, a staging host and a domain. So it is `site: { origin }`
in the config, and without it no sitemap is written and no canonical is emitted. An absence rather
than a guess: a canonical pointing at the wrong host is worse for a crawler than none at all.

## What this does not do yet

- **The kernel is not invoked at serve time, and the process still is.** Serving from
  `weft start` is one map lookup rather than a render, and that is the local demonstration of
  the claim. Serving with the origin off entirely is what the directory is for.
