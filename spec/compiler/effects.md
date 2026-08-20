# Effects, and the ban that has to come with them

Everything distinctive about this design is _derived_ from what a render read: the cache
key, the cache class, `Vary`, whether a fragment can resolve at build time, whether it may
ever reach a CDN. None of it is declared, because a declaration can be wrong and a
derivation cannot.

That only holds if the read set is complete. The design says so in the strongest terms it
uses anywhere: _"one direct `req.headers` or `process.env` read punches a hole in the entire
cacheability guarantee. This needs a hard lint-level ban from day one, not a documentation
note."_ This is the ban.

## The read surface

Every call here taints. Nothing else does — a call on the context that is not in this table
is a compile error rather than an untracked read.

| Call                            | Taint               | Consequence                                                                 |
| ------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `ctx.flag(f)`                   | `flag:name`         | A plan axis: only the resolved branch is reachable                          |
| `ctx.cookie(k)`                 | `cookie:k`          | Shared, keyed by value, adds `Cookie` to `Vary`                             |
| `ctx.header(k)`                 | `header:k`          | Shared, keyed by value, adds that header to `Vary`                          |
| `ctx.param(k)` / `ctx.query(k)` | `route:k`           | Shared; already part of the route key                                       |
| `ctx.locale()` / `ctx.device()` | `locale` / `device` | Shared, low cardinality — good for ahead-of-time permutations               |
| `ctx.user()`                    | `identity`          | **Private.** Never shared, never a CDN entry                                |
| `ctx.now()`                     | `time`              | Forces a TTL, and stays out of the key                                      |
| `ctx.raw(fn)`                   | `opaque`            | The escape hatch: uncacheable, private, reported, and local to the fragment |

A key has to be a string literal. `ctx.cookie(k)` where `k` is computed is
`E_DYNAMIC_TAINT`, because a cache key cannot be derived from a value the compiler cannot
see. A flag is _referenced_ rather than named, so an imported identifier is the normal form
and `newCart` becomes `flag:new-cart`.

Reads are sorted before they are stored, so a cache key never depends on the order somebody
happened to write them in. They are part of the template's content address, which means
adding a read moves the version — as it must, since the cached thing is now a different
thing.

## What is derived from them

```
reads = []                                   → static: resolves at build time, served from a CDN
reads = [cookie:currency, locale]            → shared: Vary: Accept-Language, Cookie
reads = [cookie:currency, identity]          → private: never shared, identity in the key
reads = [time, ...]                          → a cache policy without a TTL is a build error
reads = [flag:new-cart, ...]                 → an axis, not a key component
```

`cacheClassOf`, `keyComponents`, `flagAxes`, `varyOn`, `requiresTtl` and `explain` all live
in `@weft/ir` and take nothing but the effect set. `explain` is what a `weft why` would
print, and the compiler already prints it per template:

```
ee7b762c  4 holes (0 elided)  0 wiring  packages/compiler/fixtures/reads.tsx#default
          shared — reads cookie:currency, locale, route:region · Vary: Accept-Language, Cookie
```

## The ban

Each of these is a hard error naming the read and the alternative, because the point is to
redirect the read rather than to scold.

| Refused                                                     | Code                   | Instead                                                     |
| ----------------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `process.env`, `process.*`                                  | `E_UNTRACKED_EFFECT`   | A port, or `ctx.raw()` if it is genuinely opaque            |
| `Date.now()`, `new Date()`, `performance.now()`             | `E_UNTRACKED_EFFECT`   | `ctx.now()`, which taints `time` and forces a TTL           |
| `Math.random()`                                             | `E_UNTRACKED_EFFECT`   | A value passed in, or `ctx.raw()`                           |
| `window`, `document`, `location`, `navigator`, `globalThis` | `E_UNTRACKED_EFFECT`   | `ctx.device()`, `ctx.locale()`, `ctx.param()`               |
| `ctx.anythingElse()`                                        | `E_UNKNOWN_EFFECT`     | The surface above, which is the whole surface               |
| `ctx.setCookie()`, `ctx.status()`, `ctx.redirect()`         | `E_ENVELOPE_IN_RENDER` | The envelope phase, which settles before any hole is filled |
| `{ctx.locale()}` inline in markup                           | `E_CTX_IN_MARKUP`      | Read it into a value in the body first                      |

That last one is worth explaining, because it looks like fussiness. A read inlined into an
attribute or a text hole is still tracked — the walk covers the whole fragment — but it
leaves nothing for the value to be _called_, and a cache key entry with no name is a
debugging problem later. Naming the read is a one-line cost and it makes `weft why`
readable.

## Where a fragment gets its context

```tsx
export default fragment((ctx) => { … })            // the context
export default fragment(({ currency }) => { … })   // props
export default fragment(({ currency }, ctx) => …)  // both
```

A bare identifier parameter is always the context, because a fragment that wants props
destructures them. Anything the body computes can then be interpolated, whatever it was
computed from — which is what makes `const currency = ctx.cookie('currency') ?? 'IQD'`
usable as `{currency}` in the markup.

## Contagion, and where it stops

A fragment's effects are its own reads plus the reads of the fragments it renders. A child
that reads `cookie:currency` makes its caller `shared` and adds `Cookie` to its `Vary`,
because the child's bytes are inside the caller's response and there is no honest way to
call that entry anything else.

The design's rule is that this must not go all the way: **a private fragment should not
make its route private.** That containment is not a special case in the effect union, it is
a change of shape. A private child inside a non-private parent is _isolated_ — the parent's
hole is marked `isolated`, the parent does not render it, and the kernel composes the two
at stream time from two cache entries. The shell stays shareable because the private bytes
were never in it.

The decision uses the parent's **own** class, not its composed one, so it does not depend
on which child is examined first:

| Parent's own reads | Child   | Result                                            |
| ------------------ | ------- | ------------------------------------------------- |
| static or shared   | private | isolated — its own cache unit, cut like a slot    |
| private            | private | inlined — there is nothing left to contain        |
| anything           | shared  | inlined — the reads compose into the parent's key |

An isolated instance costs the `delta` form on its parent, exactly as a slot does: a hole
this render does not fill is not projectable from values the parent holds.

Only `private` isolates. A shared child inside a static parent still composes, because the
cost there is a wider cache key rather than a correctness problem, and cutting on it would
turn every cookie read into a separate request.

## What this does not do yet

- **No cache-policy checking.** `requiresTtl` reports that a TTL is needed; there is no
  `.cache()` declaration for it to contradict, so the build error the design promises
  ("a `.cache('public')` declaration anywhere on this slot becomes a build error naming the
  read that caused it") has nothing to fire against yet.
- **No writes, and no envelope set.** `EffectSet.writes` and `.envelope` stay empty:
  invalidation happens in intents and API routes, which do not exist.
- **Reads are not resolved.** The compiler records _which_ reads taint. Turning those into
  an actual key needs their values, which is a runtime job the kernel does not do yet.
