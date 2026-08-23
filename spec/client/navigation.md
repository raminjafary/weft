# Instant navigation

A route fetched, parsed, and painting nothing, committed by a click.

Everything this needed already existed and none of it was pointed at a link. An epoch is data
that has arrived and resolved and has not been painted; the resident store keeps templates
across visits; and the swap is the one a control that changes the query has always done. What
was missing was the notion of a staged **route**: regions are keyed by slot on the page you are
on, so tomorrow's prices could be staged into today's page and a different page could not.

## The model

`createStaging` in `@weft/client` is an epoch one level up, keyed by URL rather than by slot.

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

### Measured on a touch profile

Chromium with `hasTouch`, a 390×780 viewport and no pointer that can hover: the category pill is
staged from the viewport 300 ms after load, the speculation-rules script lists it, a `pointerdown`
finds it already held, and the tap commits in **10 ms**. Every step of that happens with no hover
anywhere, which is the case that did not work at all before.

## What it costs

| Entry                                 | brotli  | Ceiling |
| ------------------------------------- | ------- | ------- |
| Channel route                         | 4,004 B | 4,096 B |
| Channel route plus instant navigation | 4,669 B | 5,120 B |

665 bytes, in its own budget entry, because a page that links nowhere should not carry the
staging model and a capability with no ceiling of its own grows into somebody else's headroom.
`node packages/bench/src/cli.ts budget` is the gate.

### What it buys, and where it buys nothing

`node packages/bench/src/cli.ts nav` clicks every link on a page twice: once with the route staged,
and once with `data-weft-prefetch="off"` on the document so the framework hands the same click to
the browser. Both figures are the page's own clock, from the navigation starting to the target
being interactive — `nav.lastMs` for the staged path, `readyAt` in the new document for the other.
The demo, in Chromium, five samples each:

| Route             | Staged | Browser | Loopback | 100 ms RTT |
| ----------------- | ------ | ------- | -------- | ---------- |
| `/app/article`    | 17 ms  | 7 ms    | 0.41×    | —          |
| `/app/cart`       | 19 ms  | 17 ms   | 0.89×    | —          |
| `/app/ordinary/…` | 17 ms  | 15 ms   | 0.88×    | 7.3×       |
| `/app/feed`       | 22 ms  | 18 ms   | 0.82×    | 19.0×      |
| `/app/dashboard`  | 17 ms  | 606 ms  | 35.7×    | —          |

Read the first column of ratios as the honest floor: **on loopback a staged click is slower than
letting the browser do it** for a page the server produces quickly, because the swap costs more
than a local request that never left the machine. What the staging removes is the round trip and
the render, and loopback has neither — so the same two routes measured through the harness's
latency proxy at 100 ms RTT come out 7.3× and 19.0× instead. The dashboard is the case that wins
without any latency at all, because its slots are deliberately slow: 606 ms of server work the
reader spent hovering rather than waiting.

The bytes are identical either way. A staged navigation transfers the same document, from the same
kernel, on the same route; what changes is when it is asked for.

## What is not built

**A staged route over the channel.** The design's `WARM` is "stage data for a route, do not
paint", and what is implemented answers with templates. A route staged here is a document over
HTTP, which is the same path a first visit takes and therefore renders every slot the same way.
`NAV` (0x1d) remains a declared frame code with no implementation: staging a route needs the
whole page, and the whole page is what the document request path already produces.

**Off-main-thread preparation.** Parsing the staged document happens on the main thread, in the
`DOMParser` call inside the staging load. Nothing measures it yet, and nothing moves it.

**A staged route that is worth staging.** Everything hovered is fetched, and nothing decides
whether it was worth it. `weft profile` is the roadmap entry where that belongs: which routes are
worth speculating on is a measurement, not a hover.
