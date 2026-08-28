# The Warp channel, and the four bindings

Every flow phases 5 and 6 promise was produced, parsed and tested before this existed, and
none of it had ever left a test process. `surgicalRefresh` was called directly, `STALE` was
asserted as a returned `Map`, and `COMMIT` was a frame in an array. A frame that is never
carried is a data structure, not a protocol.

## The shape

One state machine, four sinks. [`channel.ts`](../../packages/kernel/src/channel.ts) knows
nothing about how bytes move; [`node-channel.ts`](../../packages/adapters/src/node-channel.ts)
is where they do.

| Binding  | Down                        | Up              | Framing | Cost of choosing it                                  |
| -------- | --------------------------- | --------------- | ------- | ---------------------------------------------------- |
| `stream` | one long-lived GET response | discrete POSTs  | binary  | 8 preamble bytes per POST; a dead downstream refuses |
| `sse`    | `text/event-stream`         | discrete POSTs  | text    | base64 on every non-text body                        |
| `socket` | WebSocket                   | the same socket | binary  | an upgrade, and no HTTP caching of the channel       |
| `turn`   | the POST's own response     | the same POST   | binary  | `RESIDENT` and `HELD` re-declared per turn; no push  |

The costs are stated because they decide which one a deployment wants, and three of them are
not obvious from the outside:

- **SSE cannot carry binary.** It uses the text framing, so a rendered fragment travels
  base64. That is why it is not the default; it is here because a client behind a proxy that
  breaks other things often still has SSE.
- **The three held bindings answer on the other connection.** An upstream POST arriving after
  its downstream has dropped is `E_NO_DOWNSTREAM` — the frames were understood and there was
  nowhere to put the answer. A silent 200 would be the wrong answer to a real question.
- **A turn has no other connection**, so it cannot have that failure and cannot be spoken to.
  It answers 200 rather than 202 for exactly that reason: 202 says the answer went down the
  other connection, and here this response _is_ the answer.

## `turn`, and why a channel that holds nothing is still a channel

The other three hold a downstream open. A host that terminates no upgrade and outlives no
request can run none of them, and the failure is worse than an absence: the upgrade is refused,
the streamed GET appears to work, and the POSTs that follow reach whichever instance the
platform routed them to. A channel that is merely unavailable ends up looking broken.

A turn carries frames up in a request body and the answer back in that request's own response.
Nothing had to be invented for it. `hub.receive` already returned the frames it produced and
the POST path was discarding them; and the protocol was already client-authoritative, so the
server needs no memory between calls — `RESIDENT` says what the client holds, `HELD` with
`only` says what it is showing, both ahead of whatever they answer, because frames are handled
in the order they arrive. The channel is opened for one request, used, and dropped.

What it gives up is the ability to be spoken to first. There is nowhere to put an unasked
`STALE`, so an invalidation is carried on the next turn — and that is named on the handshake
rather than left to be discovered, because a region that never updates looks identical to a
framework that does not work.

Which binding a client takes is not guessed. `channel: { hold: false }` says a deployment
cannot hold a downstream and the client takes turns from its first request; a deployment that
did not say is not stranded, because the first `409` switches bindings and takes the refused
frames as a turn rather than losing them.

## A port a browser will not connect to

The channel is built out of `fetch`, `WebSocket` and a streamed response, and the WHATWG fetch
standard blocks about forty ports outright — the request is a network error before it is sent, on
all three. A deployment on one of them serves its documents perfectly and its channel never
connects, and **nothing says so**: a blocked request produces no error the page can report, so the
symptom is a live region that never updates and a navigation that is always a document, which is
indistinguishable from the framework not working.

This was not theoretical. This repository's own documentation site was configured on 4190 — sieve —
so its channel could never have worked in a browser, and the number had been sitting in
`weft.config.ts` looking like any other port. `E_BLOCKED_PORT` refuses at config resolution and
names why, because the alternative is that the next person picks one of the other forty.

## The two gaps a held connection was hiding

`hub.notify` walks the connections _this_ process is holding. That is the whole of push
invalidation on one instance, half of it on two, and none of it for a client that holds no
connection at all — and both gaps are filled from outside the hub, which takes a single
`onInvalidated` hook and knows about neither.

- **`FanoutPort`** carries an invalidation to the instances holding a connection now. Needed by
  any deployment above one instance, whatever binding it serves; a memory implementation ships,
  and Redis, Valkey or NATS replace it without the hub noticing. A publisher must not hear
  itself, which is what `origin` is for.
- **`StaleJournal`** writes down what a client with no connection will ask for later. A record
  rather than a queue: reading does not consume, so two tabs are both told, and `since` on the
  turn is what stops one write becoming one refresh per turn. One store entry per key rather
  than a list, because a list is read-modify-write and `StorePort` has no compare-and-swap.

A process-scoped store makes both of these a lie on more than one instance, so the plan
validator refuses it at build time: `E_TAGS_PROCESS_SCOPED`.

## What a channel holds

Per connection: the negotiated capability set, the base render the client holds for each slot,
staged epochs, and the cache keys this connection is watching. No render state — that is the
whole point of stateless surgical updates, and it is what makes ten thousand clients
watching one price list produce one delta computation rather than ten thousand.

## The upstream frames

| Frame      | Effect                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `RESIDENT` | Negotiate. Answered with `WARP`. Nothing else is served before it, because a form cannot be chosen without it — `E_NO_NEGOTIATION` |
| `HELD`     | Record the base render the client holds, per slot                                                                                  |
| `REFRESH`  | Recover, recompute, diff, memoize, emit. `epoch=` stages instead of sending; `commit` flips                                        |
| `WARM`     | Send `TPL` for a named template. `E_NO_TEMPLATE_REGISTRY` when the hub was given none                                              |
| `RESUME`   | Continue rather than restart: rebinding under the same channel id keeps the held map                                               |
| `INTENT`   | Dispatched through the hub's intent dispatch, answered with `ACK`. A hub given none answers `E_NO_INTENTS`                         |

## Declaring what you hold is what makes you a candidate

`HELD` records a slot without rendering it, and that has to be enough to make a connection a
target for `STALE`: waiting for the first refresh to register a page as holding a region meant the
first write after a page load never reached it. Two tabs on a page, press the button in one, and
the other tab — freshly loaded, never refreshed — sat there. So the connection's own front door is
asked which key each held slot would resolve to, once per declared slot, and it is recorded as
holding that key immediately.

An intent's own connection is excluded from the `STALE` its write produces — being told about an
old value you are about to be handed the new one for is the wrong shape of answer — but that
exclusion only ever covered the slots the intent's author also listed in `refresh`. What holds the
tags the write actually dropped is the same registry `HELD` populates, so a connection is refreshed
for the union of what the intent named and what it is holding that the write invalidated.

## Epochs, over the wire

`REFRESH s=prices epoch=e1` renders, diffs, and sends **nothing**. The client sees no frame
and paints nothing. `REFRESH epoch=e1 commit` sends every frame staged under `e1` followed by
one `COMMIT`, and the client flips them together.

Both on one frame is an optimistic update: staged and committed in the same breath, so a
rollback is discarding an epoch rather than reconstructing prior state.

## What the client refuses

A delta is a pure function of two specific states. Applied against a third it would write
plausible values into the wrong render, so
[`channel.ts`](../../packages/client/src/channel.ts) refuses a delta whose base is not the
one the region is holding, and reports which two bases disagreed. The region's base advances
only when the write is painted — a staged delta has not moved anything yet.

## Resumption

`hub.open(sink, id)` with an id that already exists **rebinds** rather than replacing. That
is what resumption is: a webview that was frozen and evicted reconnects and the server still
knows which base render it holds, so the next refresh is a delta and not a first render.
Nothing is replayed — the client named what it holds, and that is cheaper than a log.

## The socket the front door opens

The runtime is transport-free on purpose and the front door is not. A page with a live region now
gets one WebSocket instead of a POST per uplink frame and a chunked response that no proxy is obliged
to keep open, and the choice is made where a choice belongs: in the layer that knows it is a browser.

`connect()` resolves on the first thing to happen — open, error, or close — because `WebSocket`
reports failure as a late event and an upgrade a middlebox is going to eat looks exactly like one
that has not finished. A null answer is a page that uses the two fetches, and that fallback is not
for old browsers: it is for the deployments where an upgrade does not survive the path, which is
something only trying can establish. There is no retry, because a path that ate the first upgrade
will eat the second, and paying for that discovery once per page is enough.

Verified in a real browser rather than asserted from Node: `node packages/bench/src/cli.ts channel`
asks the **server** which binding it got, in Chromium, Firefox and WebKit, then breaks the upgrade
with `routeWebSocket` and asks again. All three open a socket; all three fall back to `stream` when
the upgrade is refused, with no error on the page.

## The downgrades, in traffic

Version negotiation ran, and it only ever ran against a client that agreed with the server. Every
downgrade was asserted by calling `negotiate` with a hand-written hello, which proves the function
and nothing about the wire — a server that negotiated `html` and then sent a delta anyway would have
passed every test in this repository.

Four sessions now announce something older over a real socket to a real hub, and each asserts both
halves: what the `WARP` frame settled, and that the frames after it obey it.

| Announced                    | Settled                         | And then                                     |
| ---------------------------- | ------------------------------- | -------------------------------------------- |
| `forms=html`                 | `forms=html`                    | a second refresh with a base is still markup |
| `warp 1.2.0`                 | the minimum of the two          | the stream carries on                        |
| `ir 1.9.0` (a major behind)  | `forms=html`, not fatal         | the page still arrives                       |
| `warp 2.0.0` (a major ahead) | `ok=false` with the fatal named | nothing follows                              |

The last row found a real gap. `Negotiation.fatal` and `ok` existed and **were not on the frame**, so
a client whose major this server cannot speak received a `WARP` that looked like an ordinary degraded
one — and then had its refresh answered normally, which is the worst of both: told the stream is
unusable, then handed frames that depend on it. `ok` and `fatal` are headers now (warp 1.8.0,
additive), and a fatal negotiation refuses everything after it by the name it gave.

## What this does not do yet

- **No `permessage-deflate`.** Warp frames are length-prefixed and bodies are already
  compressed by the layer that produced them; negotiating a second compression would be
  paying twice for one property.
- **Backpressure is a close, not a queue.** A sink reports `saturated` when the transport's
  buffer is over its watermark, and a channel that stays saturated for 32 consecutive sends is
  closed with `E_SLOW_CONSUMER`. Frames held for a peer that is not reading are memory the
  process cannot reclaim, and every one of them is stale by the time it would arrive — so closing
  is the honest answer, and the client reconnects and says what it holds.
- **The runtime still opens no socket, and that is the design.** `createChannelClient` takes frames
  rather than a URL, so one code path serves a socket, an SSE stream with POSTs up, and a test. What
  changed is that the **front door** opens one: see below.
