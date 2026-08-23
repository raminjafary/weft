# Routing, and the seam it closes

The two halves built before this one were a kernel that took a hand-assembled route and a plan
layer that produced a plan, with nothing joining them. This is the join, and it is deliberately
three small pieces rather than one framework feature.

| Piece                         | Knows about                                   | Lives in       |
| ----------------------------- | --------------------------------------------- | -------------- |
| `createRouter`                | paths and params. Nothing else                | `@weft/kernel` |
| `factsFrom` / `fillableHoles` | what the compiler emitted                     | `@weft/plan`   |
| `lowerPlan`                   | a plan, some facts, and one bindings object   | `@weft/plan`   |
| `kernel.serve`                | how to put the three together for one request | `@weft/kernel` |

## The router

```
/cart              a static path
/product/:sku      a param, captured under its name
/checkout/*        a wildcard, captured under '*'
```

**Specificity decides, never declaration order.** Static beats a param, a param beats a
wildcard, segment by segment. `/product/new` wins over `/product/:sku` and `/a/:id` wins over
`/a/*` whether or not anybody remembered to write them in the right sequence — a table whose
behaviour depends on the order somebody happened to write it in is a table nobody can safely
refactor.

Two patterns that can match the same path always disagree at some segment, which is why
comparing ranks positionally is enough. Between patterns that cannot collide the order is
deterministic and uninteresting, and the spec makes no promise about it.

Refused at construction rather than at request time:

| Code               | When                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `E_BAD_PATTERN`    | no leading `/`, a `*` that is not last, or a param name repeated                      |
| `E_ROUTE_CONFLICT` | two patterns matching the same paths — compared on shape, so `:sku` and `:id` collide |

A trailing slash is not a different route. A param is percent-decoded, because it becomes a
cache key component, and **an invalid escape fails the match** rather than reaching the key as
something the request did not contain.

## The shell, and the boundaries it leaves

A route is a document with holes in it. `shell(id)` names the fragment that is the document, and
the plan's slots fill its boundaries. Both sides are already written down — one by an author,
one by the compiler — so a disagreement is a build error:

| Code                    | When                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `E_NO_SHELL`            | a plan declares slots and no document for them to fill                     |
| `E_SLOT_NOT_IN_SHELL`   | a slot names a boundary the shell does not leave, listing the ones it does |
| `E_SHELL_HOLE_UNFILLED` | the shell leaves a boundary nothing fills                                  |
| `E_DUPLICATE_SHELL`     | two shells                                                                 |

`fillableHoles` is what makes that check possible, and it treats a streaming `slot` hole and an
**isolated component instance** as one list. Both are holes this render does not own — one left
for slow work, one for work with a different cache class — so a plan can attach a policy to
either without a second concept.

## The shell is a fragment, so its reads count

`KernelRoute.shell` carries the shell's identity, version and inferred effects, and the
document's `Vary` is the union of the shell's and its slots'. Before this existed, a shell that
read a cookie was left out of `Vary` entirely, and the document was advertised as shareable on
the strength of its slots alone.

The shell's values are a function of the matched **params only**. It renders as the plan is
resolved, before phase B exists, so it cannot read through a context — a shell that needs a
request read either does it in `envelope`, or that region is a slot. That is stated rather than
worked around.

## Lowering

```ts
lowerPlan(plan, { facts }, bindings) → (params) => KernelRoute
```

`lowerPlan` **validates before it lowers**, so an invalid plan cannot become a route at all.
A build error is only a build error if nothing downstream can proceed past it.

It refuses two more things a plan alone cannot catch:

- `E_SLOT_UNBOUND` — a slot with no binding, so there would be nothing to render it with.
- `E_UNKNOWN_GUARD` — a guard with no handler. This one matters more than it looks: a guard the
  runtime cannot evaluate would silently pass.

Two properties are derived rather than defaulted:

**The streaming order.** `out-of-order` the moment any slot asks to stream, `in-order` when
none does. A plan whose slots all buffer has expressed no interest in arrival order, and
in-order needs no fill mechanism — so the cheaper answer is the derived one rather than the
default one.

**Phase A.** Guards run before any byte leaves, by construction. The first guard to refuse
decides; running the rest would let a later one overwrite a redirect already settled on. A
declared `redirect` becomes a real 302 with the envelope still open; a guard with no redirect
calls `envelope.refuse(status)`, which ends the request with no body.

`refuse` is a separate act from `status` on purpose. A route is entitled to serve a 404 page, so
if refusing were just a status code, a guard and an error page would be indistinguishable to the
kernel.

## Serving

```ts
const kernel = createKernel({ ports, routes })
await kernel.serve(request)
```

Match, resolve the route for the matched params, handle it. An unmatched path is a 404 and the
trace records that nothing was planned. `serve()` with no route table throws `E_NO_ROUTES`
rather than inventing one.

`kernel.trace.matched` names the pattern and the params, and `kernel.trace.document` carries the
shell's own resolved key.

## What routing cost

| Entry                          | Before  | After   | Ceiling |
| ------------------------------ | ------- | ------- | ------- |
| Document request path (brotli) | 7,602 B | 7,833 B | 8,192 B |

231 bytes, leaving 359. The design's "under 8 KB server-side" still holds.

359 bytes was small enough to be a real constraint, and what came of it is in
[`budgets.md`](budgets.md): the plugin ordering graph and the dev-only read guard came out of the
request path, which returned 473 bytes, and the claim is now scoped to the document request path
by name rather than covering "the kernel" and being renegotiated per feature. Current figure is
7,360 B with 832 of headroom.

The kernel's source-line check fired at the same time, at 2,770 against a 2,500 ceiling.
Routing is one of the four jobs the design gives a kernel, so the ceiling moved to 2,900 — and
the check now says what it is for. The byte budget is the gate; the line count is a smell
detector for the kernel absorbing work that belongs in a port.

## Lazy plan extension

The whole table is still resolved at construction — that part of the note below was about the
_server_, and it stays true. What has changed is what a **client** knows about it.

`WARM plan=/checkout/*` asks about a subtree; a `PLAN` frame answers with a record per route:

| Field     | What a client would otherwise do to learn it                                        |
| --------- | ----------------------------------------------------------------------------------- |
| `pattern` | Nothing — it can read a link                                                        |
| `shell`   | Ask the server to stage the route, and be told `form=document` after a whole render |
| `shared`  | The same, precomputed against this connection's own page                            |
| `slots`   | Fetch the document                                                                  |
| `css`     | Fetch the document, then fetch the stylesheet it links                              |
| `tpl`     | Fetch the document and find out which templates it needed                           |
| `next`    | Nothing. Only the server has the profile                                            |

The one that pays for itself immediately is `shell`. Staging a route the reader has not clicked
costs a round trip _and_ a server render, and for a link into a different document that render is
thrown away: a different shell has different holes, so its regions cannot be swapped into the ones
on screen. Described in advance, the client fetches the document instead and spends neither. The
decision is still the server's — this is the server's own answer, given earlier and for a subtree
rather than one link at a time.

**A `PLAN` also arrives unasked, once, when a channel opens.** Everything else in the protocol
answers a question the client posed; this one exists because the client cannot pose it. A page has
no route table to notice a gap in, and the thing most worth telling it — where readers of this page
go next — is a measurement only the server has. Before this, `NAV next=` reached only a client that
had already staged something over the channel, so a first visit, the visit it would have helped
most, heard nothing.

The handshake answer is deliberately narrow: this route, and the routes the profile says its readers
go to next. A route table pushed at every page load would be a cost every reader pays for a page
most of them will not leave by a link.

**Describing a route runs no loader**, which is the difference between this and staging one, and the
reason a page can afford to know about thirty routes and stage two. The answer is capped, and a
truncated one says `complete=false` — a silent cap reads to the client as "that is the whole
subtree", which is the one wrong thing it could conclude. A prefix matching nothing is answered with
an empty `PLAN` rather than a silence, because a client that hears nothing cannot tell that from a
frame still in flight.

On the client, `weft.discover('/checkout/*')` is the design's `router.discover`, asked once per
prefix. The registry it fills re-implements the router's specificity rule — static beats a param,
a param beats a wildcard — because a client that decided differently would answer a click on the
strength of a route the server would not have chosen. Both spellings are tested against the same
cases, including the one where `/docs` matches `/docs/*`.

## What this does not do yet

- **No method matching.** The table is path-only. Methods belong with intents, which do not
  exist, and a route that matched on method today would have nothing to dispatch to.
- **The server's table is still resolved at construction.** Lazy plan extension is about what the
  client knows, above; a server that discovered its own routes at request time is a different
  feature and nothing needs it.
- **No nested routes or layouts.** A route names one shell. A shell that is itself a region of
  another shell is the app-shell design in phase 9.
- **No `RegistryPort`.** Resolving a region name to a deployment is what makes routing portable
  across deployments, and it is still one of the four declared-but-unimplemented ports.
- **A plan is still assembled by hand.** `factsFrom` takes compiler output, but nothing generates
  the plan or the bindings from a file convention or a profile.
- **Params do not taint by themselves.** A fragment that should vary by `:sku` has to read
  `ctx.param('sku')`; matching a path does not put the param in any key. That is correct — a
  fragment that ignores the param renders the same bytes — and it is worth knowing, because a
  fragment reading nothing is one cache entry across every path that route matches.
