# The request lifecycle, and the two phases HTTP forces on it

Every framework has these phases. Almost none of them name the transitions, which is why
"you cannot set a cookie there" is documentation instead of a type error. Here the machine
is the thing that refuses, and every refusal is a named code.

## The states

| State       | What is true                                                            |
| ----------- | ----------------------------------------------------------------------- |
| `received`  | Nothing has run. 103 Early Hints may go out from here                   |
| `envelope`  | Phase A. Filters, guards, envelope effects. The envelope is open        |
| `planned`   | The plan is resolved, the derived headers are written, the seal is next |
| `streaming` | Phase B. Slots render. The context has no envelope methods on it        |
| `settled`   | The body is closed. A deferred effect is now owed to a later request    |
| `failed`    | Terminal                                                                |

Legal transitions are declared, and a move that is not one of them is `E_REQUEST_STATE`
naming the state it was refused in. `settled` and `failed` are terminal.

`Lifecycle.mustBe(states, what, code)` is the only guard anything else uses. It is not
called `require` — that name would collide with the check in
`packages/kernel/test/standards.test.ts` that the kernel contains no CommonJS, and a gate
that can be tripped by an unrelated method name is a gate that will be switched off.

## The seal

`envelope.seal()` returns a `ResponseInit` and closes the envelope. After it:

- `status()`, `redirect()`, `header()`, `setCookie()`, `cacheControl()`, `vary()` are all
  `E_ENVELOPE_SEALED`.
- Sealing again is `E_ENVELOPE_SEALED`, not a second envelope.

`Cache-Control` and `Vary` are written **before** the seal, from the resolved keys, because
they are derived from the same effect signature that produced the keys and there is no later
moment at which they could be added. This is the single most common reason to want a late
header, and it is a non-issue by construction rather than by discipline.

`content-type: text/html; charset=utf-8` is set the same way, through `headerIfUnset`, so a
route that produces something other than a document can say so in phase A and win.

`refuse(code)` is how a request ends in phase A with no body. `status()` only sets a code,
because a route is entitled to serve a 404 page — if refusing were just a status, a guard and an
error page would be indistinguishable to the kernel.

## Phase A and phase B are different types

```ts
route.envelope = (ctx: EnvelopeContext) => {
  if (!ctx.cookie('sid')) ctx.redirect('/login') // a real 302
}

slot.render = async (ctx: RenderContext) => {
  ctx.setCookie(...) // does not exist. not a runtime check — not on the type
}
```

`RenderContext` has the whole read surface and exactly one write: `defer()`. The compiler
already refuses `ctx.setCookie()` inside a fragment with `E_ENVELOPE_IN_RENDER`; this is the
same rule expressed in the runtime's types, so the two cannot disagree.

## 103 Early Hints

The pressure to flush early is almost entirely about subresource discovery, and HTTP
separates that from committing the envelope. `sendEarlyHints` emits the shell's critical
links at effectively zero milliseconds and leaves the envelope open.

It returns whether the hints actually went out, rather than void:

| Outcome                                  | Reported as                    |
| ---------------------------------------- | ------------------------------ |
| Transport wrote a 103                    | `sent: true`                   |
| Transport has no `earlyHints`            | `sent: false`, reason names it |
| Transport declined (HTTP/1.1, no accept) | `sent: false`, reason names it |
| Called after `planned`                   | `E_HINTS_AFTER_COMMIT`         |

103 is H2/H3 only. An HTTP/1.1 client simply waits for the final response, and Firefox has
an implementation that is off by default. `nodeTransport` in `@weftjs/adapters` implements it
over `ServerResponse.writeEarlyHints`, which Node exposes on HTTP/1.1 too, where a client is
entitled to ignore it — hence the boolean.

## Deferred envelope effects

An effect that resolves too late for this response can be attached to the headers of the
next request on the same connection, which for an interactive app is milliseconds away and
is a real HTTP response, so `HttpOnly` and `Secure` work normally.

Eligibility is not the developer's call:

- `envelope.required(write)` is legal only in phase A (`E_ENVELOPE_REQUIRED_LATE`).
- `envelope.deferrable(effect)` is legal in phase B, and refuses anything that is not
  idempotent with `E_NOT_DEFERRABLE`. Token rotation, a preference cookie and a last-seen
  timestamp qualify. Recording consent does not, and the check is on the name and the stated
  reason so that pretending otherwise takes a deliberate lie rather than an oversight.

The mailbox is bounded (`createMailbox(maxConnections)`) and evicts oldest-first. **If there
is no next request the effect is dropped.** That is the honest loss case and it is exactly
why only idempotent effects qualify. With no connection identity at all — no
`x-weft-connection` and no `connectionOf` — nothing is queued and the trace says so.

## Layer three: what a sealed response can still carry

Warp 1.1.0 adds two frames for the cases that reach the user rather than the CDN:

| Frame      | Code   | What it is, and is not                                                                                   |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `REDIRECT` | `0x20` | Acted on by the client, degrades to a meta refresh with no JavaScript. **A crawler will not follow it.** |
| `COOKIE`   | `0x21` | Non-`HttpOnly` values only, because `HttpOnly` is precisely the property a body cannot grant             |

## The front door, and what puts it on a port

An application that answers requests is built without anything listening. `weft start` puts it on a
TCP port; a host that owns the socket — a serverless function, a process manager that hands a
listener down, a test that drives the handler directly — takes the two callbacks instead, one for a
request and one for an upgrade. The split exists because binding a port is the one thing in a
deployment that is genuinely the platform's decision, and a framework that can only be reached by
opening one has decided it for every platform that does not work that way.

The handler never throws. A failure below it becomes the error document, and an upgrade to a path
that is not the channel ends the socket, which is what a 404 is on that side.

When `weft start` does bind, it binds `localhost` rather than `127.0.0.1`: on macOS `localhost`
resolves to `::1` first, and a server bound only to the IPv4 loopback is one the browser cannot
reach at the address printed in every tutorial.

Every document carries **`x-weft-revision`**, from `DeploymentPort`. One header on every response,
because the alternative is a deploy log and a guess — and during a rollout, which of two versions
answered is the whole question.

### The prelude the boot module needs

A handful of facts the client cannot derive are written into the page ahead of the boot module: the
intent table, the channel's path, whether this deployment holds connections, which intents are
signed, the scroll policy, and where the application's own client module is. Every one is build-time
knowledge, so a static copy cannot get it wrong — which matters, because the boot module has two
ways out of a deployment and they must not disagree. `weft start` prepends the prelude when it
answers the request; `weft build` bakes it into the file it writes, so the same module works when a
CDN is the one answering.

Two of them are written only when false or non-empty. A deployment that holds connections carries no
bytes for the fact, because holding them is what every other host does.

## What is irreducibly lost

After the seal you cannot retroactively obtain a real status code, an `HttpOnly` or `Secure`
cookie in-band, `Cache-Control` or `Vary` (the CDN has already decided), or a redirect a
crawler will follow. HTTP trailers look like an escape and are not one. Anything needing
those has to be in phase A, and the machine's job is to force it there rather than let it be
discovered in production.

## What this does not do

- **No method matching in the route table.** `serve()` matches a path (see
  [routing](routing.md)). Intents have their own dispatch and their own manifest, so a route
  matching on method would be a second dispatcher for one question.
- **`EffectSet.writes` is still empty, and stays that way.** A render cannot write, so there is
  nothing in a fragment to infer a write from. Invalidation is declared on the intent and an
  undeclared `ctx.revalidate` throws — see [`../compiler/effects.md`](../compiler/effects.md).
- **`revalidateAfterResponse` still needs somebody to drain it.** The memory adapter exposes
  `drain()`; the Workers adapter hands the same promise to `ctx.waitUntil`, which is the
  platform's own contract for work that outlives a response. What the kernel does not have is a
  default: a task queue with no runtime behind it is a leak, so the deployment names the drain.
