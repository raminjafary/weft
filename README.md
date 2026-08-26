# Weft

A TypeScript fullstack framework whose bet is the **delivery layer**: the wire form of a piece of UI
is negotiated per request over a set of encodings the compiler has proven equivalent, instead of
being frozen at build time.

Everything below is measured, and the measurements are reproducible from this repository. Where a
number reverses a claim the design made, the reversal is recorded rather than the claim quietly
edited — [`spec/FINDINGS.md`](spec/FINDINGS.md) is the claim-by-claim ledger.

```sh
pnpm install
pnpm build      # ten packages, in dependency order
pnpm demo       # six shapes of page        :4173
pnpm inspect    # every mechanism, running  :4180
```

Both are weft applications. `demo/` imports `weft` and nothing else; `@weft/inspector` reaches into
the kernel, the plan layer and the adapters, because taking those apart is what it is for.

---

## Why it is fast, with the numbers

**Server render throughput** — pre-encoded byte segments against string concatenation, both
rendering the same compiled templates, so this compares the mechanism and nothing else. Apple M4,
Node 24.18, loopback, 300 samples.

| Scenario      | Segments            | String SSR |       |
| ------------- | ------------------- | ---------- | ----- |
| shell, 707 B  | 1,165,022 renders/s | 594,914    | 1.96× |
| cart, 12 rows | 236,539             | 167,419    | 1.41× |
| feed, 50 rows | 62,492              | 43,807     | 1.43× |

**Bytes per server-driven update** — one row's quantity and price change:

| Form    | Raw   | Brotli |
| ------- | ----- | ------ |
| `html`  | 6,289 | 605    |
| `delta` | 371   | 187    |

16.9× smaller raw, 3.2× after brotli, and nothing else in the field offers it without a stateful
process per connection.

**Streaming is the largest advantage measured anywhere here**, and it is architectural rather than a
renderer trick. A slot is a hole the shell refuses to wait for. With the slow region first, 80 ms
against 20 ms:

|                           | Chromium  | Firefox   | WebKit    |
| ------------------------- | --------- | --------- | --------- |
| in-order, fast region     | 103 ms    | 104 ms    | 103 ms    |
| out-of-order, fast region | **22 ms** | **23 ms** | **22 ms** |

4.7× earlier, for 329 bytes of inline script, with identical final DOM in all three engines.

**The client runtime.** Adoption walks the DOM the parser built and records where each value lives,
with no component code executing. 50-row region, ~200 bindings, p50:

|                                   | Chromium                                       | Firefox   | WebKit    |
| --------------------------------- | ---------------------------------------------- | --------- | --------- |
| Adopt the region                  | 0.047 ms                                       | 0.095 ms  | 0.040 ms  |
| Parse the same markup             | 0.076 ms                                       | 0.060 ms  | 0.140 ms  |
| Apply a 12-path delta surgically  | 0.0017 ms                                      | 0.0029 ms | 0.0015 ms |
| One signal write to one node      | 0.31 µs                                        | 1.7 µs    | 0.74 µs   |
| The same write through a computed | not separable from the row above in any engine |           |           |

A delta applied as designed — one write per changed value, into DOM that already exists — is
**20–93× cheaper** than the parse it replaces.

**Repeat visits.** Templates persist in IndexedDB, are advertised to the server as a coarse digest,
and arrive as `TPL` frames only when the client does not already hold them:

| Boot path, p50    | Chromium    | Firefox | WebKit  |
| ----------------- | ----------- | ------- | ------- |
| First visit       | 2.50 ms     | 6.00 ms | 3.00 ms |
| Repeat visit      | 0.70 ms     | 3.00 ms | 1.00 ms |
| Protocol bytes    | 1,124 → 132 | same    | same    |
| `TPL` frames sent | 2 → 0       | same    | same    |

IndexedDB rather than a service worker, because WKWebView gates service workers behind app-bound
domains — the traffic where a repeat-visit gain matters most is the traffic that does not have them.

**The shared surgical refresh.** The client names the base it holds, the server recovers it through
`StorePort`, diffs, and memoizes under `delta:<tpl>:<from>-><to>`. A thousand clients on one base
cost **one** diff — 0.3 ms against a per-connection differ's 8.2. A thousand clients each on a
_different_ base share nothing, and the shared path then costs 17.3 ms against 9.2. Both numbers are
in the report, because the second is where a deployment gets surprised.

A region whose values are not projectable — a `raw()` value, an isolated instance, a `slot` hole —
cannot serve a delta at all, and used to fall the whole way to markup on every refresh. It now takes
the rung between them: a `patch`, addressed the way adoption addresses the DOM, applicable by a
client holding no copy of the template. 4.3–6.0× smaller than the region raw, 1.9–2.6× after brotli,
3.3–3.9× cheaper to apply than the parse it replaces — and on a 141-byte region it is _larger_ than
the markup after compression, which is in [`spec/kernel/surgical.md`](spec/kernel/surgical.md) with
the reason it is still the right answer there.

**Instant navigation.** Hover stages a route into an epoch that paints nowhere; a click commits it as
a DOM swap. 17 ms staged against 606 ms on the demo's deliberately slow page, and 7–19× on ordinary
ones at 100 ms injected RTT. On loopback a staged click is _slower_ than letting the browser do it,
which is the honest floor of the idea and is in
[`spec/client/navigation.md`](spec/client/navigation.md) with the table.

### The phase-zero gate, and its answer

The design's own falsification test: _if the pre-encoded-buffer shell does not beat a tuned React
Router 7 app on TTFB in a reproducible test, the central premise is wrong._ A route whose data takes
40 ms, 40 ms of injected RTT, and [a real RR7 app](benchmarks/rr7) in two configurations:

| Candidate                                                 | TTFB p50     | Last byte | Bytes |
| --------------------------------------------------------- | ------------ | --------- | ----- |
| Weft segments                                             | 43.46 ms     | 84.67 ms  | 6,289 |
| String-concat SSR, streaming                              | 43.48 ms     | 84.84 ms  | 6,289 |
| **RR7, tuned** — promise loader, Suspense, `onShellReady` | **44.65 ms** | 90.78 ms  | 7,687 |
| Await the loader, then render                             | 84.75 ms     | 84.78 ms  | 6,289 |
| **RR7, default shape** — awaited loader, `onAllReady`     | **95.35 ms** | 95.40 ms  | 6,370 |

**The premise survives and the framing does not.** Against a tuned RR7 app the shell is 1.03× faster
to first byte — 1.2 ms on a 43 ms number. TTFB against a competent competitor is not the
differentiator, and a design marketed on it would be marketing 1.2 ms. What the test does establish
is worth more:

- **Streaming is the whole game.** The two blocking candidates pay their query before their first
  byte — 1.95× and 2.19× worse — and no renderer improvement recovers it. Weft cannot be configured
  into that failure, because a fragment that reads something slow is a hole by construction. RR7 can,
  and its default shape is the slow one.
- **The edge is on the axes nobody markets**: 6.7% faster to last byte, 18% fewer bytes for the same
  content, because React ships Suspense markers and comment nodes segments do not need.
- **The renderer mechanism is invisible to latency.** The 1.4–1.96× throughput difference is real and
  it lives in server capacity.

---

## Writing one

A folder is an application. The route table is the file tree, and the plan that places everything on
a page is generated from it — no wiring, and no config file you must have.

```
app/
  layout.tsx            the document. Its <slot> holes are what a route fills
  routes/index.tsx      /            routes/[slug].tsx  /:slug
  routes/x.data.ts      x.tsx's head, cache policy, loader, guard and slots
  routes/x.css          linked only by the pages that render x
  routes/<dir>/layout.tsx  wraps every route under <dir>, inside app/layout.tsx
  fragments/<name>.tsx  a component, referenced by name from a route's slots
  slots/<name>.tsx      fills the layout hole of that name on every route
  intents/**.ts         mutations. The manifest is generated from this directory
  renderables/**.ts     fragments a client may ask for by opaque id
public/                 served as written, and again at a URL carrying its digest
weft.config.ts          what this deployment binds
```

```sh
npm create weft my-app

pnpm docs:dev       # the documentation site, which is itself a weft application
weft dev            # serve, and rebuild what changes
weft dev --devtools # plus this application's routes, keys and bytes as pages
weft build          # sealed templates, the generated plan, the manifest, revved assets
weft start          # serve the build. No compiler runs
weft routes         # the route table, as the file tree produced it
weft why /          # the plan the framework generated for a route, chain included
weft dev --profile  # record what every render costs, and plan the next run from it
weft verify --probe # ask every region what it is serving, and exit non-zero on disagreement
weft upload --to …  # PUT the build to an object store. --header is where authentication goes
```

**There is no bundler.** Client modules are TypeScript with their types stripped by Node and two
bare specifiers rewritten, so what runs in the browser is the file on disk. Adoption, intents, the
channel and control wiring are reached through attributes — `data-weft-control`, `data-weft-apply`,
`data-weft-intent` — so an application needs no client code at all, and the demo has none.

**Every URL the browser fetches carries a digest and is immutable for a year.** `weft dev` serves the
same bytes at stable names with `no-store`, because a stylesheet you just edited served as immutable
is a framework that lies to you for a year.

---

## What it does that the shape of the field does not

**A route cannot declare a cache key.** Keys come from what the compiler saw a fragment read; there
is no setter in the kernel, the plan DSL or the plugin surface, and that absence is the enforcement.
`.cache('public')` on a fragment that reads identity fails the build with `identity` named.

**A conditional page is one a route asked for.** An `ETag` is a digest of the whole entity and the
envelope is sealed before the first byte, so a page that streams cannot carry one — and a framework
that quietly held a streaming page back to digest it would be trading away the property it is built
on. `etag: true` on a route whose slots all buffer gets a strong tag and a 304 that costs no body;
the same declaration on a page that streams is `E_ETAG_STREAMS` with the streaming slots named.

**`onExceed: 'stale'` means the last good render**, which is the expired entry under the slot's own
key — no second key, no second write, and nothing on the success path. An entry that was
_invalidated_ is not recoverable and must not be: expiry means possibly out of date, invalidation
means known to be wrong, and only one of those is safe to show somebody.

**A page that reads nothing is a file, and a page whose parameters are a set somebody declared is
several.** `weft build` renders every route through the real kernel twice — under two requests
differing in cookies, locale, device, headers, query, flags and a clock ten years apart — and writes
the byte-identical ones to `.weft/static/`. `weft start` answers those paths before the kernel is
reached, with an ETag and a 304. A route declaring `params: { category: ['pantry', 'household'] }` is
one document per value, each proved on its own — a passing probe for one says nothing about the
other. A partial enumeration is refused, because files for some URLs of a route and a render for the
rest is the one outcome nobody could debug. For every other page the build prints the reason: an
undeclared parameter, a read, a live region, a streaming slot.

**`weft upload --to <url> --header <k=v>`** puts that directory in an object store over plain HTTP.
No SDK and no credential chain: every store worth using accepts an authenticated `PUT`, and a
framework that depended on one provider's client would have to depend on the next one's. An
immutable asset already there is skipped because its URL names its contents; a document is never
skipped because its URL does not.

**The request is a state machine**, `received → envelope → planned → streaming → settled`. Phase B is
a _different context type_ with no envelope methods on it, so the mistake every other framework
documents cannot be written here. `Cache-Control` and `Vary` are written before the seal, from the
resolved keys. 103 Early Hints goes out at effectively zero milliseconds with the envelope still
open, and `sendEarlyHints` returns whether it actually went out rather than claiming it did.

**Render is a DAG.** `needs` is data dependency only: nine slots, three waves, a 42.7 ms critical
path against a 123.3 ms sequential walk. Safe for exactly one reason — render is provably read-only,
so two fragments cannot observe each other's side effects because they cannot have any.

**A CPU budget is only enforceable where a render can be preempted**, so preemption is declared on
the executor in three states, and a breach on `inline` is reported with a message saying it ran to
completion anyway. `pool:` is a real `worker_threads` pool that terminates a render mid-loop.

**Epochs separate data currency from view currency.** Staged frames paint nothing; one `COMMIT` flips
every slot at once. Prefetch cannot disturb the present, rollback is discarding an epoch, and it
costs 254 bytes on the client.

**Intents are the only thing allowed to write**, and they declare what they invalidate; an undeclared
tag throws, because an undeclared write is an invalidation nobody can predict from the code. A form
posts and gets a 303 back where it came from — the whole no-JavaScript path — and the same dispatch
answers a `fetch`.

**Authority is two questions asked in order.** A capability is a property of the caller; a signature
is a property of the call — this checkout, this reader, this payload, minutes ago, not used before.
Deny by default and deny on failure. A grant matching everything is refused where it is written, and
a capability an intent requires that no role can grant fails the build rather than becoming a 403
nobody can explain. Signed intents are Ed25519 over a 263-byte token against a pinned public key
bundle; the verifier holds public keys only, which makes the design's separable authority tier a
config file rather than an aspiration.

**Spent once means spent across processes, and now across machines.** A nonce is a store lease nobody
releases, so replay protection is exactly as wide as the lease — and a store was answering two
questions with one field. Split: `sharedLeases(store, { dir })` agrees across every process on a
machine, `redisLeases(store, { url })` across every instance of the deployment, and neither makes the
cache shared. A store that cannot be reached refuses the call rather than reporting the nonce fresh,
because an outage is exactly when a replay is worth attempting.

**A region is a fragment that lives somewhere else, and nothing new runs it.** A shell says `search`;
the registry says what `search` is — this process, a service binding, another pod — and it runs on an
executor that was already a crash domain and already a budget boundary. What comes back is Warp
frames, because that is what every render here already produces, so there is no translation layer at
a tier boundary. **The same region composed in-process and over a binding produces byte-identical
markup**, which is the test that fails first if the collapsed monolith becomes a special case.
Rolling a region is a registry write, not a redeploy of the shells that name it.

**Invalidation crosses that boundary now, and what crosses it is authority rather than a key.** A
composite holds a contract and the region holds its own keys, so there is nothing here to drop — but
which connections are showing that region is a question only this side can answer. `POST /_weft/stale`
with a secret bound for that region in `weft.config.ts`, naming the region and never a slot, and
every connection whose `HELD` names the hole it fills is told. A region with no configured secret
cannot tell this deployment anything, which is the right default for something that reaches every
open page.

The check is the part that is new. Frames from another deployment are somebody else's and a length
prefix does not say whose, so a region opens with `REGION` naming **itself** — and may write only
into its own hole. A sibling's slot is `E_REGION_ESCAPE`; a `SHELL`, `COOKIE` or `PLAN` is
`E_REGION_FRAME` with the authority it would have borrowed named. Every refusal degrades that one
region to its declared fallback, because a page that dies when one of five regions misbehaves has
thrown away the isolation it paid a hop for.

**A composite reports its shape, not just its cost.** Hops are counted rather than discovered, and a
tier that composes tiers reports what it measured. `weft verify --probe` walks the whole tree — each
tier answers for its own registry and the tier above splices — and prints it as one graph, with
`W_REGION_TREE_DEEPER` when a route turns out to cross more boundaries than its plan could count. It
costs the request path **zero bytes**: a page needs the hop count and the count is a header, so a
subtree travels only in a probe's answer, and the module that writes one is the module that reads
one.

**A plan can come from a measurement, for the half that is about time.** `weft dev --profile` records
what every render costs and the next generation plans delivery from it — a slow region streams, a
uniformly fast page buffers so the 329-byte filler stays off the wire, and a slot with fewer than
eight renders decides nothing. Placement, cache classes and keys are untouched: a recording of last
Tuesday has no standing over what the compiler inferred.

**Ports replace, plugins extend.** Fourteen declared, fourteen implemented, eleven bound by the front
door with no configuration. A port that is not bound refuses by name and never approximates: a
declared rate limit with no limiter is `E_NO_RATE_LIMIT`, not unlimited. And a store on an edge
key-value namespace refuses `lease` outright — a lease that is not atomic is a stampede guard that
does not guard and a replay guard that reports every nonce fresh, which is the one place here where
an approximation is a security bug.

**A live page opens one socket, and falls back to two fetches when the upgrade does not survive the
path.** The runtime itself opens nothing — `createChannelClient` takes frames rather than a URL, so
one code path serves a socket, an SSE stream and a test — and the front door is the layer allowed to
choose. Verified by asking the _server_ which binding it got, in all three engines, and again with
the upgrade deliberately refused.

**The kernel imports nothing but the WinterTC Minimum Common Web API.** That rule has a test, and the
test failed on its first run — `serveRoute` had been importing `node:http` for weeks.

---

## Byte budgets, which are gates rather than reports

Bundled with Rolldown, compressed the way it would ship. A test fails the moment an entry crosses its
ceiling.

| Entry                                     | brotli     | gzip   | raw    | Ceiling |
| ----------------------------------------- | ---------- | ------ | ------ | ------- |
| Client runtime, everything                | **6,109**  | 6,719  | 18,247 | 6,144   |
| Content route — adopt and bind            | **2,226**  | 2,426  | 6,657  | 5,120   |
| App route — adopt, bind, patch, epochs    | **3,154**  | 3,443  | 9,109  | 12,288  |
| Channel route — plus routing frames       | **4,081**  | 4,467  | 11,841 | 4,096   |
| Patching route — plus applying a patch    | **4,571**  | 5,031  | 13,783 | 5,120   |
| Navigating route — plus staged routes     | **4,932**  | 5,403  | 14,241 | 5,120   |
| Front door — the code, bundled            | **13,428** | 14,858 | 43,383 | 14,336  |
| Server kernel — the document request path | **8,118**  | 9,122  | 23,764 | 8,192   |
| Kernel + intent dispatch                  | **9,656**  | 10,870 | 28,845 | 10,240  |
| Kernel + surgical refresh and epochs      | **10,893** | 12,202 | 32,838 | 12,288  |
| Kernel + the patch encoder                | **11,563** | 12,950 | 35,309 | 12,288  |
| Kernel + authority                        | **11,631** | 13,049 | 35,057 | 12,288  |
| Kernel + composition                      | **11,271** | 12,661 | 33,951 | 12,288  |
| Kernel + a live Warp channel              | **13,546** | 15,154 | 40,961 | 14,336  |
| Kernel + composition over a live channel  | **16,509** | 18,520 | 50,732 | 17,408  |

**The front-door row is the code, not the download, and the difference is 3.5×.** It bundles with
Rolldown and minifies; this framework has neither, so a page fetches nineteen modules served as
written with their comments intact — **46,698 B brotli** for the demo, agreeing within 0.3% with the
same walk over HTTP. That is now the gated number: `budget({ js, grow })` in the plan is enforced by
`weft build`, which writes `weft.budget.json` so a regression is a diff. The bundled row stays as a
gate on how much code there is, and stopped claiming to be what anybody pays. See
[`spec/FINDINGS.md`](spec/FINDINGS.md).

**The 8 KB claim is scoped and met**: 8,118 B against 8,192 covers the document request path —
lifecycle, envelope, routing, key derivation, wave dispatch, the stream. Every other capability gets
its own entry and its own stated ceiling rather than a share of that one, so the first feature to
arrive cannot spend the headroom every later one needs. The first attempt measured the whole barrel
and came out 29% over, which is the gross-versus-marginal mistake the design warns about, made
immediately. See [`spec/kernel/budgets.md`](spec/kernel/budgets.md), including the two watermarks
that have moved and the reasons they moved.

---

## What measurement did to the design

**A form was cut.** `data` — values only, projected through a template the client already holds — was
the most distinctive thing in the negotiated set.

| Evidence              | Result                                                                |
| --------------------- | --------------------------------------------------------------------- |
| Bytes, raw            | 3,100 against `html`'s 6,289 — a 2× win                               |
| Bytes, brotli         | 599 against 605. **1%** — compression already removes that redundancy |
| Client work, Chromium | 1.16× _more_ than `html`; Firefox 1.33×; WebKit 1.07×                 |

The decisive argument is architectural anyway: **a `data` refresh into a resident template is a
`delta` that has declined to diff.** It went, as IR 2.0.0 — a form leaving the vocabulary is a wire
break, and the versioning contract says a major refuses rather than migrates.

**Escape elision is worth nothing, and an earlier claim here was wrong.** Typed, 4 holes elided:
16,780 ns per render. Syntax-only, 0 elided: 16,503. The renderer already elides at runtime by
scanning before escaping. The real 7.9% was the **marker comments** the compiler emits so a text node
is addressable — a genuine cost for a genuine capability, mis-attributed. The type oracle stays on a
smaller justification: it makes the IR's escape class _true_ rather than conservative, which matters
to a native codec crossing a WASM boundary even where it does not matter to this renderer.

**Off-main-thread decoding was measured and refused.** So was two thirds of profile-guided planning:
chunk packing assumes a bundler this framework does not have, and V8 compile hints assume a function
per template where a template here is data.

**Zero-JavaScript hole filling is real, and it is exclusive with out-of-order.** Incremental
declarative shadow DOM works in all three engines — the root exists at 8–38 ms against a host that
does not close until 60 ms. But slot assignment needs a host that is _still open_, and keeping one
open is in-order streaming. The 329 bytes are the price of fastest-first on every engine, not a
fallback for weak ones.

---

## What the harness refuses to do

The point of building it first is to make it hard to fool ourselves later.

- **It aborts if the wire forms disagree.** Every form of every scenario must be byte-identical
  before anything is timed — including each candidate's response _as served over HTTP_, because a
  streaming server assembles its response separately from the in-process renderer.
- **It refuses claims below the noise floor.** Overlapping p50 ± MAD is "not separable at this sample
  size — no claim".
- **It never aggregates engines**, and labels `webkit` a desktop proxy rather than an iOS number.
- **It says "not measured" with a reason** instead of reporting a zero.
- **It states each axis's expectation up front**, including the one where the honest answer is a tie.

```sh
node packages/bench/src/cli.ts list       # axes, scenarios, candidates
node packages/bench/src/cli.ts verify     # every wire form must agree
node packages/bench/src/cli.ts budget     # every entry against its ceiling
node packages/bench/src/cli.ts client     # adopt and patch, in three engines
node packages/bench/src/cli.ts slots      # both stream orders, and the shadow-DOM probe
node packages/bench/src/cli.ts devices    # the device lane, and whether each driver answers
node packages/bench/src/cli.ts nav --latency 100
node packages/bench/src/cli.ts run --axes shell-ttfb --scenarios slow-feed \
  --latency 40 --bandwidth 1600 --external benchmarks/rr7/candidates.json  # the gate, against RR7
node --test packages/*/test/*.test.ts demo/test/*.test.ts  # conformance
```

`--latency` puts a round trip in front of loopback; `--bandwidth` and `--loss` put a rate and a hole
in it, so a byte difference costs time rather than nothing. The model is serialization, slow start
and in-order loss recovery — every omission (the handshake, ack clocking, competing flows) makes a
real link worse than the modelled one, which the report states with the numbers.

`--engines ios` and `--engines android` are real names that refuse until `--devices` points at
hardware: Android over CDP through `adb forward`, iOS over W3C WebDriver through Appium. The
measurement needs a device; the lane is config.

Third-party candidates are configured, never vendored: `--external` spawns another framework's app
and measures it over HTTP on the same axes.

---

## Refused, and why the refusal is still true

- **A signed intent with no JavaScript.** A cache key here is derived from what the compiler saw a
  fragment read, and a minted token is not a read — so a region carrying one would be stored under a
  key that does not describe it and handed to the next reader. Minting is its own uncacheable
  request; a form posting to a signed intent is refused with a page that says why, and the demo shows
  both buttons side by side.
- **A virtual DOM.** The delta form addresses holes directly. There is nothing to reconcile.
- **A cache key that can be written by hand.** No setter; a plugin may add an axis but never a key.
  The one extension point the design refuses on purpose.
- **A sliding-window rate limiter.** `countingLimits` is a fixed window and says so. A sliding one
  needs a store that can count atomically, and `StorePort` deliberately has a lease, not a counter.
- **Zero-JavaScript out-of-order streaming**, for the reason above.
- **HTTP trailers as an escape from the sealed envelope.** They look like one. Browsers do not apply
  them to these semantics.
- **`E_CHILDREN_NOT_SOLE_CHILD`, `E_PRIVATE_COMPONENT_NESTED`, `E_COMPONENT_NOT_SINGLE_ROOT`,
  `E_DELTA_NOT_INVERTIBLE`** — each a consequence of templates being data compiled without seeing
  their call site, stated in [`spec/compiler/supported-subset.md`](spec/compiler/supported-subset.md).

---

## The specs, and where each one is implemented

| Spec                      | Where                                                                                          | State                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Template IR               | [`spec/ir/template-ir-2.md`](spec/ir/template-ir-2.md), `packages/ir`                          | 2.6.0 — children, instances in rows, derived values, contagion, `patch` derived |
| Warp frames               | [`spec/warp/warp-1.md`](spec/warp/warp-1.md), `packages/warp`                                  | 1.8.0 — a region announces itself, and a failed negotiation says so             |
| Versioning contract       | [`spec/VERSIONING.md`](spec/VERSIONING.md)                                                     | Majors refuse, minors round-trip                                                |
| What measurement changed  | [`spec/FINDINGS.md`](spec/FINDINGS.md)                                                         | Five reversed, two clarified                                                    |
| Template compiler         | [`spec/compiler/supported-subset.md`](spec/compiler/supported-subset.md), `packages/compiler`  | TSX to IR on Oxc, type-driven escape class, components any shape                |
| Effect inference          | [`spec/compiler/effects.md`](spec/compiler/effects.md)                                         | Reads inferred, cache class derived, ambient reads banned                       |
| Client runtime            | [`spec/client/adoption.md`](spec/client/adoption.md), `packages/client`                        | Adoption, surgical deltas, resident templates over Warp                         |
| Signal graph              | [`spec/client/signals.md`](spec/client/signals.md)                                             | Linked edges, bitflag status, push-pull with a lazy check                       |
| Navigation                | [`spec/client/navigation.md`](spec/client/navigation.md)                                       | Staged routes, and the floor where staging loses                                |
| Routing, streaming        | [`spec/kernel/routing.md`](spec/kernel/routing.md), [`streaming.md`](spec/kernel/streaming.md) | A URL matches a plan; slots stream in order or fastest-first                    |
| Request lifecycle         | [`spec/kernel/lifecycle.md`](spec/kernel/lifecycle.md)                                         | A state machine, two-phase envelope, 103 Early Hints, deferral                  |
| Ports                     | [`spec/kernel/ports.md`](spec/kernel/ports.md), `packages/adapters`                            | Fourteen declared, fourteen implemented                                         |
| Cache keys, static docs   | [`spec/kernel/cache.md`](spec/kernel/cache.md), [`static.md`](spec/kernel/static.md)           | Reads resolved into a key; a page that reads nothing is a file                  |
| Executors, waves, epochs  | [`spec/kernel/locus.md`](spec/kernel/locus.md)                                                 | DAG scheduling, CPU budgets, staged epochs with atomic commit                   |
| Surgical updates          | [`spec/kernel/surgical.md`](spec/kernel/surgical.md)                                           | `HELD` recovers a base, delta and patch memoized by their transition            |
| Authority                 | [`spec/kernel/authority.md`](spec/kernel/authority.md)                                         | Capabilities by role, Ed25519 intents single-use per deployment, limits         |
| Composition               | [`spec/kernel/composition.md`](spec/kernel/composition.md)                                     | Regions through a registry, contracts checked on arrival, the tree as one graph |
| Byte budgets              | [`spec/kernel/budgets.md`](spec/kernel/budgets.md)                                             | Every entry, its ceiling, and every watermark that moved                        |
| The plan layer            | [`spec/plan/plan.md`](spec/plan/plan.md), [`profile.md`](spec/plan/profile.md)                 | Plan DSL, validation against inferred effects, plugins, `weft why`              |
| Device and engine reality | [`spec/baseline/devices.md`](spec/baseline/devices.md)                                         | Written before the numbers                                                      |

Three things, three jobs. `spec/` is the reference: the mechanism, its refusals, and what each one
deliberately does not do. `packages/inspector` is the live version — a station per capability, each
with a control, and a test that fails when a spec document has no station. `packages/docs` is the
introduction: Quick Start, a 21-page Guide, Tutorial, Examples, API, Glossary, an Error Reference, a
playground and a search page.

**The documentation site is itself a weft application**, which is the strongest claim the framework
can make about itself and the reason it is built that way rather than with a documentation
generator. It is 14 routes and 27 sealed templates; `weft build` writes the whole thing as 370
files, so the kernel is not invoked to serve any of them. Its guide pages and its 300-odd error
pages are two param routes with their sets declared. Three of its sections sit under a nested
layout. Its one mutation — the "useful" button on the intents page — is a real intent in
`app/intents/`, dispatched by a form post. And the two pages that are _not_ files — the playground,
which compiles what you type through the compiler's virtual file set, and search, which is a
function of `?q` — say so with `static: false` and a reason each.

Most of it is generated from the source rather than written beside it, so it cannot drift: the API
reference walks every package's public entry and lists every export; the error reference walks every
`src/` and lists every named refusal with the message it raises; the CLI page is the `--help` text,
parsed; the byte-budget table is `packages/bench/src/budget.ts`, parsed; the wire-format versions are
the constants a build stamps on a document; and the three wire-form sizes on the live-regions page
are measured on that page's own example when it renders. Each has a test that checks the same source
independently and fails when something is missing.

**The guide covers the framework, and that is a gate too.** Every page names the spec documents it
introduces, and the test checks both directions — a name that does not exist fails, and a spec
document no page introduces fails. There is no exemption list, so shipping a mechanism means writing
the paragraph a reader can find in the same change.

**Both references are complete, and both completions are gates rather than claims.** All 1,367
importable names carry a doc comment on their declaration, and a test fails if one does not. All 326
named refusals either carry a sentence of their own or forward the failure underneath them, and a
test fails if any of them says nothing but its own name. The API page published "384 of 1,367" when
it first shipped; printing the shortfall is what made it worth closing.

Generating a figure also catches the hand-written copy of it. The version table on the site is read
from the constants; `spec/VERSIONING.md` said warp was `1.7.0` while `packages/warp/src/version.ts`
said `1.8.0`. The spec is corrected and a test now asserts the two agree.

```sh
pnpm docs:dev     # serve it
pnpm docs:build   # build it, and read which pages became files
```

---

## What has to be true next

One item, and it is not code.

1. **The three things that need a real device.** Whether incremental declarative-shadow-DOM parsing
   works on a given iOS version; what a host app's request interception does to first-byte timing;
   and how often a backgrounded webview is evicted, and therefore what `RESUME` recovers in
   practice. The harness half of this is built — `--devices` drives Android over CDP and iOS over
   W3C WebDriver, and `weft-bench devices` says whether the driver answers — so what is missing is
   hardware and not code. `--engines ios` keeps refusing by name until a device is configured,
   because webkit is a desktop proxy with nothing honest to fall back to.

Everything else that was ever on this list has closed. The finer-grained ledgers — each spec
document's own "what this does not do" section — hold what remains at that level, and what is there
now is decisions rather than work: `permessage-deflate` refused because Warp bodies are already
compressed, backpressure as a close rather than a queue, no delegation over HTTP, no
`stale-if-error` on the wire, no per-request CPU accounting on the request thread, chunk packing and
V8 compile hints refused for the shape of this framework, and partial-chain navigation refused after
measuring what it would save. Each one names its argument.
