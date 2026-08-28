# Instant navigation

A route fetched, parsed, and painting nothing, committed by a click.

Everything this needed already existed and none of it was pointed at a link. An epoch is data
that has arrived and resolved and has not been painted; the resident store keeps templates
across visits; and the swap is the one a control that changes the query has always done. What
was missing was the notion of a staged **route**: regions are keyed by slot on the page you are
on, so tomorrow's prices could be staged into today's page and a different page could not.

## The model

`createStaging` in `@weftjs/client` is an epoch one level up, keyed by URL rather than by slot.

| Operation      | Meaning                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `stage(url)`   | Fetch the answer for a route, or join the fetch already in flight for it. Paints nothing |
| `ready(url)`   | The resolved, unexpired answer, or nothing. Never a stale one                            |
| `claim(url)`   | What a click takes: the answer, and whether it was already there                         |
| `discard(url)` | Drop it, and abort the request nobody is going to read                                   |

Three properties are the ones epochs have, for the same reason. Staging cannot disturb the
present, because nothing in the model touches the document. A staged route that is never
committed costs a request and no paint. And a commit is one step rather than a fetch and a
render, which is the whole of what makes a navigation instant rather than fast.

The model is not DOM-aware and is not a router. What a staged route _is_ — a parsed document, a
set of frames, a value set — belongs to the caller, so the same model would serve a channel that
answered with slots.

**Bounded on purpose.** Four routes staged at once, and each one is a render the server performed
for a page nobody has asked for; the oldest is evicted first, because the newest is the one the
reader is most likely on their way to. An answer may be committed for thirty seconds, after which
it is discarded and fetched again — a page that shows a five-minute-old render instantly is worse
than one that waits.

## What the framework does with a link

Four signals, and only the first is a hover.

| Signal                     | When it stages              | What it is for                              |
| -------------------------- | --------------------------- | ------------------------------------------- |
| `pointerover`, `focusin`   | after 65 ms of hover intent | a pointer or a keyboard, deliberately aimed |
| `pointerdown`              | immediately                 | the only warning a phone gives              |
| a link visible in a region | after 300 ms, at most two   | a reader scrolling towards something        |
| speculation rules          | the engine decides          | Chrome's own heuristics, where they exist   |

Hover intent exists because below it a pointer crossing a nav on its way somewhere else prefetches
the lot. A press has nothing to disambiguate — a finger on a link is a decision — so it stages at
once, and the window it opens is the press plus the browser's tap handling: roughly 80–150 ms,
which on a mobile network is a head start rather than an answer.

**A link the reader has been looking at** is the strongest mobile signal and needs no gesture,
which is why the bounds are the whole design. Only links inside a `[data-weft-slot]` region, so the
chrome is excluded — a nav is on every page and lists every page, and staging all of it because the
reader can see it would be a fetch per link for a page they came to read. Only after 300 ms of
being visible, because scrolling past is not looking at. And at most two, so a hover and a press
still have somewhere to go inside the ceiling of four.

**Speculation rules** are the one mechanism here that is not this framework's: `prefetch` with
`eagerness: "moderate"` hands the decision to the engine, which has signals we do not — how the
pointer is moving, what the connection is doing, whether the reader is on a metered network. Where
it exists the HTTP cache is warm before `stage` is called; where it does not, nothing changes.
Chrome and Android WebView have it and Safari does not, which is the wrong half for iOS, so it is a
layer over the other three rather than a replacement for them.

A click is answered **only when the answer is already in hand**. This is the decision worth
stating, because the obvious alternative is wrong: waiting for the fetch the hover started makes
a slow page _worse_ than the browser would have made it. A document response streams — the shell
paints, then each region as it arrives — and a `fetch` of the same document must be read to its
last byte before there is anything to parse. Waiting on one leaves the reader on the page they
asked to leave, with no address-bar spinner to say why. So: staged, and the click is a DOM swap;
not staged, and it is a real navigation, which is what a link has always cost.

The same rule governs `popstate`. A back or forward to a route that is not staged is a load of
the entry the browser has already moved to, streamed the way the first visit was.

### What it will not take

Six cases, decided on the markup rather than on a heuristic, because in each of them answering
the click would do something the reader did not ask for.

| Case                                 | Why                                                        |
| ------------------------------------ | ---------------------------------------------------------- |
| Another origin                       | Not this application's to render                           |
| `target`, `download`                 | A request for a different destination entirely             |
| `rel="external"`                     | The author saying so in as many words                      |
| A modified or non-primary click      | The reader is asking for a tab, not a page                 |
| A fragment on the page already shown | The browser is scrolling; a swap would lose where it lands |
| The same path and query              | A reload, and a reload is the browser's to do              |

Staging is refused where the cost is not the reader's to pay: `data-weft-prefetch="off"` on a
link or on the document, a connection the browser reports as `saveData`, and 2G. On each of them
the click still works — it becomes a real navigation rather than an instant one.

## Where the reader lands

`navigation.scroll` in `weft.config.ts` decides, and the default is `top`.

| Setting    | What a route change does                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- |
| `top`      | Lands at the top, which is what a navigation has always done                             |
| `preserve` | Keeps the position, for pages where the position is the reader's place rather than noise |

`top` is the default because a swap that silently kept the position would be a framework quietly
changing what a link means. `preserve` is for the applications where the two pages are the same
page with different content — a long list whose filter is in the URL, a document with a chapter
per route. `data-weft-scroll="preserve"` on a link says it for one link and wins over the config.

The setting holds whichever path answers the click. A click on a route that was not staged is a
real navigation, and a real navigation lands at the top of a new document — so under `preserve`
the position is handed to that document through session storage and put back on the way in.
Without that, whether the reader kept their place would depend on whether they happened to hover
long enough first, which is a setting that works most of the time and is therefore worse than one
that does not work at all.

Back and forward ignore the setting entirely and restore the position recorded against the entry
being returned to, which is what a browser does and what a reader means by going back. The
framework takes scroll restoration over from the engine (`history.scrollRestoration = 'manual'`)
because two mechanisms both trying to put the reader back is worse than either: the engine
restores after load, so a position this runtime had already put back was quietly undone a frame
later. Taking it over means every path has to record one, so leaving a page records where it was.

**Twice, one frame apart.** Every landing is attempted immediately and again on the next frame if
it did not take. The document has just been rewritten and its height is whatever layout has got
to; asking for a position past the bottom of a short document clamps it to the top, and the
browser's own clamp lands _after_ the first attempt. The same applies to an in-place update: the
holes of a page are replaced one at a time, so for a moment the document is shorter than it was,
and a button pressed at the bottom of a page threw the reader to the top and back.

## Over the channel, which is what the design meant

A page that already holds a channel stages a route through it rather than over HTTP: `WARM at=`,
answered by `NAV`, then the target's regions as frames. It is tried only where a channel is already
open — opening one to stage a route nobody has clicked would be paying for speculation twice.

What it buys is the reason the channel exists. The regions come back through the same surgical
ladder a refresh uses, so a region whose template _and_ base this client already holds arrives as a
**delta**: the values that differ, for a page the reader has not been to. Measured on the demo, the
feed at forty rows staging the feed at eighty:

```
up    WARM  at=/app/feed?rows=80 epoch=n-2
down  NAV   form=slots s=panel,body,readout title=… css=…
down  DELTA s=body  tpl=3d3b9c65…  why=preferred by the plan  epoch=n-2
down  HTML  s=panel …  epoch=n-2
```

and the click that committed it took **1 ms**. A route on a _different_ page — the feed staging the
cart — comes back as three `HTML` frames instead, because none of those templates is held, and its
commit took 16 ms with no document request at all.

**The shell decision belongs to the server**, and it is the reason `NAV` has a `form` at all. Only
the server knows both shells: the one this connection is on and the one the target renders into. A
different shell has different holes, so its regions cannot be swapped into the ones on screen —
`form: 'document'` says so with the reason, and the client stages it the way a page with no channel
would. The demo's dashboard is that case, and it has a layout of its own.

**A staged route holds an epoch, and an epoch that is dropped is given back.** The staging model
evicts the oldest when it is full and expires an answer nobody committed; over a channel that
answer is a staged epoch on the client and a recorded base on the server. `release` on the staging
model is what stops a prefetch nobody clicked from being a leak.

**Nothing is committed by the server.** The client holds the epoch and commits it on the click,
which is the same commit an optimistic intent uses — every region flips together, and a partially
arrived route is never committed at all: a route is staged only when every region the `NAV` named
is held, and a partial answer becomes a document fetch instead.

## The commit

The body is replaced, not the holes. A layout's own values — the title, the heading, whatever the
route declared through `layoutValues` — are holes in the shell rather than slots in it, so a page
swapped hole by hole would have kept the previous one's chrome. What is reconciled around it:

- The title and every `meta[name]` the incoming document carries.
- Stylesheets, by href. The next page's are added and awaited before anything paints, and the
  ones it does not link are removed. While the route is staged they are fetched as
  `rel="preload" as="style"`, which is the whole point of the preload: appending them as
  stylesheets would apply a second page's rules to the one being looked at, which is the one
  thing staging may not do.
- Attributes on `<html>` and `<body>`.
- History: the scroll position is recorded against the entry being left, because that is the only
  entry that can hold it, and restored from the entry returned to.

Then every region in the new body is adopted from the payloads it carries, intents and controls
are wired, and the signals of the page that was left are dropped — a signal declared by a page
nobody is on is state with no owner.

Every failure is a real navigation rather than a wrong one: a bad status, a response that is not
HTML, a document with no `<slot>` holes, a redirect the server decided on (its URL wins), an
answer that arrived too long ago.

## The channel, across a navigation

A channel is not a request, so the client tells the server which page it is on and the server
re-runs _that_ route's loader for a refresh. Two things therefore have to happen at the commit,
and neither is optional:

1. **Re-register the path.** Every frame this client sends carries where it is. Without this the
   client asks for the new page's regions and is answered from the old page's route — which is
   not a stale render but the wrong one.
2. **Say what it now holds, and only that.** `HELD` gained a reserved `$only` header in Warp
   1.3.0. Slot names belong to a page: without it the previous page's `sidebar` stays in the
   server's map forever, is refreshed by a `REFRESH` that names no slots, and is told it is stale
   by an invalidation about a page nobody is on. `$only` clears the map and the connection's
   entries in the stale registry before the new set is read.

A page that had no channel does not open one to say this; a page that arrives with a live region
opens one, and it registers where it is as part of opening.

### A navigation that was overtaken while it waited

A staged route is claimed with no deadline, deliberately: waiting for a request already in flight
cannot cost more than discarding it and issuing an identical one. What that leaves is a reader who
clicks a slow route and then clicks others. The first claim settles last, and without a ticket it
painted last too — the reader landed on the page they had already changed their mind about, seconds
after the one they wanted had appeared.

Every `go` takes a number and checks it in the one place that works: **after the claim**, which is
where the time goes, and **before the commit**, which is where the damage would be. Checked
anywhere else it is decoration.

Three outcomes, because two of them are not failures:

| Outcome   | Means                                      | What happens                                          |
| --------- | ------------------------------------------ | ----------------------------------------------------- |
| `painted` | the staged answer was committed            | the swap, `pushState`, `weft:navigated`               |
| `cold`    | nothing was staged for this route          | the browser loads the document — the correct fallback |
| `stale`   | a newer navigation started while it waited | nothing at all                                        |

The third row is the one a boolean could not carry. `cold` falls back to `location.assign`, which
is right for a route nobody staged and exactly wrong for one the reader has moved on from: it would
send the browser to the abandoned URL _after_ the right page had painted, turning a wrong paint into
a wrong document.

Staging deliberately does not take the ticket. Hovering a link changes nothing about where the
reader is going, and if it did this it would cancel the click already in flight — the same bug from
the other side.

### Measured on a touch profile

Chromium with `hasTouch`, a 390×780 viewport and no pointer that can hover: the category pill is
staged from the viewport 300 ms after load, the speculation-rules script lists it, a `pointerdown`
finds it already held, and the tap commits in **10 ms**. Every step of that happens with no hover
anywhere, which is the case that did not work at all before.

## What it costs

| Entry                                 | brotli  | Ceiling |
| ------------------------------------- | ------- | ------- |
| Channel route                         | 4,081 B | 4,096 B |
| Channel route plus instant navigation | 4,932 B | 5,120 B |
| Plus what it knows about other routes | 5,301 B | 6,144 B |

851 bytes for staging and 369 for discovery, each in its own budget entry, because a page that links
nowhere should not carry the staging model and a capability with no ceiling of its own grows into
somebody else's headroom. `node packages/bench/src/cli.ts budget` is the gate.

The discovery entry is the one whose whole purpose is a request it does not make, so 369 bytes is
the number to hold it to: one avoided `WARM` and the render behind it pays for it many times over,
and a page whose links all share its shell pays it for nothing.

### What it buys, and where it buys nothing

`node packages/bench/src/cli.ts nav` clicks every link on a page twice: once with the route staged,
and once with `data-weft-prefetch="off"` on the document so the framework hands the same click to
the browser. Both figures are the page's own clock, from the navigation starting to the target
being interactive — `nav.lastMs` for the staged path, `readyAt` in the new document for the other.
The demo, in Chromium, ten samples each:

| Route             | Staged  | Browser  | Loopback | 100 ms RTT |
| ----------------- | ------- | -------- | -------- | ---------- |
| `/app/article`    | 1.0 ms  | 7.0 ms   | 7.00×    | —          |
| `/app/composed`   | 1.0 ms  | 6.0 ms   | 6.00×    | —          |
| `/app/cart`       | 16.5 ms | 14.0 ms  | 0.85×    | —          |
| `/app/ordinary/…` | 16.0 ms | 6.0 ms   | 0.38×    | 7.3×       |
| `/app/feed`       | 18.0 ms | 16.0 ms  | 0.89×    | 19.0×      |
| `/app/dashboard`  | 17.5 ms | 606.0 ms | 34.63×   | —          |

Read the first column of ratios as the honest floor: **on loopback a staged click is slower than
letting the browser do it** for a page the server produces quickly, because the swap costs more
than a local request that never left the machine. What the staging removes is the round trip and
the render, and loopback has neither — so the same two routes measured through the harness's
link proxy at 100 ms RTT come out 7.3× and 19.0× instead — those two are the only figures on this
page from an earlier run, because `--latency` currently hangs before it launches a browser, and a
number is better labelled than quietly replaced. The dashboard is the case that wins without any
latency at all, because its slots are deliberately slow: 606 ms of server work the reader spent
hovering rather than waiting.

Two routes come in at 1.0 ms staged. Those are the pages the client can serve entirely from what it
already staged — no document at all — and they are the shape the whole mechanism is for.

The bytes are identical either way. A staged navigation transfers the same document, from the same
kernel, on the same route; what changes is when it is asked for. That is also why `--bandwidth`
does not move this table much and moves the byte axes a great deal: the link proxy prices bytes,
and these two paths carry the same ones.

## What the client knows before it asks

Staging a route is a request and a render. Knowing _about_ a route is neither, and the two are worth
separating: a page can afford to know about thirty routes and stage two.

A `PLAN` frame carries what the client would otherwise have to fetch a document to learn — which
shell a route renders into, its region names, its stylesheet, the templates those regions need, and
where the profile says its readers go next. One arrives unasked when the channel opens, describing
this page and its onward routes; `weft.discover('/checkout/*')` asks about any other subtree. The
mechanism is in [`../kernel/routing.md`](../kernel/routing.md).

Two things change on this page as a result:

- **A link into a different document skips the `WARM` entirely.** Without the plan, staging such a
  link costs a round trip and a server render, and the answer is `form=document` — both thrown away.
  With it, the client goes straight to the document path it would have fallen back to. The decision
  is still the server's; it was simply given earlier, and for a subtree rather than one link.
- **The profile's transitions reach a page that arrived by a document request.** `NAV next=` only
  ever reached a client that had already staged something over the channel, which excluded every
  first visit. The handshake `PLAN` is where that hint has a home, and the two routes it names are
  staged once the page is interactive.

A stylesheet named by a discovered route is `preload`ed rather than linked — a second page's bundle
appended as a stylesheet would apply its rules to the page being looked at, which is the one thing
staging may not do.

## What is not built

**A discovery signal that is not a link or a hover.** `weft.discover` is called by an application
that knows something the framework does not; nothing calls it on the framework's own initiative
beyond the handshake.

What _is_ decided now is whether the handshake should describe a given route at all. The recording
counts descriptions handed out against descriptions followed — a `WARM at=` for a pattern this
connection was told about, which is the only way a client knows the shell matches — and a route under
20% over at least eight descriptions stops being volunteered. An unmeasured route keeps describing, the
same rule delivery follows, and a prefix somebody _asked_ about is answered whatever the recording says,
because the measurement is about what this deployment volunteers. See
[`../plan/profile.md`](../plan/profile.md).

What is still refused, and stated as refused: a prefix no client has ever asked about and no transition
points at has no observation behind it. There is nothing to count, and a number invented for it would be
the guess the profile layer exists instead of.

**And whether a described route is worth staging is the same measurement, read per source page.**
`RouteDecision.stage` records which pages readers arrive at a route _from_ often enough for staging to
pay, and a `PLAN` frame now carries `stage: false` for a route whose recorded sources do not include
the page the connection is on. The client checks it in `prefetchable`, which is the one gate hover,
viewport dwell and pointer-down all pass through — so a decision that applied to two of the three
signals is not expressible.

Absent means unmeasured and unmeasured stages, the same rule delivery and discovery follow. A route
with no recorded arrivals at all is unmeasured rather than refused: a page nobody has reached yet has
nothing to count, and inventing a `false` for it would turn a cold recording into a framework that had
switched staging off.

**Off-main-thread preparation.** Parsing the staged document happens on the main thread, in the
`DOMParser` call inside the staging load, and it cannot move: `DOMParser` does not exist in a
worker. The other candidate — decoding a batch of frames — was measured and refused, because the
decode is smaller than a worker's own floor. See [`../FINDINGS.md`](../FINDINGS.md).

**A discovery signal the framework raises on its own.** `weft.discover` is still only called by an
application that knows something the framework does not. What _is_ decided from a measurement now is
whether a route is worth describing at all, and whether it is worth **staging** from the page you are
on — both below.
