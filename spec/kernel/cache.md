# Runtime cache keys, derived from what a render read

The compiler records _which_ reads taint a fragment. This is the piece that resolves their
values for a concrete request and hashes them, which is what makes effect inference
load-bearing rather than descriptive.

Nothing here is written by hand. There is no key setter anywhere in the kernel, the plan DSL,
or the plugin surface, and **that absence is the enforcement** — a key that can be hand-set
can drift from what the code reads, and that drift is the bug the whole design exists to
remove.

## The key is resolved before the render

```
resolveKey → store.get → hit: bytes, no render at all
                       → miss: executor.run(render) → store.set
```

On a hit there is no render, so nothing about the key can depend on the render happening.
This is why `resolveRead` resolves taints directly from the request and the ports rather than
observing what a fragment did.

## The material

```
cart-summary@a91f cookie:currency=IQD flag:new-cart=on
```

`h(id@version, sorted reads with values, sorted axes with values)`, SHA-256 truncated to 128
bits. `keyMaterial()` is exported and readable, because a key nobody can explain is a key
nobody can debug — it is what `weft why` prints.

Sorted, so a key never depends on the order somebody happened to write their reads in.
Version-addressed, so a template edit is a different cached thing.

## Resolution, read by read

| Taint       | Resolved from                               | In the key              |
| ----------- | ------------------------------------------- | ----------------------- |
| `cookie:k`  | `SessionPort.cookie`                        | yes                     |
| `header:k`  | request headers                             | yes                     |
| `route:k`   | route params, then the query string         | yes                     |
| `locale`    | `Accept-Language`, first tag, lowercased    | yes                     |
| `device`    | `Sec-CH-UA-Mobile`, then the UA. Two values | yes                     |
| `identity`  | `SessionPort.identity`                      | yes, and forces private |
| `flag:name` | `FlagPort.resolve`                          | yes, as an axis         |
| `time`      | nothing                                     | **no** — it is a TTL    |
| `opaque`    | nothing                                     | **no key at all**       |

A taint the compiler tracks and the kernel cannot resolve is `E_UNRESOLVABLE_READ`. It is not
skipped, because a key missing one of its components is worse than no key.

`device` is deliberately coarse. A high-cardinality device string would be a
high-cardinality cache key, which is the same mistake as putting the clock in the key.

## A correction to the design: an axis is also a key component

The design's prose says a flag is "an axis rather than a key component", and `keyComponents()`
in `@weftjs/ir` excludes `flag:` reads accordingly. The design's own worked example includes
one:

```
derived key = h(cart-summary@a91f, new-cart=on, currency=IQD)
```

Both are right about different things, and the kernel implements both. An axis **partitions
the plan**, which is what makes the losing branch's chunks unreachable — that is why it is
reported separately from `components`. It is still **in the key**, because two flag
resolutions produce different bytes and one entry cannot hold both.

So `ResolvedKey` carries `components` and `axes` as separate fields, and `keyMaterial`
includes both.

## Two corrections a generated plan needed and a hand-written one does not

A cache key is `id@version` plus the reads the compiler saw, resolved before the render — which is
sound while a fragment's values are a function of its own reads, true when an application binds one
fragment to one slot by hand. A **generated** plan breaks that assumption twice.

**The id has to be scoped to the route and the slot.** Four pages can bind the framework's own
`markup` fragment to four slots with four different loaders, and `markup` itself reads nothing — so
all four resolve to the same key, and the first one to render answers for the rest. `weft`'s
generator scopes every slot's id to `${slot.id}@${route pattern}:${slot name}`, which is what makes
them four cached things again. Two tabs on the same route and slot still share one entry, which is
the sharing that was ever worth having.

**A route's own params have to be folded into the identity.** `/app/ordinary/:category` is one
route, one slot and one template, and its loader lives in a `.data.ts` the compiler never reads — so
`route:category` is never in the effect set, the key cannot contain it, and whichever category
rendered first answers for every other one. Route params are a _bounded_ set, so folding them into
the id costs one entry per value rather than a wrong page — the same trade would be unbounded for a
query string, which is why what the generator instead reads out of the declaration file and folds
into `effects.reads` is a `route:` taint. Scoped per route rather than per slot, because a read in
one slot's loader taints every slot the route generates: a shared taint costs an entry that could
have been split, and the opposite mistake costs a wrong page.

The same correction applies one level up, to the **document**. Every page sharing `layout.tsx`
shares its id and version, so a document-level cache policy keyed on that alone would make every
page built from the same layout one cache entry. The generator scopes a document's id to the route
pattern the same way, and folds into its effects whatever the route's own `head`, `layoutValues` and
`guard` read — all three live in the `.data.ts` the compiler never sees, and any of them may read the
request.

## What is derived alongside the key

| Derived       | From                                       |
| ------------- | ------------------------------------------ |
| `class`       | `cacheClassOf(effects)`                    |
| `vary`        | `varyOn(effects)`                          |
| `ttlRequired` | `requiresTtl(effects)` — i.e. reads `time` |
| `reason`      | all of the above, as one line              |

`cacheHeaders(resolved, policy)` turns that into `Cache-Control` and `Vary`, and refuses two
things:

- `E_PRIVATE_AS_PUBLIC` — a public policy on a fragment classified private. This is not a
  caching bug, it is one user's bytes in a shared cache, so it throws rather than warning.
- `E_TTL_REQUIRED` — a policy with no TTL on a fragment that reads the clock, which would
  never expire.

With no policy at all the answer is `no-store` (`private, no-store` when private). Nothing is
cached by accident.

## The route's own headers

The document contains every slot, so its `Vary` is the union of theirs and its class is the
strictest among them. One private region means the document may not be advertised as shared —
and a route declaring `policy: { class: 'public' }` with a private slot fails the request with
`E_PRIVATE_AS_PUBLIC` rather than emitting the header.

## Fixtures

The unit tests resolve keys from hand-written effect sets, which is right for asserting one
rule and wrong for believing the path works. `packages/kernel/fixtures/cart-route.ts`
assembles a route out of real compiler output — `shell.tsx` with two slot holes filled by
`keyed.tsx` and `private.tsx` — and `packages/kernel/test/integration.test.ts` asserts what
falls out of it rather than what was declared:

| Asserted                                                                                       | Derived from                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Vary: Accept-Language, Cookie, X-Tier`                                                        | the union of what the two fragments read |
| `cache-control: private, no-store`                                                             | one of them reads `identity`             |
| key contains `cookie:currency=IQD`, `route:region=baghdad`, `route:sort=price`, `locale=ar-iq` | `keyed.tsx`'s inferred read set          |
| `new-cart` as an axis, not a component                                                         | it is a `flag:` read                     |
| `ttlRequired`                                                                                  | `keyed.tsx` reads the clock              |
| a flag flip is a different key                                                                 | axes are hashed with the components      |
| second identical request hits the store                                                        | the key is stable across requests        |

`keyed.tsx` exists for this: every read a key can be derived from, in one fragment.
`opaque.tsx` covers the no-key path, and `private.tsx` the identity path. Each of the three
changes the answer rather than adding to it, which is why they are three files.

## The third HTTP derivation, and where it can exist at all

`Cache-Control` and `Vary` are derived from the effect signature. An `ETag` cannot be, and the
reason is the same two-phase envelope the whole lifecycle is built on: a strong entity tag is a
digest of the entity, and the envelope is sealed before the first body byte. There is no moment at
which a streaming response knows what it is about to say.

So the tag comes from the one layer that has not written the status line yet — the front door —
and it costs the streaming property. A route declares it:

```ts
export default defineRoute({
  etag: true,
  document: { class: 'public', ttl: '10m' },
  slots: { … },   // every one of them buffered
})
```

and three rules make it honest rather than convenient:

- **A page that streams cannot have one.** `orderOf` derives `out-of-order` from any slot that
  asked to stream, so declaring both is `E_ETAG_STREAMS` at build time, naming the slots. The
  alternative — quietly holding a streaming page back to digest it — would be the framework
  trading away the property it is built on without saying so.
- **A `no-store` response gets no tag.** A validator is a promise about a copy the client keeps,
  and the response has just told it not to keep one. This is also why the declaration is usually
  accompanied by a `document` policy: nothing is cached by accident here, so a page whose document
  policy is absent is `no-store` and has nothing to validate.
- **The digest is SHA-256 truncated to 128 bits**, not the cheap hash a base-render id uses. A
  base-render collision costs a wire form; an entity-tag collision serves the wrong page to somebody
  who asked whether their copy was current. L0's own tags moved to the same digest for the same
  reason.

What this buys is the whole body: a return visit to a conditional page is a 304 and nothing else.
What it costs is time-to-first-byte on the miss, which is why it is a route's decision and not a
default.

## Serving the last good render

`onExceed: 'stale'` means what it says now. The last good render of a slot is the **expired entry
under that slot's own key**, so the policy needs no second key, no second write, and nothing on the
success path: the store is asked to read past the TTL exactly once, by the request whose render has
already failed and whose only other answer is a placeholder.

`StorePort.get(key, { stale: true })` is that read, and it is the only caller entitled to make it.
Two rules:

- **An expired entry is invisible to an ordinary read.** `memoryStore` keeps it rather than dropping
  it and returns null unless asked, and eviction reclaims it under the same byte ceiling as
  everything else — so the cost of keeping it is bounded by a limit that already existed.
- **An invalidated entry is not recoverable and must not be.** Expiry means _possibly_ out of date;
  invalidation means _known to be wrong_. A tag drop takes the entry with it, and the region degrades
  to its placeholder — because showing somebody bytes the deployment has already declared incorrect
  is worse than showing them a region that is missing.

A tiered store passes the flag down and does **not** promote what comes back: writing an expired
entry into a fresher tier would hand stale bytes to the next reader who never asked for any.

## There are two caches on a route, and a write must reach both

A slot's `cache.tags` decide when _its_ stored bytes are dropped. A route's own `cache` decides how
long the whole assembled response is held. They are separate entries with separate lifetimes, and an
invalidation only reaches the ones carrying the tag.

Miss that and the failure is quiet in the worst way: the write succeeds, the invalidation reports
the tags it dropped, every layer does its job, and the number on the page does not move — because
the slot entry was emptied and the reader was still handed the stored document, whose body had been
rendered once and would not be rendered again until the ttl ran out.

So a tag belongs on both:

```ts
cache: { class: 'public', ttl: '1h', tags: ['votes'] },   // the document
slots: {
  body: { cache: { class: 'public', ttl: '1h', tags: ['votes'] }, live: true, … },
}
```

Or give the document no ttl and let the slots decide. `W_DOCUMENT_OUTLIVES_INVALIDATION` names the
case where neither was done, because the alternative is finding it by hand.

## What this does not do yet

- **L0 is built, and it is a document rather than a fragment.** A page whose every fragment
  reads nothing is rendered at build time, proved not to depend on the request, and written as a
  file `weft start` answers with before the kernel is reached. A static fragment inside a page
  that reads something is still a slot with a content-addressed key, because a file answers a URL
  and a URL is a route. See [`static.md`](static.md).
- **Stampede coalescing is a seam rather than a policy.** `createKernel` takes a `Coalescer`
  and hands it the two things that decide a coalesce; `leaseCoalescer` is the implementation.
  Without one, two concurrent misses still render twice — which is opt-in because the good
  version is store-specific.
- **No `stale-if-error` on the wire.** The kernel serves the last good render itself, as above.
  What it does not do is _advertise_ the directive, which would let an intermediary do the same
  thing on its own copy — and that is a `CachePolicy` field and two lines in `cacheHeaders`, held
  back only because the request path has 38 bytes of headroom and a directive nobody has asked for
  is a poor way to spend them.
- **A conditional response is a declaration rather than a derivation.** A route says `etag: true`;
  nothing infers that a page whose slots all buffer would like to be conditional, because the
  inference would be a framework deciding to hold somebody's page back.
