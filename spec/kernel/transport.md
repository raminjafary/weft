# The Warp channel, and the three bindings

Every flow phases 5 and 6 promise was produced, parsed and tested before this existed, and
none of it had ever left a test process. `surgicalRefresh` was called directly, `STALE` was
asserted as a returned `Map`, and `COMMIT` was a frame in an array. A frame that is never
carried is a data structure, not a protocol.

## The shape

One state machine, three sinks. [`channel.ts`](../../packages/kernel/src/channel.ts) knows
nothing about how bytes move; [`node-channel.ts`](../../packages/adapters/src/node-channel.ts)
is where they do.

| Binding  | Down                        | Up              | Framing | Cost of choosing it                                  |
| -------- | --------------------------- | --------------- | ------- | ---------------------------------------------------- |
| `stream` | one long-lived GET response | discrete POSTs  | binary  | 8 preamble bytes per POST; a dead downstream refuses |
| `sse`    | `text/event-stream`         | discrete POSTs  | text    | base64 on every non-text body                        |
| `socket` | WebSocket                   | the same socket | binary  | an upgrade, and no HTTP caching of the channel       |

The costs are stated because they decide which one a deployment wants, and two of them are
not obvious from the outside:

- **SSE cannot carry binary.** It uses the text framing, so a rendered fragment travels
  base64. That is why it is not the default; it is here because a client behind a proxy that
  breaks other things often still has SSE.
- **The half-duplex bindings answer on the other connection.** An upstream POST arriving after
  its downstream has dropped is `E_NO_DOWNSTREAM` — the frames were understood and there was
  nowhere to put the answer. A silent 200 would be the wrong answer to a real question.

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

## What this does not do yet

- **No intents.** `INTENT` and `ACK` are refused by name.
- **No `permessage-deflate`.** Warp frames are length-prefixed and bodies are already
  compressed by the layer that produced them; negotiating a second compression would be
  paying twice for one property.
- **Backpressure is a close, not a queue.** A sink reports `saturated` when the transport's
  buffer is over its watermark, and a channel that stays saturated for 32 consecutive sends is
  closed with `E_SLOW_CONSUMER`. Frames held for a peer that is not reading are memory the
  process cannot reclaim, and every one of them is stale by the time it would arrive — so closing
  is the honest answer, and the client reconnects and says what it holds.
- **No browser-side socket.** The client half routes decoded frames and produces frames to
  send — including an `INTENT` with an optimistic epoch staged behind it — but opening the
  connection and feeding it is the application's. That is why `createChannelClient` takes frames
  rather than a URL: the same code path then serves a socket, an SSE stream with POSTs up, and a
  test. Navigation is the remaining phase 3 gap, and it is blocked on phase 7 discovery rather
  than on transport.
