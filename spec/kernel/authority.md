# Authority

Who may run an intent, and whether this deployment issued the call at all.

Two questions, and neither answers the other. A **capability** is a property of the caller: this
reader holds `cart:checkout`, so they may check out. A **signature** is a property of the call: this
particular checkout was issued by a page this server rendered, for this reader, for this payload,
minutes ago, and has not been used before. A caller who holds a grant can still make a call the
server never offered them; a signed call can still come from somebody entitled to nothing. Both
gates exist and both are checked, in that order.

Until now the first was a seam with nothing behind it and the second did not exist.
`CapabilityCheck` refused every intent that declared a capability — which is honest, and is not a
capability model.

## The three rules of the model

**Deny by default, and deny on failure.** No grants means no. A grant source that throws is
`E_GRANTS_UNAVAILABLE`, which is a denial: an authority check that fails open turns an outage in
the identity service into an escalation for every caller at once. The refusal names the source,
because there is no subject to name.

**Every declared capability, not any of them.** `capabilities: ['cart:write', 'order:create']`
means both are required. Read the other way, a longer declaration would be a weaker one, which is
not what anybody adding to that list means by it.

**A grant that matches everything is refused where it is written.** `*` is `E_GRANT_TOO_BROAD` at
construction. It would make declaring a capability decorative, which is the same argument that
makes an unchecked capability a refusal rather than an allow. What an operator actually wants — a
role holding everything the application declares — is expressible as the list, and the list is
reviewable, because the front door knows the complete declared set from the intent manifest.

`cart:*` covers every capability under that colon and nothing above it. `cart` does not cover
`cartel:write`, which is the trap a `startsWith` gets wrong and a test pins.

## The closed set, checked at build time

Only the front door has both halves: the manifest knows every capability any intent declares, and
`weft.config.ts` knows what a role table can ever grant. So the two are compared once, when the app
is built.

| What                                       | Result                     | Why that severity                                                                       |
| ------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------- |
| An intent requires what no role can grant  | `E_CAPABILITY_UNGRANTABLE` | A permanent 403 whose cause is invisible in the code: both halves look right separately |
| A role grants what no intent declares      | `W_GRANT_UNUSED`           | A stale row, not a broken page                                                          |
| An intent declares and nothing is bound    | `W_NO_CAPABILITY_MODEL`    | Already refused per call; said at startup where somebody can act on it                  |
| A signature is required and cannot be made | `W_NO_SIGNER`              | The mint endpoint refuses by name; the intent is still enforced                         |
| A signature is required and cannot be read | `W_NO_VERIFIER`            | Every call is `E_NO_VERIFIER`, which is a 501 and not a maybe                           |

## Signed intents

Ed25519 over a compact token: `weft1.<claims>.<signature>`, base64url, 263 bytes with a payload
bound and 183 without.

| Claim | Binds                                                                                  |
| ----- | -------------------------------------------------------------------------------------- |
| `kid` | Which pinned public key checks it. Rotation is a key added, not a deploy of both tiers |
| `i`   | The intent, by its opaque id. A token for one intent cannot run another                |
| `s`   | The reader. A token lifted from somebody else's page is not this reader's              |
| `p`   | SHA-256 of the canonical payload. Optional — see below                                 |
| `x`   | Expiry. Five minutes by default: a token is for one interaction, not for a session     |
| `n`   | A nonce, spent on first use                                                            |

**Asymmetric, and that is the point.** The verifier holds public keys only, so a tier that can
check a token cannot mint one. That is the design's authority tier — "small, security-sensitive,
deliberately separable so it can be audited and rate-limited on its own" — expressed as a config
file: `publicKeys` with no `privateKey` is a complete verifying deployment.

**The order of the checks is deliberate.** Signature first, then every claim, then the nonce. A
claim compared before the signature would answer questions about a token nobody has authenticated,
which tells a caller whose forgery was rejected exactly which field to change next. And the nonce
is spent last, so a token that fails for another reason is not also burned.

| Refusal                    | Status | When                                                          |
| -------------------------- | ------ | ------------------------------------------------------------- |
| `E_INTENT_UNSIGNED`        | 401    | The intent is signed and no token came with the call          |
| `E_INTENT_TOKEN_MALFORMED` | 400    | Not three parts, or the claims are not claims                 |
| `E_TOKEN_KEY_UNKNOWN`      | 403    | A `kid` the bundle does not pin                               |
| `E_INTENT_SIGNATURE`       | 403    | The signature does not verify under that key                  |
| `E_INTENT_EXPIRED`         | 401    | Past `x`, allowing for stated skew                            |
| `E_TOKEN_WRONG_INTENT`     | 403    | Issued for another intent                                     |
| `E_TOKEN_WRONG_SUBJECT`    | 403    | Issued for another reader                                     |
| `E_TOKEN_WRONG_PAYLOAD`    | 403    | Issued for another payload                                    |
| `E_INTENT_REPLAYED`        | 409    | The nonce is spent. Well-formed, and not going to work        |
| `E_REPLAY_UNKNOWN`         | 503    | The store could not record the nonce, so freshness is a maybe |
| `E_NO_VERIFIER`            | 501    | Declared `signed`, nothing bound                              |
| `E_NO_ED25519`             | 501    | This runtime's WebCrypto does not implement the algorithm     |

401 for unsigned and expired, 403 for the rest, because the two say different things to a caller: a
401 means authenticate and try again, and a 403 means a valid token would not have helped.

Over a channel the same refusals arrive as an `ACK` carrying the code and no status at all, which
is why the status table lives with the HTTP binding and not with the verifier.

### The payload digest, and what an unbound token is worth

`canonical()` sorts object keys at every depth before hashing, so a client that iterated its own
object in a different order sent the same call. Array order is data and is left alone.

A token with no `p` says "this reader may run this intent before this time". That is weaker than it
looks: the quantity can be edited. It is the caller's choice to make and it is stated rather than
defaulted — minting with the payload is what makes a token a receipt for one call.

### Replay is exactly as strong as the store's lease

A nonce is spent by taking a `StorePort` lease nobody releases, for the token's remaining lifetime.
No new port, no new record to expire: the lease _is_ the record, and it cannot outlive the token it
describes. A store that hands the same lease to somebody else is a store saying this token has
already been used, which is the answer rather than an error.

What that covers is what the **lease** covers, and `replayScope` reports it rather than leaving it to
be assumed. That used to read the store's `scope`, and the two are now separate fields — because they
are separate questions. `scope` decides whether a private entry may be written to a tier, and a tiered
store refuses on the strength of it. `leaseScope` decides how many processes agree that somebody
already took this. Conflating them meant a deployment that wanted per-deployment single-use had to
make its whole _cache_ shared to get it: a much larger decision, made for a reason that has nothing to
do with caching.

Split, a process-local cache can take shared leases. `sharedLeases(store, { dir })` in
`@weftjs/adapters` is that: an exclusive create in a directory every process can see, which is atomic on
a local filesystem, so exactly one caller gets the lease and the rest are told it is held. It replaces
one method and leaves `scope` alone, because it does not make the cache shared.

**What each arrangement actually gives, stated rather than implied.**

| Store                                  | `replayScope` | Single-use across |
| -------------------------------------- | ------------- | ----------------- |
| `memoryStore()`                        | `process`     | one isolate       |
| `sharedLeases(memoryStore(), { dir })` | `shared`      | one machine       |
| `redisLeases(memoryStore(), { url })`  | `shared`      | the deployment    |
| a Durable Object, an advisory lock, …  | `shared`      | the deployment    |

The middle rows are the ones that were missing. `sharedLeases` covers the deployment shape most Node
applications have — several processes behind a local proxy, or a cluster — and stops exactly where a
filesystem does: two machines do not share that directory.

`redisLeases(store, { url })` is the row past it, and it is `SET key token NX PX ttl` with nothing
around it. One round trip, atomic, expiring on its own, against something outside every process
taking part — which is the only thing that can answer "did anybody already take this" across a load
balancer. It speaks RESP over a socket with no dependency, so Redis, Valkey and KeyDB are the same
adapter; it is not a general-purpose client and does not want to be.

Two details of it are load-bearing rather than incidental.

**Release is a compare-and-delete, not a `DEL`.** A lease that expired and was taken by somebody else
is somebody else's, and a late release deleting it would hand the same nonce out twice — the failure
the lease exists to prevent, arriving from the cleanup path. The value is a token the caller
generated and the delete is conditional on it.

**A store that cannot be reached throws, and `verifyIntent` turns that into `E_REPLAY_UNKNOWN`.** Not
`ok` with a note in a log: an outage is exactly when replaying a token is worth attempting, so a
signed intent that proceeded on a maybe would be replayable for the length of one. Refusing during an
outage is the weaker product and the stronger property.

The steal path is worth being exact about, because a filesystem lease has one. An expired marker left
by a process that went away is taken over by whichever caller's `unlink` wins, and a caller that loses
that race is told the lease is held. For a nonce that is unreachable: the lease's lifetime _is_ the
token's, so a token whose lease has expired has already been refused on `x`. For a stampede lease it
means wait or serve stale, which is what a contended lease means anyway. Redis has no equivalent path:
`PX` expires the key and `NX` is the whole decision.

The assertion behind all of this is in a **second process**. Verifying twice against one store proves
a `Map` remembers, and a `Map` was never the thing in question — so the test mints a token, spends it,
and hands it to a genuinely separate process that has the public key and the connection string and
nothing else in common. For the networked lease that second process shares no filesystem either, which
is the whole difference between the last two rows.

What a test can honestly say about Redis is bounded, and the tests say it. The server they run against
is a stand-in that speaks RESP and implements `SET NX PX`, `GET`, `DEL` and the release script — it
proves the client, the ordering and the agreement living outside every process, and it does not prove
Redis. `WEFT_REDIS_URL` points the same tests at a real server, which is the only thing that can; it
is opt-in because a suite that needs a daemon running is a suite people stop running.

## A token cannot be rendered into a page

The obvious place for a token is the markup: put it in the form, and a mutation with no JavaScript
keeps working.

It cannot go there, and the reason is the mechanism this framework is built on. A cache key is
derived from what the compiler saw a fragment read. A minted token is not a read — it is a value
the render invented — so a region carrying one would be stored under a key that does not describe
it and handed to the next reader, whose click would then fail as somebody else's token. The same
property that makes keys trustworthy makes a token in a render unsafe.

So minting is its own request: `POST /_weft/token` with `{ intent, payload? }`, `no-store`, and the
capability check runs there too — a caller who may not run the intent cannot get a token for it, so
the 403 arrives before the interaction rather than after it.

Two consequences, stated rather than discovered:

- **A signed intent needs JavaScript.** A form can still post to it and is refused with
  `E_INTENT_UNSIGNED`. Every other intent keeps the no-JavaScript path exactly as it was; this is
  the price of the strongest gate, paid only by the intents that ask for it. The demo has both
  buttons side by side, which is the honest way to show a cost.

  Refused, and legible. A browser that posted a form is answered with a page — the code, the reason,
  what the decision is, and a link back — rather than with the JSON the dispatch returns. The
  framework's own `fetch` sends `x-weft-fetch` and keeps the JSON, because it turns the same refusal
  into a toast without leaving the page. "The request was refused correctly" is not the same thing
  as a working no-JavaScript path; failing legibly is part of working.

- **A signed intent costs one round trip.** The token is fetched at the moment of the interaction,
  for that payload. That round trip is what makes the call a receipt.

## What an application writes

```ts
// weft.config.ts
authority: {
  grants: { anonymous: ['cart:checkout'], staff: ['cart:*', 'order:refund'] },
  roles: (subject) => rolesOf(subject),          // without one: `user` for a session, `anonymous` otherwise
  ambient: ['catalogue:read'],                   // held by everyone, and still declared
  signing: { kid: 'k2', privateKey, publicKeys: { k1, k2 } },
  audit: (decision) => log(decision),            // allows and denials both
}
```

```ts
export const checkout = defineIntent({
  name: 'cart.checkout',
  writes: ['cart'],
  capabilities: ['cart:checkout'],
  signed: true,
  run: async (ctx, input) => { … },
})
```

Nothing else changes. The model is wired into **both** intent bindings from one place, because a
capability enforced over the channel and not over the POST path would be a capability with a
documented way around it.

**Every decision is audited, allows included.** A log of denials only is a log in which a
successful privilege escalation is silence.

## What this costs

| Entry                | Covers                                                   | Measured | Ceiling |
| -------------------- | -------------------------------------------------------- | -------- | ------- |
| `entry-intent.ts`    | Intent dispatch, with the three authority branches in it | 9,802 B  | 10,240  |
| `entry-authority.ts` | The above, plus the capability model and signed intents  | 11,722 B | 12,288  |
| `entry-render.ts`    | The transport, plus the catalogue: render intents        | 14,576 B | 14,592  |

242 bytes of the growth is in the intent path: the branch that refuses an unverifiable signature and
the two places a token is read off a request. The model and the token machinery — 1,670 bytes — are
in an entry of their own, and a deployment whose intents declare no authority never imports it.

Rate limiting added 186 bytes to the intent path and took the _line_ ceiling on that entry past 2,100.
The ceiling moved rather than the code, and the reason is recorded with it: the limit is a gate on
every intent, so its branch lives where the dispatch is, and the port it calls through is declared
beside the other thirteen. Both alternatives are worse — a second dispatch site in the authority entry,
or a port declared somewhere ports are not.

Render intents are their own entry on the rule route staging established, and they share every gate
with the intent path rather than measuring a second authority tier. What they cost the _channel_ is
five bytes: `SlotRequest` gained the frame that asked, which is the field `WarmRequest` already carried
for the same reason. The transport entry has four bytes left.

## Render intents

Every intent above is a _mutation_. A render intent is the other thing a client can address by opaque
id: **put this catalogue entry in this slot**.

The authority half needed nothing new. `createRenderDispatch` calls the same `CapabilityCheck`, the
same `IntentVerifier` and the same `LimitPort`, in the same order and for the same reasons, because two
gates that were supposed to be one gate are how the weaker of them is discovered. What it adds is the
**catalogue**, and the catalogue is why this waited for phase 9: an id has to resolve to a _place_, and
the thing that turns a name into a place is the registry port. Built before the registry existed it
would have had one possible answer, and a catalogue with one answer is a function call with ceremony.

**The catalogue is a directory, and that is the security boundary.** `app/renderables/**.ts` is what a
_browser_ may name; `app/fragments/` is what a page composes. Making those one set would turn every
component in an application into a public endpoint taking arbitrary props. The id is
`intentId(module, export)` — the same six hex characters the compiler writes into a template's wiring —
so nothing states an id twice, moving the file changes the wire, and the name on the wire discloses no
server code.

```ts
export const productCard = defineRenderable<{ sku: string }>({
  name: 'card.product',
  fragment: 'product-card', // or: region: 'search', and the registry decides
  input: (raw) => ({ sku: mustBeAProduct(raw) }), // params from a browser reach a *template*
  limit: { max: 60, windowMs: 10_000 },
  load: (ctx, { sku }) => valuesFor(sku),
})
```

```ts
weft.render('card.product', 'body', { sku: 'OIL-2L' })
```

**It is a `REFRESH` with a source named, not a frame of its own.** A refresh asks _give me this slot's
current state_; a render intent asks _put this entry in it_. Same answer, same forms, same epoch
semantics, and the same surgical ladder — an entry whose template the client already holds comes back
as the changed values and nothing else, which is the entire reason to do this over a channel rather
than as a fetch returning markup. A new frame kind would have cost every entry carrying the frame
table a few bytes to say what a header says.

| Refusal                | When                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `E_NO_CATALOGUE`       | No registry able to resolve a renderable is bound                          |
| `E_NO_SUCH_RENDERABLE` | Nothing in the catalogue answers that id, and the refusal lists nothing    |
| `E_RENDER_INPUT`       | The params did not validate. They came from a browser and reach a template |
| `E_NO_SUCH_SLOT`       | The slot is not a hole on the page this connection is showing              |
| `E_RENDER_FAILED`      | The entry threw. One hole degrades; the connection does not                |

Two checks are the _caller's_ rather than the dispatch's, and both for the same reason: they are route
knowledge and a channel has none. Whether the slot is a hole on this page, and whether the id is an
entry's declared name rather than its id — markup a person wrote has to be able to name one, and what
travels is still the id.

**A render cannot write, and that is a type.** The gates run against an `EnvelopeContext`, because a
capability check resolves a subject and a verifier reads a token; the entry's own loader gets a
`RenderContext`, which has no envelope on it at all. Handing one context to both would have made a
render intent a mutation wearing a different hat.

## Rate limiting

The design puts it in this tier, and it is the one piece of the tier a kernel cannot implement —
because the whole question is _what a call is counted against_. An address is wrong behind a proxy. A
session is wrong for an unauthenticated API. A subject is wrong for every call made before anybody
signs in. Which is right is a property of the deployment, so it is a port.

An intent declares how much traffic it can take; the port decides whose traffic this is. Neither half
is derivable from the other, which is why splitting them is the whole design rather than a detail.

```ts
export const addToCart = defineIntent({
  name: 'cart.add',
  writes: ['cart'],
  limit: { max: 20, windowMs: 10_000 },
})
```

```ts
// weft.config.ts — the decision the framework will not make for you
limits: {
  counted: bySession('sid')
} // or byAddress(), or bySubject(), or a whole LimitPort
```

`byAddress`, `bySession` and `bySubject` are the three answers the design names, written out, because a
port whose only documentation is its type is a port everybody implements slightly wrong once. Returning
`null` means _not counted_ — a queue worker, a migration — and it is a decision rather than a hole: the
honest place for an exemption is the function that decides who is being counted.

The port is handed exactly those three things and not the request. A limiter given `RequestFacts` could
count against a path, a query string, a body — and a limit counted against something nobody can
enumerate is a limit nobody can reason about.

**The limit is checked before the signature and before the grant.** Capacity is the cheapest of the
three and it protects the other two: a caller hammering a signed intent with forged tokens should be
turned away before this process does an Ed25519 verification on their behalf.

| Refusal           | Status | When                                                                    |
| ----------------- | ------ | ----------------------------------------------------------------------- |
| `E_NO_RATE_LIMIT` | 501    | An intent declares a limit and no port is bound. Refused, not unlimited |
| `E_RATE_LIMITED`  | 429    | Over the ceiling. Carries `Retry-After`, and never says what it counted |

The refusal does not say what the call was counted against. That value identifies the caller, and
telling somebody which bucket they are in is telling them how to leave it.

`countingLimits` is a **fixed** window, named as one: the window is part of the key, so a bucket expires
by being a different key and nothing has to sweep. What it costs is the boundary burst a fixed window
always costs. A sliding window needs a read-modify-write against a store that can count atomically, and
`StorePort` deliberately cannot — it has a lease, not a counter — so this is the honest limiter for the
port that exists, and a deployment that needs a sliding one binds it.

## Delegation, and the four ways a child may only be narrower

Something that is not the reader sometimes has to act on the reader's behalf, once, for less than
the reader could. A region on another deployment is the case this framework has: a composite holds
an authorisation and the region needs a strictly smaller one to do its part.

It happens at the **signing** tier, and that is the decision everything else follows from.
Macaroon-style attenuation — caveats appended and authenticated with a chained MAC — would need the
verifier to hold the root secret, and the entire reason this tier is separable is that the verifier
holds public keys only. So a delegate is a new signature over smaller claims:

```
signer.delegate({ token, subject, intent, payload?, ttlMs? }, verifier)
```

`verifier` is not a convenience. The parent has to be checked before it is trusted, and **checking
it is what spends it** — verification takes the nonce's lease and never returns it, so a token can
be narrowed once and is dead afterwards. That is the property that keeps delegation from being a
fan-out: one authorisation in, one out.

| Claim   | The rule                                                              | Refusal                 |
| ------- | --------------------------------------------------------------------- | ----------------------- |
| intent  | The parent's own, and nothing else                                    | `E_TOKEN_WRONG_INTENT`  |
| subject | The parent's, if it named one; a parent for nobody may gain one       | `E_TOKEN_WRONG_SUBJECT` |
| payload | The parent's, if it bound one. Unbound may become bound               | `E_TOKEN_WRONG_PAYLOAD` |
| expiry  | Clamped to what is left of the parent's; asking for longer is refused | `E_DELEGATE_LONGER`     |
| depth   | `d` increments, and the signer's ceiling is one by default            | `E_DELEGATE_DEPTH`      |

The payload has no rule of its own on purpose. The child's payload is what the parent's own check is
given, so a bound parent already refuses a child that binds something else — including a child that
binds nothing, which is the widening case. A guard that cannot fire is a guard nobody can trust, so
it is not there.

**The checking side accepts no delegation by default.** `maxDepth` on the verifier is zero unless a
deployment sets it, so a delegated token arriving at a deployment that never asked for delegation is
`E_DELEGATE_DEPTH` — the same refusal this document used to record as a design decision, now with a
name and a code path. A chain is the part of this that gets away from people: every link is another
place an authorisation could have been narrowed wrongly, and one link is a shape a person can hold
in their head.

`pn` carries the parent's nonce, so an audit reads the chain backwards without the tokens having to
be stored anywhere.

## What this does not do

- **No capability-gated renders or plugins.** The seam is on intents and on catalogue entries, which
  is where writes and client-addressable renders are. The design's plugin capabilities would be a
  third gate with a third set of failure modes.
- **No delegation over HTTP.** `delegate` is a signer method, and the tier that holds a signing key
  is the tier that may call it. Exposing it as an endpoint is a deployment's decision for the same
  reason minting is: a path that narrows tokens is a path that spends them, and what may reach it is
  not something a framework can know.
