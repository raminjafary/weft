# Intents

The only thing in this framework allowed to write.

A render cannot write — that is enforced by the type of the context it receives, not by a
convention — so until intents existed `EffectSet.writes` was empty everywhere and everything
downstream of a write was blocked: invalidation, `revalidateTag`, an optimistic epoch driven by
a real mutation, and a route that can answer a POST.

## Two rules, and they mirror the plugin rules

**A write is declared, and an undeclared one throws.** `writes: ['cart']` is the complete set of
tags an intent may invalidate. `ctx.revalidate('orders')` from that intent is
`E_UNDECLARED_WRITE`, naming the tag and the field to add it to.

Unlike the plugin read guard this is **not** dev-only. An undeclared read is a missed
optimisation; an undeclared write is a cache invalidation nobody can predict by reading the
code, and predicting it by reading the code is the entire value of the effect graph.

**The client never names server code.** An intent is addressed by an opaque id derived from its
module and export (`intentId`), so renaming an export does not change the wire and the wire
does not disclose a function name. Moving an intent to another module _does_ change it,
deliberately. Resolving an id to an implementation is the `registry` port —
`manifestRegistry` derives its ids with the same function the compiler used to write them into
the wiring, because a manifest that spelled its own ids could disagree with the templates and
the disagreement would look like an intent that silently does nothing.

## Every refusal has a name and a status

| Code                      | Status | When                                                   |
| ------------------------- | ------ | ------------------------------------------------------ |
| `E_NO_SUCH_INTENT`        | 404    | No registered intent under that id                     |
| `E_CAPABILITY_DENIED`     | 403    | The bound check said no                                |
| `E_NO_CAPABILITY_CHECK`   | 501    | The intent declares a capability and no check is bound |
| `E_INTENT_INPUT`          | 422    | `input()` threw                                        |
| `E_UNDECLARED_WRITE`      | 500    | It invalidated a tag outside `writes`                  |
| `E_INTENT_FAILED`         | 500    | `run()` threw                                          |
| `E_INTENT_ON_SAFE_METHOD` | build  | A GET or HEAD pattern in the intent table              |

**An unchecked capability is refused rather than waved through.** Defaulting to allow would make
the declaration decorative, and a decorative authority check is worse than none because it
reads like one that works. Signing intents is phase 7; `CapabilityCheck` is the seam that will
hold it.

**What an intent invalidated before it failed is still reported.** The cache is already cold;
saying otherwise would be a lie a monitoring dashboard would repeat.

## Two representations, one dispatch

A mutation over plain HTTP has to work with no JavaScript at all. A form posts to a path, the
intent runs, and the answer is a **303 back to where the form was**. That is the whole
progressive-enhancement story, and it is why the intent path is method-aware routing rather
than only a channel frame: a client with a working socket takes the fast path, and a client with
none takes the one browsers have always had.

`fetch` gets the same dispatch and the outcome as JSON, chosen by `Accept` rather than by a
separate endpoint. The envelope is still open when the intent finishes, so a real status, an
`HttpOnly` cookie and a crawler-followable redirect are all available — which is the moment
they exist in, and the reason an intent runs in phase A.

A GET cannot carry a mutation: `createIntentRouter` refuses to be built from one. A GET that
writes is the oldest bug on the web and it is not going to be reachable by accident here.

## Over a channel: the optimistic case

The reason to run an intent over a channel rather than a POST is the epoch.

A client stages its own guess under `o-3` and sends `INTENT i=<id> epoch=o-3`. On success the
server stages the _real_ result into the same epoch and commits it, so the guess is replaced by
the truth in one paint. On failure the ACK carries `ok=false` and the client discards `o-3`.

**That is the whole of the rollback.** Nothing painted, so there is nothing to un-paint, and no
prior state has to be reconstructed. It needs no frame of its own, which is why `ACK` carries
the outcome rather than only the fact of arrival.

## Invalidation reaches other connections

An intent invalidates through its own declared-write guard, so by the time the channel sees the
outcome the store is already cold. `hub.notify(keys, reason)` turns those keys into `STALE`
frames for every connection holding one — every connection **except** the one that ran the
intent, which is about to be handed the new values instead of a note about the old ones.

Without that path an invalidation that came from a mutation would notify nobody, which is the
same bug as not having push invalidation at all.

## `ACK` moved

`ACK` was declared at `0x06`, in the up range, and used for the result of an intent, which
travels down. See [`spec/VERSIONING.md`](../VERSIONING.md) — Warp 1.2.0. `0x06` is retired
rather than reused.

## What this does not do yet

- **No signed intents, and no capability implementation.** `CapabilityCheck` is a seam; phase 7
  is the work.
- **No generated intent table.** `createIntentRouter` takes its routes by hand, like the plan's
  bindings. Generating both is phase 8.
- **No client-side intent transport.** The client routes an arriving `ACK` and discards a failed
  epoch; sending the `INTENT` is the application's, which is the phase 3 gap.
- **`EffectSet.writes` is still empty on fragments**, and correctly so — a fragment cannot
  write. An intent's writes live on the intent.
