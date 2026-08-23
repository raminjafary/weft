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

What that covers is what the store's scope covers, and the front door says so rather than leaving
it to be assumed: a `process`-scoped store gives `W_REPLAY_PROCESS_LOCAL`, meaning single-use per
process. On one machine that is the deployment; behind a load balancer it is not, and the fix is a
shared store rather than a paragraph.

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

| Entry                | Covers                                                  | Measured | Ceiling |
| -------------------- | ------------------------------------------------------- | -------- | ------- |
| `entry-intent.ts`    | Intent dispatch, with the two authority branches in it  | 9,457 B  | 10,240  |
| `entry-authority.ts` | The above, plus the capability model and signed intents | 11,127 B | 12,288  |

242 bytes of the growth is in the intent path: the branch that refuses an unverifiable signature and
the two places a token is read off a request. The model and the token machinery — 1,670 bytes — are
in an entry of their own, and a deployment whose intents declare no authority never imports it.

## What this does not do

- **No capability-gated renders or plugins.** The seam is on intents, which is where writes are.
  The design's plugin capabilities are phase 9 work and would be a second gate with a second set of
  failure modes.
- **No render intents.** The client addresses an intent by opaque id, with schema-validated params
  and a capability check — but every intent is a _mutation_. A catalogue of renderable fragments
  addressable the same way is the module-catalogue half of the design, and it belongs with `remote`
  in phase 9: it needs a registry resolving a region name to a deployment, which is one of the ports
  still declared and unimplemented.
- **No delegation, and no token that mints tokens.** A token authorises one call.
- **No rate limiting.** The design puts it in the authority tier and it is a port-shaped concern:
  what a limit is counted against — an IP, a session, a subject — is a deployment's decision, and
  the kernel would be guessing.
