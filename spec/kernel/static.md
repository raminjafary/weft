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

## What this does not do yet

- **No parameterised routes.** A route with an enumerable parameter set — a flag axis, a list of
  categories the application could declare — is the obvious next tier, and nothing declares that
  set today, so there is nothing to enumerate.
- **No CDN upload.** The directory is uploadable; the framework does not upload it.
- **The kernel is not invoked at serve time, and the process still is.** Serving from
  `weft start` is one map lookup rather than a render, and that is the local demonstration of
  the claim. Serving with the origin off entirely is what the directory is for.
