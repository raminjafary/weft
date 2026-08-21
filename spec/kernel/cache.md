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
in `@weft/ir` excludes `flag:` reads accordingly. The design's own worked example includes
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

## What this does not do yet

- **No L0.** A fragment that reads nothing is classified `static` and could be resolved at
  build time and served by a CDN with the kernel never invoked. Nothing does that yet; it
  renders and caches like anything else.
- **No stampede coalescing in the request path.** `StorePort.lease` exists and is
  implemented; `createKernel` does not take a lease before rendering a miss, so two
  concurrent misses render twice.
- **No ETag.** `Cache-Control` and `Vary` are derived; the design's third HTTP-tier
  derivation is not.
- **No `stale-if-error`.** `onExceed: 'stale'` degrades to the placeholder because the
  kernel does not yet hand the last cached value to `degrade()`.
