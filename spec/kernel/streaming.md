# Streaming a route, and the two orders

The largest advantage this design has measured is streaming: against React Router 7 in the
shape most applications ship — loader awaited, then render — the difference is 2.19× to
first byte, and no renderer improvement recovers it. Until now that lived in a benchmark
candidate as `res.write(head); res.end(tail)`. This is the kernel making it a property of a
route.

A slot is a hole whose content the shell refuses to wait for. `splitAtSlots` cuts the
compiled shell at each one, which yields one more constant chunk than there are slots, and
those chunks are bytes the server can send before it knows anything about the slow work.

## The two orders are not a tuning knob

**`in-order`** streams each region where the document says it goes. It needs no JavaScript
at all. A slow region holds back every region after it.

**`out-of-order`** sends the entire shell first with an anchor comment at each slot, then
fills whichever region resolves first. Nothing waits on document order. It costs a fill
mechanism: **329 bytes** of inline script, sent only when a route actually has slots.

Measured with the slow region first — the only arrangement that separates the two — at
80 ms against 20 ms, p50 of 5 loads:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| in-order, slow region | 82 ms | 102 ms | 82 ms |
| in-order, fast region | 103 ms | 104 ms | 103 ms |
| out-of-order, slow region | 82 ms | 83 ms | 82 ms |
| out-of-order, fast region | **22 ms** | **23 ms** | **22 ms** |

The fast region arrives 4.7× earlier for 329 bytes. Both orders end at identical DOM in
all three engines, which is checked rather than assumed.

## Why the fill mechanism cannot be declarative shadow DOM

The design hoped holes could fill with no JavaScript where incremental declarative shadow
DOM parsing works. Implementing it sharpens that into something more specific, and less
convenient:

**Zero-JavaScript filling and out-of-order filling are mutually exclusive.** Slot
assignment works on the light-DOM children of a shadow host, and a child can only be
streamed into a host that is still open. Keeping a host open until its content arrives *is*
in-order streaming — and in-order streaming needs no fill mechanism in the first place,
because the content simply lands where it belongs. Out-of-order filling requires every host
to be closed already, so the content has to arrive somewhere else and be moved, and moving
a node is JavaScript.

So the honest statement is: zero-JavaScript filling is available, and it is available only
for in-order streaming. The 329 bytes are not a fallback for engines that fall short; they
are the price of fastest-first, on every engine.

## Incremental declarative shadow DOM, measured

The design calls this its largest platform risk: declarative shadow DOM is Baseline, but
attaching the shadow root *while the host is still streaming* is tracked separately and
could differ per engine. Probed with a host that does not close until 60 ms:

| Engine | Shadow root attached | Content slotted | Rendered on arrival |
| --- | --- | --- | --- |
| Chromium | 9 ms | 68 ms | yes |
| Firefox | 38 ms | 69 ms | yes |
| WebKit | 8 ms | 63 ms | yes |

**It works in all three.** The shadow root exists long before the host closes, and slotted
content renders as it arrives. The risk does not materialise, so in-order streaming is a
genuinely zero-JavaScript path rather than a hope.

One standing caveat, unchanged: Playwright's WebKit is not WKWebView on a device. This
result removes the desktop half of the risk and says nothing about iOS, and it says nothing
at all about a host application that intercepts the request and buffers the response — that
case is measured separately, by `--transport buffered`.

## The anchor stays

The filler removes the `<template>` and the `<script>` that moved it, and deliberately
leaves the `<!--w:name-->` comment in place. A hole that keeps its anchor can be filled
again, which is what a later refresh of the same region needs. It is also why the
conformance check compares the two orders' DOM with comments stripped: the anchor is a
difference that is supposed to be there.

## Not built

This is a route streamer, not a kernel. There is no routing, no request state machine, no
two-phase envelope, no 103 Early Hints, no ports, and no plan — a `Route` is a compiled
template plus a bag of slot resolvers, handed in by the caller. What exists is the one
property worth having first: the shell is never downstream of the query.
