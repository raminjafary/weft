# Warp, version 1

`weft.warp/1` — one logical channel per tab, five jobs: initial render, navigation,
mutation, refresh, and invalidation. Reference implementation in `packages/warp`.

## Versioning on the wire

Binary streams open with an 8-byte preamble: `WRP1`, then the sender's major and minor.
A different major is refused at the preamble (`E_WARP_MAJOR`) rather than discovered
three frames in. The server's first frame is `WARP`, which states the versions and the
strategy it settled on:

```
WARP spec=weft.warp/1 v=1.0.0 ir=2.0.0 forms=html,delta strategy=stream fill=dsd
     commit=view-transition residency=indexeddb resume=true downgrade=…
```

## Framing

**Binary, in production.** Per frame: `u8 kind`, `u8 flags`, `u16 headerLen` (LE),
`u32 bodyLen` (LE), header bytes, body bytes. Flags: bit 0 body present, bit 1 body is
UTF-8 text.

Two properties follow from the length prefix, and both are tested:

- An **unknown frame kind is skippable**. A version-1 client meeting a frame added in
  1.3 steps over it by length and keeps reading. This is what makes minor versions
  additive on a live connection.
- A body is **opaque bytes**, so an `HTML` frame carries pre-encoded template segments
  with no re-encoding and no JSON escaping.

**Text, for tooling.** One frame per line, `KIND key=value …`. Header values that
contain a space, `=`, `%`, or a newline are percent-encoded, and bodies are encoded into
the line, so the one-frame-per-line invariant holds. Text framing is therefore _not_
byte-transparent for bodies, which is why production is binary.

Headers are strings on the wire. Typed accessors (`num`, `bool`, `list`) are the
reader's business; the codec does not guess.

## Direction is structural

Codes below `0x10` travel client to server, codes from `0x10` up travel server to
client. A decoder rejects a frame arriving from the wrong side (`E_WRONG_DIRECTION`)
without knowing what the frame means.

| Client to server |                                                | Server to client        |                                     |
| ---------------- | ---------------------------------------------- | ----------------------- | ----------------------------------- |
| `RESIDENT` 0x01  | held templates, capabilities, network class    | `WARP` 0x10             | versions and negotiated strategy    |
| `HELD` 0x02      | base renders the client can be deltaed against | `SHELL` 0x11            | route, plan, flags, device class    |
| `REFRESH` 0x03   | refresh a slot, form negotiable                | `SLOT` 0x12             | open or close a hole                |
| `WARM` 0x04      | stage templates, a route, or a plan subtree    | `HTML` 0x13             | rendered markup for a slot          |
| `INTENT` 0x05    | an intent id and its params                    | `TPL` 0x14              | wiring table plus byte segments     |
| `ACK` 0x06       | applied through epoch                          | `DATA` 0x15             | values for a resident template      |
| `RESUME` 0x07    | continue from a committed epoch                | `DELTA` 0x16            | changed values against a named base |
|                  |                                                | `PATCH` 0x17            | DOM operations                      |
|                  |                                                | `SIGNAL` 0x18           | a signal value                      |
|                  |                                                | `COMMIT` 0x19           | atomic flip of an epoch             |
|                  |                                                | `MOD` 0x1a / `CSS` 0x1b | chunk and stylesheet requirements   |
|                  |                                                | `STALE` 0x1c            | push invalidation, client decides   |
|                  |                                                | `NAV` 0x1d              | the answer to a staged route        |
|                  |                                                | `PLAN` 0x1e             | lazy plan extension                 |
|                  |                                                | `ERROR` 0x1f            | a named failure                     |
|                  |                                                | `REDIRECT` 0x20         | in-band redirect, after the seal    |
|                  |                                                | `COOKIE` 0x21           | non-HttpOnly cookie, after the seal |
|                  |                                                | `REGION` 0x23           | a composed region announcing itself |

`REDIRECT` and `COOKIE` arrived in 1.1.0 and are layer three of the envelope design: what a
sealed response can still carry in its body. Neither is a substitute for the real thing. A
crawler will not follow a `REDIRECT` frame, and `HttpOnly` is exactly the property a body
cannot grant — see [the lifecycle](../kernel/lifecycle.md) for what is irreducibly lost once
the envelope is sealed.

The frame sketch in the design notes uses positional shorthand (`SLOT s12 open prio=1`).
The canonical encoding is all `key=value`; the shorthand is for prose.

### `REGION`, and why a region cannot open with `WARP`

Added in 1.6.0, and it exists because of who is speaking rather than what is being said. A shell that
composes regions from other deployments receives frames that are somebody else's, and a length prefix
does not say whose. `WARP` cannot answer that: it is the composite's negotiation with its client, and
a region sending one would be settling a version for frames it does not send.

So a region says who it is instead — `REGION region=search contract=search version=2.1.0 rev=search-42
hops=0` — and the name is the region's own rather than the one it was asked for, which is what makes
the composite's check falsifiable. Everything after it must name that region or a slot inside it, and
the kinds a region may send are a stated list with a stated reason for each refusal. Both are in
[the composition spec](../kernel/composition.md).

The version rule pays here in a place it was not designed for: a region on a later minor sending a
frame this shell has no name for is stepped over by length, so a tier boundary tolerates skew in the
same way a connection does.

**The body form, added in 1.7.0.** A `REGION` frame answering a _probe_ carries the region's subtree
in its body: what it composed, where each one ran, what each cost, and the same again underneath. It
is JSON because a list of records is not a header set, which is the reason `PLAN`'s body is JSON too.
Nothing on the request path has one — a page needs the hop count and the count is a header — so this
is bytes that exist only when something asked what the topology is. Where a body and a `hops` header
are both present they are two claims about one topology and are refused if they disagree.

## Transport bindings

Warp is a logical channel with three bindings and one frame vocabulary:

1. **Streamed response down, discrete POSTs up.** Default. The initial document _is_
   the first frames. Streaming a _request_ body is Chromium-only, HTTP/2-only, and never
   truly duplex, so it is not the foundation.
2. **WebSocket.** The only Baseline true-duplex transport. Baseline in every webview.
3. **WebTransport.** Later, where it exists.

Read the downlink with `getReader()`. `for await…of` over a stream is the part Safari
lacks, not stream reading itself.

No HTTP version is load-bearing. Response streaming is universal. H2/H3 buy 103 Early
Hints and make the `split` form worthwhile; H3 connection migration suits a long-lived
per-tab channel. Nothing degrades to broken without them.

## Negotiation, including webviews

`RESIDENT` carries capabilities alongside network class, so a missing capability costs a
form, a fill mechanism, or an animation — never correctness. `negotiate()` returns:

| Field       | Meaning                                                      | Degraded value                                                |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `forms`     | wire forms this client can be sent, from the IR's vocabulary | `['html']` on an IR major mismatch                            |
| `strategy`  | `stream`, `collapse`, or `socket`                            | `collapse` when the document response is buffered             |
| `fill`      | who fills an out-of-order hole                               | `script` — the ~1 KB filler — without incremental DSD parsing |
| `commit`    | how an epoch commits                                         | `instant` without same-document View Transitions              |
| `residency` | where resident templates live                                | `indexeddb`, then `http-cache`                                |
| `resumable` | may a severed channel continue                               | `false` when the transport buffers                            |

Three webview cases are specified rather than discovered:

**Intercepted requests.** An app serving the document through `WKURLSchemeHandler` or
Android's `shouldInterceptRequest` supplies the bytes itself, and those paths buffer —
Android's `WebResourceResponse` wraps a blocking `InputStream`. "The initial response is
the first frames" stops being true and there is no HTTP layer underneath at all. The
client declares `transport=buffered`, holes collapse into the document, the `split` form
is withdrawn, and anything after the document needs the socket binding. The harness
runs this as a first-class mode (`--transport buffered`), not as a footnote.

**Suspension.** iOS freezes and evicts backgrounded webviews, so a long-lived channel is
severed far more often than a desktop tab's. `RESUME` carries the last committed epoch
and the resident digest, and the server continues instead of restarting. Degradation to
plain request/response is a tested mode, not a fallback nobody runs.

**No service worker.** WKWebView gates service workers behind app-bound domains, so they
are effectively unavailable in a generic iOS webview, and in-app browsers often suppress
caching entirely. `residency` therefore falls back to IndexedDB and then to the HTTP
cache, and the repeat-visit claim must be stated per storage tier.

## Exercised, as of the client runtime

Until the runtime existed this specification had tests and no users, which is a protocol
with unknown bugs. It now has one end-to-end path: a document that carries `WARP`, `SHELL`
and `TPL` as binary frames in the response, decoded in the browser by the same codec that
encoded them on the server, with the resident set deciding which `TPL` frames are sent at
all. Measured in
[the adoption spec](../client/adoption.md); 1,124 protocol bytes on a first visit against
132 on a repeat.

### `WARM`, at three grains

`WARM` asks the same question — stage this, paint nothing — about three different things, and the
grain is named by the header it carries. `tpl=` names template versions the client does not hold.
`at=` names a route it may be about to go to, answered by `NAV`, whose `form` header is the whole
decision. `plan=` names a subtree of the plan it knows nothing about, answered by `PLAN`.

Only the first is something a channel can answer on its own; the other two are hooks, and they are a
table keyed by grain rather than one option per grain. That is a byte decision that became a design
one: route staging arrived as a branch in the channel and took its entry 108 bytes past a watermark,
and lazy plan extension arrived as a second branch and took it to five bytes of headroom. A rule
saying a new capability does not spend an existing entry's room, satisfied by five bytes, is a rule
about to stop being satisfied — so the channel stopped growing a case per capability. One lookup
answers every grain, each handler is measured under the entry that provides it, and a grain nothing
answers is `E_NO_WARM_HANDLER` rather than a silence.

### `PLAN`, including the one nobody asked for

`PLAN` carries a JSON list of routes: the pattern, the shell version, whether that shell is this
connection's, the region names, the stylesheet, the template versions the regions need, and the
routes readers go to next. Every field is something a client would otherwise fetch a document to
learn.

It is the one frame here that also arrives **unasked** — once, when a channel opens. Everything else
answers a question the client posed; this one exists because the client cannot pose it. A page has no
route table to notice a gap in, and the thing most worth telling it is a measurement only the server
has. A truncated answer says `complete=false`, because a silent cap reads as "that is the whole
subtree".

| `form`     | Meaning                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------ |
| `slots`    | The target shares this client's shell. Its regions follow as frames, staged into the epoch |
| `document` | It does not. A different shell has different holes, so fetch the document instead          |

**Why the server decides.** Only the server knows both shells — the one this connection is on and
the one the target renders into — and a page assembled out of two layouts is worse than a document
request. The client sends no shell version and needs none.

**What the regions come back as** is the surgical ladder, unchanged: a `DELTA` where the client
holds the template _and_ the base for that slot name, markup where it does not. Two pages on one
route share a template, so switching between them travels as the values that differ — for a page
the reader has not been to yet, which is what a staged route is.

**The held map is not touched.** What the client is showing has not changed. Writing the target's
bases into it would make the next refresh of the page they are still looking at a delta against a
render they have never seen.

### `HELD`, and saying that this is all of it

A `HELD` frame's headers are slot names, so anything the frame has to say about _itself_ needs a
key no slot can have: `$` is reserved, and `$only` is the one that exists. Without it a `HELD`
frame adds to what the server believes, which is right for a client telling it about one more
region and wrong for a client that has **navigated** — slot names belong to a page, so the page
that was left would go on being refreshed by a `REFRESH` that names no slots and told it was
stale by invalidations about a page nobody is on. `$only` says this is the whole of what is held:
the server clears the map, drops that connection's entries in the stale registry, and reads the
new set. Added in Warp 1.3.0; an older server ignores it and merges, which is the behaviour it
had before.

What that path touches now: the socket binding, `RESUME`, `STALE`, and negotiation against a client
that does _not_ agree with the server. Epochs, `COMMIT`, `NAV` and the uplink frames are exercised
end to end — a route staged over a channel and committed by a click is measured in
[the navigation spec](../client/navigation.md) — and `node packages/bench/src/cli.ts channel` asks a
real browser in three engines which binding it opened and what it did when the upgrade was refused,
which is the downgrade path in traffic rather than in isolation.

What a real device would still add is the part no harness here can: an `OS`-suspended webview, and
therefore what `RESUME` recovers in practice rather than what it recovers when a page chooses to
reconnect. `spec/baseline/devices.md` says which lane that needs and what is missing behind it.

## Privacy

The resident digest in `RESIDENT` is a fingerprinting surface. It is coarse-bucketed,
origin-scoped, and omittable; the only cost of omitting it is falling back to the `html`
form.
