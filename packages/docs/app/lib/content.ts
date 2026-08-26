import { renderExample } from './example.ts'
import { example, heading, note, prose, sketch, table } from './markup.ts'
import { BY_SLUG, GROUPS, neighbours, PAGES } from './pages.ts'

/**
 * The prose, per page.
 *
 * One module rather than one file per page, because a guide is a sequence and a sequence is easier
 * to keep in order when it is in order. The route files are three lines each and exist for the
 * reason every route file here exists: the file is what puts the page on a URL.
 *
 * Every `example()` call renders a fragment this application compiled. Nothing on this site is a
 * pasted snippet, which is the property `test/docs.test.ts` enforces by rendering all of them.
 */
type Body = () => string

function nth(slug: string, index: number): string {
  const found = BY_SLUG[slug]?.examples[index]
  if (!found) throw new Error(`E_NO_EXAMPLE: ${slug} has no example at ${index}`)
  return example(renderExample(found))
}

const BODIES: Record<string, Body> = {
  'getting-started': () =>
    prose(
      'A weft application is a folder. There is no configuration you must have, no wiring file, and no ' +
        'bundler — the route table is the file tree and the plan that places everything on a page is ' +
        'generated from it.',
    ) +
    sketch(
      'sh',
      `npm create weft my-app
cd my-app
weft dev`,
    ) +
    prose('That leaves you with three files that matter:') +
    table(
      ['File', 'What it is'],
      [
        [
          '<code>app/layout.tsx</code>',
          'The document. Its <code>&lt;slot&gt;</code> holes are what a route fills.',
        ],
        [
          '<code>app/routes/index.tsx</code>',
          'The page at <code>/</code>. A <code>.tsx</code> is a fragment.',
        ],
        [
          '<code>app/routes/index.data.ts</code>',
          'What that route declares: its head, cache policy, loader, guard and slots. Optional.',
        ],
      ],
    ) +
    heading('A fragment is the unit', 'a-fragment') +
    prose(
      'Everything this framework renders is a fragment, and a fragment compiles to a <em>sealed ' +
        'template</em>: pre-encoded UTF-8 segments with holes between them, and a version that is a hash ' +
        'of its own content. Rendering is writing those bytes and filling the holes.',
    ) +
    nth('getting-started', 0) +
    note(
      'why',
      'Why this example is not a snippet',
      'It is a file in this application, compiled by the build that served you this page. If it did not ' +
        'compile, this page would not exist — <code>weft build</code> would have failed. The source above ' +
        'is the bytes that produced the template the output came from, carried by the build rather than ' +
        're-read from a path that may have changed since.',
    ) +
    heading('Then what?', 'next') +
    prose(
      'The next page is the file convention in full. If you would rather see a mechanism than read about ' +
        'it, <code>pnpm inspect</code> opens the inspector — a page per capability, each with a control.',
    ),

  'an-application': () =>
    prose(
      'A convention is only worth having if it is the single source of the route table, so nothing ' +
        'downstream of the file tree may add a route. A page that is not in <code>app/routes/</code> does ' +
        'not exist.',
    ) +
    sketch(
      'text',
      `app/
  layout.tsx              the document. Its <slot> holes are what a route fills
  routes/index.tsx        /
  routes/about.tsx        /about
  routes/blog/[slug].tsx  /blog/:slug
  routes/docs/[...].tsx   /docs/*
  routes/docs/layout.tsx  wraps every route at or under /docs
  routes/x.data.ts        x.tsx's head, cache policy, loader, guard and slots
  routes/x.css            linked only by the pages that render x
  layouts/<name>.tsx      an alternate document, chosen with defineRoute({ layout })
  slots/<name>.tsx        fills the layout hole of that name on every route
  fragments/<name>.tsx    a component, referenced by name from a route's slots
  intents/**.ts           mutations. The manifest is generated from this directory
  renderables/**.ts       fragments a client may ask for by opaque id
  styles.css              appended after the framework's own
weft.config.ts            what this deployment binds`,
    ) +
    heading('Two files, one route', 'two-files') +
    prose(
      'A route is a <code>.tsx</code>, or a <code>.data.ts</code> that says what renders its body, or ' +
        'both. A page whose content is markup rather than a template needs no template file, and ' +
        'requiring an empty one would be ceremony rather than convention.',
      'The <code>.data.ts</code> is where placement lives — which fragment fills which hole, what streams, ' +
        'what is cached and for how long. It is read at build time, so what it says becomes part of the ' +
        'generated plan rather than a branch taken per request.',
    ) +
    heading('Specificity decides, never file order', 'specificity') +
    prose(
      'Static beats a param, a param beats a wildcard, segment by segment. <code>/product/new</code> wins ' +
        'over <code>/product/:sku</code> whether or not anybody remembered to write them in the right ' +
        'sequence — a table whose behaviour depends on the order somebody happened to write it in is a ' +
        'table nobody can safely refactor.',
    ) +
    note(
      'careful',
      'Two files cannot be one route',
      'A path that two files both mean is <code>E_DUPLICATE_ROUTE</code>, and a <code>[...]</code> segment ' +
        'that is not last is <code>E_WILDCARD_NOT_LAST</code>. Both are build errors, named, before ' +
        'anything is served.',
    ) +
    heading('See what it produced', 'weft-routes') +
    prose('Two commands answer "what did the convention decide", and neither needs a running server:') +
    sketch(
      'sh',
      `weft routes          # the route table, and each route's slots
weft why /blog/:slug # the generated plan for one route, as JSON`,
    ),

  fragments: () =>
    prose(
      'A fragment compiles to a sealed template. What that means concretely: the constant parts are ' +
        'pre-encoded <code>Uint8Array</code> segments, the variable parts are holes, and the whole thing ' +
        'has a version that is a hash of its content. Rendering copies the segments and encodes the hole ' +
        'values straight into the output buffer.',
      'Two consequences are worth having in mind from the start. A template is <em>data</em>, so it can be ' +
        'sent to a client and kept; and a version is a content address, so two renders of the same ' +
        'template with the same values are the same bytes by construction.',
    ) +
    heading('Escaping is decided by the type', 'escaping') +
    prose(
      'Escaping a value that cannot contain markup is work that produces the same bytes. So the compiler ' +
        'asks the type checker what each hole holds, and a hole whose type makes escaping a no-op is ' +
        'lowered as <code>proven-safe</code>: no escape call at all.',
    ) +
    nth('fragments', 0) +
    heading('A list is one template, projected', 'lists') +
    prose(
      'A <code>.map()</code> over an array lowers to a <em>list hole</em> whose rows come from one nested ' +
        'sealed template. Fifty rows is fifty value sets and two templates — which is why page weight ' +
        'tracks content rather than markup, and why a delta over a list can address the rows that changed.',
    ) +
    nth('fragments', 1) +
    heading('What the subset refuses', 'subset') +
    prose(
      'The compiler accepts a deliberate subset of TSX, and what it refuses it refuses by name. The ' +
        'reason is not purity: a template has to be <em>data</em> for a client to hold it, and an ' +
        'expression the compiler cannot lower is an expression that would have to become code on the wire.',
    ) +
    table(
      ['Refusal', 'What it means'],
      [
        [
          '<code>E_EXPRESSION_UNSUPPORTED</code>',
          'An expression with no lowering — a template literal in an attribute, for instance. Move the value into a prop.',
        ],
        [
          '<code>E_UNTRACKED_EFFECT</code>',
          'A read the compiler cannot name, so it cannot become part of a cache key. The message names what to use instead.',
        ],
        [
          '<code>E_COMPONENT_NOT_SINGLE_ROOT</code>',
          'A composed fragment with more than one root element. An instance is one hole, so it is one node.',
        ],
      ],
    ) +
    prose('The full list, with the argument for each, is in <code>spec/compiler/supported-subset.md</code>.'),

  components: () =>
    prose(
      'A capitalised tag is resolved at build time to another fragment’s sealed template. Nothing is ' +
        'mounted, no function runs at render time, and the instance is a <em>projection</em> of the ' +
        'caller’s values into the child’s holes.',
    ) +
    nth('components', 0) +
    heading('Why a projection rather than a call', 'projection') +
    prose(
      'Because a projection stays addressable. A component that ran as a function would produce markup ' +
        'nobody could later describe; a component hole leaves the parent able to say "this hole’s value ' +
        'changed", which is what lets a delta cross a component boundary with no path syntax to invent.',
      'It is also what makes the cost model legible: one <code>Card</code> used a hundred times is one ' +
        'sealed template and a hundred value sets, not a hundred component instances.',
    ) +
    heading('Containment', 'containment') +
    prose(
      'A fragment that reads identity would normally make its caller private. When the child is private ' +
        'and the parent is not, the compiler <em>isolates</em> the instance instead: the parent leaves a ' +
        'boundary and the kernel fills it, exactly as it does for a slot. So one private card does not ' +
        'make a whole shared page private.',
    ) +
    note(
      'refused',
      'The one place isolation does not follow',
      'Inside a list row, or inside the children another call site wrote, there is nowhere to cut the ' +
        'byte stream — so a private fragment there is <code>E_PRIVATE_COMPONENT_NESTED</code>, naming both ' +
        'the child and the container. The fix the message gives is to move the read above the list and ' +
        'pass it in as a prop.',
    ),

  'effects-and-cache': () =>
    prose(
      'Nothing about cacheability is declared here. The compiler records what each fragment read, and the ' +
        'cache key, the class and the <code>Vary</code> header are all derived from that set. A cache ' +
        'class that can be asserted can be asserted wrongly, and the failure is one reader’s bytes in ' +
        'another reader’s cache.',
    ) +
    nth('effects-and-cache', 0) +
    heading('The classes, and what forces them', 'classes') +
    table(
      ['Reads', 'Class', 'What follows'],
      [
        [
          'nothing',
          '<code>static</code>',
          'The key is the content address. It can be resolved at build time and served as a file.',
        ],
        [
          'a cookie, a header, a locale, a flag',
          '<code>shared</code>',
          'Keyed by value, and the response says <code>Vary</code> so a CDN cannot serve it to everyone.',
        ],
        ['<code>identity</code>', '<code>private</code>', 'Never shared, never a CDN entry.'],
        [
          '<code>time</code>',
          'forces a TTL',
          'A policy with no TTL would never expire, so declaring one is a build error.',
        ],
      ],
    ) +
    nth('effects-and-cache', 1) +
    heading('The plan is checked against the compiler, never the reverse', 'checked') +
    prose(
      'A route may declare a cache policy. It cannot declare one that contradicts what its fragments ' +
        "read: <code>.cache('public')</code> on a fragment that reads identity fails the build, naming " +
        '<code>identity</code> as the read that caused it. That is the strongest promise in the design and ' +
        'it is a build error rather than a runtime check.',
    ) +
    sketch(
      'ts',
      `export default defineRoute({
  // Refused: the fragment filling this slot reads identity.
  cache: { class: 'public', ttl: '1h' },
  slots: { body: { fragment: 'cart' } },
})`,
    ),

  'slots-and-streaming': () =>
    prose(
      'A slot is a hole in the document that the render does not own. The point is not layout: it is that ' +
        'the bytes before a slot can be on the wire before anything is known about what fills it.',
      'That falls out of the effect graph rather than being asked for. A fragment that reads something slow ' +
        'is a fragment whose bytes cannot be part of the shell, so it becomes a hole — which is why the ' +
        'first byte of a page is never downstream of its slowest query.',
    ) +
    heading('Two orders', 'orders') +
    table(
      ['Order', 'What happens', 'Cost'],
      [
        [
          '<code>in-order</code>',
          'Each slot streams where it sits in the document. A slow slot holds back everything after it.',
          'No JavaScript at all.',
        ],
        [
          '<code>out-of-order</code>',
          'The whole document goes out with an anchor comment per slot; whichever slot resolves first fills first.',
          'One inline fill script, about 330 bytes.',
        ],
      ],
    ) +
    prose(
      'Which one a route uses is <em>derived</em>: a plan where no slot asked to stream lowers to ' +
        '<code>in-order</code>, so a page of uniformly fast regions never puts the filler on the wire. ' +
        'Asking a slot to stream is what turns the page out-of-order.',
    ) +
    sketch(
      'ts',
      `export default defineRoute({
  slots: {
    panel: { html: '' },                          // buffered: nothing asked to stream
    feed: { fragment: 'feed', stream: { prio: 1 }, load: slowQuery },
    recs: { fragment: 'recs', stream: { prio: 2 }, load: slowerQuery },
  },
})`,
    ) +
    heading('Waves, not a list', 'waves') +
    prose(
      'Slots run concurrently under a per-request ceiling. A slot that declares <code>needs</code> on ' +
        'another one is scheduled in a later wave, so a data dependency is a fact the scheduler reads ' +
        'rather than an ordering somebody maintained by hand.',
    ) +
    note(
      'careful',
      'A budget is a limit only where something can be preempted',
      'A CPU budget on the <code>inline</code> executor is advisory and says so — several renders and the ' +
        'stream interleave on one thread, so a number measured around one of them measures all of them. On ' +
        'a worker pool it is spent in CPU and enforced. The refusal to report a plausible number is the ' +
        'point.',
    ),

  layouts: () =>
    prose(
      'A route names one document, and its <code>&lt;slot&gt;</code> holes are the boundaries the route ' +
        'fills. <code>app/layout.tsx</code> is that document by default; ' +
        "<code>defineRoute({ layout: 'dash' })</code> picks <code>app/layouts/dash.tsx</code> instead, " +
        'which is how a page with a different shape gets different holes.',
    ) +
    heading('A document may be a chain', 'chain') +
    prose(
      'A <code>layout.tsx</code> inside <code>app/routes/</code> wraps every route at or under its ' +
        'directory, nested inside the application’s own document. This page is served by one: the site’s ' +
        'document is <code>app/layout.tsx</code>, and everything under <code>/guide</code> is wrapped in ' +
        '<code>app/routes/guide/layout.tsx</code>, which is where the contents column beside you comes from.',
      'The chain is not compiled into one template. Every layer stays separately sealed and separately ' +
        'versioned, and the cuts each one leaves are spliced together when the document streams. So a slow ' +
        'region inside a nested layout streams exactly as one in the outer document does, with its own ' +
        'cache policy and its own budget.',
    ) +
    sketch(
      'text',
      `app/layout.tsx                 <slot name="body">
app/routes/guide/layout.tsx    fills body, leaves contents / body / outline
app/routes/guide/layouts.data.ts   fills contents, body, outline`,
    ) +
    prose(
      'The plan for this page has three slots, and nothing in its declaration says which layer left which ' +
        'hole. <code>weft why /guide/layouts</code> prints it.',
    ) +
    note(
      'careful',
      'Hole names have to differ across a chain',
      'A plan keys its slots by name and the client addresses a region by name, so two layers both leaving ' +
        '<code>aside</code> would be one region with two places to be: ' +
        '<code>E_DUPLICATE_LAYOUT_HOLE</code>, with both files named. The exception is ' +
        '<code>body</code>, which every layer but the innermost uses to hold the next one — that hole never ' +
        'reaches the plan as a slot at all.',
    ) +
    heading('The chain is one document', 'one-document') +
    prose(
      'Its reads are the union of what every layer reads, so a nested layout that reads a cookie makes the ' +
        'whole page vary on it. Its identity is the layers in order, so two routes are the same document — ' +
        'swappable by a staged navigation, sharing regions — only when they were built from the same files ' +
        'in the same order.',
    ),

  declarations: () =>
    prose(
      'A route’s <code>.data.ts</code> is the one place placement lives. It is read at build time and ' +
        'becomes part of the generated plan, so what it says is a fact about the application rather than a ' +
        'branch taken per request.',
    ) +
    sketch(
      'ts',
      `import { defineRoute } from 'weft'

export default defineRoute({
  head: { title: 'Cart' },
  layoutValues: { heading: 'Your cart' },
  cache: { class: 'private' },
  slots: {
    panel: { html: '' },
    body: { fragment: 'cart', live: true, load: loadCart },
    readout: { fragment: 'markup', html: summary },
  },
})`,
    ) +
    heading('What a slot may declare', 'slot-fields') +
    table(
      ['Field', 'What it decides'],
      [
        [
          '<code>fragment</code>',
          'Which compiled fragment fills the hole. A name in <code>app/fragments/</code>.',
        ],
        ['<code>load</code>', 'The loader. Its result is the values the fragment renders with.'],
        ['<code>stream</code>', 'Whether this region arrives separately, and at what priority.'],
        ['<code>needs</code>', 'Another slot this one depends on, so the scheduler puts it in a later wave.'],
        ['<code>cache</code>', 'The class, TTL and tags for this region — checked against what it reads.'],
        ['<code>budget</code>', 'A CPU ceiling and what happens when it is exceeded.'],
        ['<code>live</code>', 'Whether this region may be refreshed over the channel.'],
        ['<code>refresh</code>', 'An interval, and the conditions under which it applies.'],
        [
          '<code>placeholder</code>',
          'The bytes sent when the region degrades. Honest, cheap, visibly incomplete.',
        ],
      ],
    ) +
    heading('Every declaration is validated', 'validated') +
    prose(
      'A declaration naming a hole the document does not leave is <code>E_SLOT_NOT_IN_SHELL</code>, listing ' +
        'the holes it does leave. A hole nothing fills is <code>E_SHELL_HOLE_UNFILLED</code>. An executor ' +
        'that is not bound is <code>E_UNKNOWN_EXECUTOR</code>. The pattern is the same throughout: the ' +
        'declaration and the derivation are both written down, so a disagreement is a build error rather ' +
        'than an empty region in production.',
    ) +
    heading('And a plan can come from a measurement', 'profile') +
    prose(
      '<code>weft dev --profile</code> records what every render costs — per route and per slot, renders ' +
        'separately from cache hits — and the next build plans <em>delivery</em> from it. Placement, cache ' +
        'classes and keys are untouched: a recording of last Tuesday has no standing over what the compiler ' +
        'inferred.',
    ),

  'the-client': () =>
    prose(
      'There is no hydration step. The server-rendered DOM is the DOM, and what the client does on arrival ' +
        'is <em>adopt</em> it: walk the wiring the compiler emitted and attach one binding per node that ' +
        'reads a value. No component code runs, so the cost is the number of bindings rather than the ' +
        'number of components.',
    ) +
    nth('the-client', 0) +
    heading('Signals, and values derived from them', 'signals') +
    prose(
      'A signal is client-owned state. The server renders it at its initial value, and from adoption ' +
        'onwards the browser owns it. A value computed from a signal is a <em>derived</em> value, and the ' +
        'expression travels on the wire as a tree the client evaluates — which is what lets a page ' +
        'recompute it without shipping the component that wrote it.',
      'The graph is pull-based with linked edges: setting a signal marks its readers stale and nothing ' +
        'recomputes until it is read. So a value nobody is looking at costs nothing when its input changes.',
    ) +
    heading('What the page actually downloads', 'bytes') +
    prose(
      'Entries, not a bundle. A page that only adopts and binds imports the adoption path and nothing else; ' +
        'deltas, epochs, the channel, navigation and discovery are each a further entry, and a page that ' +
        'links nowhere does not carry the staging model. Every one has a ceiling and a test that fails when ' +
        'it is crossed.',
    ) +
    note(
      'careful',
      'The honest number is bigger than the budget table',
      'Those ceilings are measured bundled and minified, and this framework has no bundler: a page fetches ' +
        'the boot module and each module it imports as its own response, served as written with types ' +
        'stripped. Walked and compressed the way it actually arrives, the demo’s client is about 3.5× the ' +
        'bundled figure. Both numbers are published, and which one is which is stated — see ' +
        '<code>spec/FINDINGS.md</code>.',
    ),

  intents: () =>
    prose(
      'A render cannot write. That is enforced by the type of the context a render receives, not by a ' +
        'convention — so every mutation is an <em>intent</em>, and intents are the only thing in this ' +
        'framework allowed to change anything.',
    ) +
    sketch(
      'ts',
      `// app/intents/cart.ts
import { intent } from 'weft'

export const add = intent({
  writes: ['cart'],                       // the complete set this may invalidate
  params: { sku: 'string', qty: 'number' },
  async run(ctx, { sku, qty }) {
    await db.cart.add(ctx.session, sku, qty)
    ctx.revalidate('cart')                // undeclared tags throw
  },
})`,
    ) +
    heading('Two rules', 'rules') +
    prose(
      '<strong>A write is declared, and an undeclared one throws.</strong> ' +
        "<code>ctx.revalidate('orders')</code> from an intent that did not declare <code>orders</code> is " +
        '<code>E_UNDECLARED_WRITE</code>, naming the tag and the field to add it to. Unlike the plugin read ' +
        'guard this is not dev-only: an undeclared read is a missed optimisation, and an undeclared write is ' +
        'a cache invalidation nobody can predict by reading the code.',
      '<strong>The client never names server code.</strong> An intent is addressed by an opaque id derived ' +
        'from its module and export, so renaming the function does not change the wire and the wire does not ' +
        'disclose a function name.',
    ) +
    heading('The same intent, three ways in', 'three-ways') +
    table(
      ['Caller', 'What happens'],
      [
        [
          'A form post, no JavaScript',
          'Dispatched in phase A, so a real status, an <code>HttpOnly</code> cookie and a 303 are all available.',
        ],
        [
          '<code>fetch</code>',
          'The same dispatch, outcome as JSON, chosen by <code>Accept</code> rather than a second endpoint.',
        ],
        [
          'Over the channel',
          'The client stages its guess in an epoch; success replaces it with the truth in one paint, failure discards it.',
        ],
      ],
    ) +
    note(
      'refused',
      'A GET cannot carry a mutation',
      '<code>createIntentRouter</code> refuses to be built from one. A GET that writes is the oldest bug on ' +
        'the web and it is not reachable by accident here.',
    ) +
    heading('Who may run one', 'authority') +
    prose(
      'An intent may declare capabilities, and an intent declaring one with nothing bound to check it is ' +
        'refused rather than allowed — <code>E_NO_CAPABILITY_CHECK</code>. A signed intent carries a token ' +
        'this deployment issued, and a token may be narrowed once into a leaf that authorises less. Minting ' +
        'is uncacheable by construction, which is why a signed intent has no no-JavaScript path.',
    ),

  'live-regions': () =>
    prose(
      'A region marked <code>live</code> can be refreshed over a channel without the page navigating. What ' +
        'arrives is chosen from a ladder of wire forms, and the interesting rung is the smallest one.',
    ) +
    heading('The forms, and how one is chosen', 'forms') +
    table(
      ['Form', 'What it carries', 'What it needs'],
      [
        ['<code>html</code>', 'The region’s markup.', 'Nothing. Always available.'],
        ['<code>patch</code>', 'The markup of the holes that changed.', 'Nothing resident.'],
        [
          '<code>delta</code>',
          'The changed values only.',
          'The client holds the template and names the base render it has.',
        ],
      ],
    ) +
    prose(
      'The negotiation is not a preference: every form of a fragment must produce identical bytes, and the ' +
        'benchmark harness refuses to publish a number until it has checked that they do.',
    ) +
    heading('Why a delta is cheap for the server too', 'shared-delta') +
    prose(
      'Because the client names the base render it holds, a delta is a pure function of two ' +
        'content-addressed states — so it is memoised by the transition it encodes. One computation serves ' +
        'every client making the same transition, where a diff kept per connection produces one diff per ' +
        'connection. That is architectural rather than a tuning choice, and it is the claim the harness’s ' +
        '<code>deltas</code> command exists to measure.',
    ) +
    heading('Epochs', 'epochs') +
    prose(
      'An optimistic update is staged into an <em>epoch</em> and committed atomically: every region in it ' +
        'flips at once. Rollback is discarding the epoch — nothing was painted, so there is nothing to ' +
        'un-paint and no prior state to reconstruct.',
    ) +
    note(
      'careful',
      'Backpressure is a close, not a queue',
      'A channel that stays saturated for 32 consecutive sends is closed with <code>E_SLOW_CONSUMER</code>. ' +
        'Frames held for a peer that is not reading are memory nobody can reclaim, and every one of them is ' +
        'stale by the time it would arrive — so the client reconnects and says what it holds.',
    ),

  deploying: () =>
    prose(
      'Everything a framework normally does for you is a <em>port</em> here: the store, the session, the ' +
        'flags, the executors, the registry, the transport. Fourteen are declared, fourteen are implemented, ' +
        'and eleven are bound by the front door with no configuration at all — so a deployment that changes ' +
        'nothing is a real deployment rather than a demo mode.',
    ) +
    sketch(
      'ts',
      `// weft.config.ts
import { defineConfig, redisLeases, workerPool } from 'weft'

export default defineConfig({
  port: 3000,
  store: redisLeases({ url: process.env.REDIS_URL }),
  executors: { 'pool:heavy': workerPool({ size: 4 }) },
  flags: { 'new-cart': ['off', 'on'] },
})`,
    ) +
    heading('Ports replace, plugins extend', 'ports-plugins') +
    prose(
      'A port has one implementation at a time and swapping it changes where something happens. A plugin ' +
        'adds to a request without replacing anything, declares what it reads and provides, and its ordering ' +
        'is <em>inferred</em> from those declarations — so a cycle or an ambiguity is a build error rather ' +
        'than a race.',
      'The one thing neither may do is write a cache key. A plugin may add an axis; nothing can set a key, ' +
        'because a key that can be written by hand is a key that can be written wrongly.',
    ) +
    heading('The build, and the tier below it', 'build') +
    sketch(
      'sh',
      `weft build     # sealed templates, the generated plan, the manifest, revved assets
weft start     # serve the build. No compiler runs
weft verify    # ask every region what it is serving, and fail on disagreement
weft upload    # PUT the build to an object store`,
    ) +
    prose(
      'A page whose every fragment reads nothing is resolved at build time and written as a file, so it is ' +
        'served without the kernel being invoked at all. A parameterised route joins that tier when its ' +
        'parameters are a set the application declared. Every page that is <em>not</em> a file is refused by ' +
        'name, with the read that caused it — because a tier nobody can see is a tier nobody uses.',
    ) +
    note(
      'why',
      'Why every URL is immutable for a year',
      'Every asset the browser fetches carries a digest of its own contents. <code>weft dev</code> serves ' +
        'the same bytes at stable names with <code>no-store</code>, because a stylesheet you just edited ' +
        'served as immutable is a framework that lies to you for a year.',
    ),
}

/** The page's own prose and examples, rendered. */
export function bodyOf(slug: string): string {
  const body = BODIES[slug]
  if (!body) throw new Error(`E_DOCS_NO_BODY: no content written for '${slug}'`)
  const { previous, next } = neighbours(slug)
  const links = [
    previous ? `<a class="prev" href="/guide/${previous.slug}">← ${previous.title}</a>` : '',
    next ? `<a class="next" href="/guide/${next.slug}">${next.title} →</a>` : '',
  ]
    .filter(Boolean)
    .join('')
  return `${body()}<nav class="sequence">${links}</nav>`
}

/** Which slugs have prose. Read by the test, so a page in the registry cannot be an empty box. */
export function written(): string[] {
  return Object.keys(BODIES)
}

/** How many examples the guide renders in total, for the landing page's own claim about itself. */
export function exampleCount(): number {
  return PAGES.reduce((sum, page) => sum + page.examples.length, 0)
}

/** The contents column, identical on every page under the guide layout — so it is one cache entry. */
export function guideContents(current?: string): string {
  const groups = GROUPS.map((group) => {
    const pages = PAGES.filter((page) => page.group === group.id)
    if (!pages.length) return ''
    return `<h2 class="hint">${group.label}</h2><ul class="contents">${pages
      .map(
        (page) =>
          `<li>${
            page.slug === current
              ? `<strong>${page.title}</strong>`
              : `<a href="/guide/${page.slug}">${page.title}</a>`
          }</li>`,
      )
      .join('')}</ul>`
  })
  return groups.join('')
}

/** What the page covers, and where the argument for it lives. */
export function guideOutline(slug: string): string {
  const page = BY_SLUG[slug]
  if (!page) return ''
  const specs = page.covers.length
    ? `<h2 class="hint">Specified in</h2><ul class="contents">${page.covers
        .map(
          (doc) =>
            `<li><a href="https://github.com/raminjafary/weft/blob/main/spec/${doc}"><code>spec/${doc}</code></a></li>`,
        )
        .join('')}</ul>`
    : ''
  const examples = page.examples.length
    ? `<h2 class="hint">Live on this page</h2><ul class="contents">${page.examples
        .map((ex) => `<li><code>${ex.id}</code></li>`)
        .join('')}</ul>`
    : ''
  return `${specs}${examples}<p class="hint">The guide explains. <a href="https://github.com/raminjafary/weft/tree/main/spec"><code>spec/</code></a> is the reference, with every refusal. <code>pnpm inspect</code> is the live version, with a control.</p>`
}
