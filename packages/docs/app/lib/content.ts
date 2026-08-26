import { renderExample } from './example.ts'
import { escapeHtml, example, heading, note, prose, sketch, table } from './markup.ts'
import { BY_SLUG, neighbours, PAGES } from './pages.ts'
import { commands, options, tagline } from './cli.ts'
import { budgets, siteWeight } from './budgets.ts'
import { artifacts } from './versions.ts'
import { wireTable } from './wire.ts'
import { intentId } from '@weft/compiler'

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
    heading('A param is data, and so is a wildcard', 'params') +
    prose(
      'A <code>[slug]</code> segment is a parameter and a <code>[...]</code> segment is the rest of the ' +
        'path. Both arrive as values, which means what a route renders from them is an ordinary list hole ' +
        'rather than a component that walks something at runtime:',
    ) +
    nth('an-application', 0) +
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
    nth('slots-and-streaming', 0) +
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
    heading('What you do not have to declare', 'inferred') +
    prose(
      'Everything above is optional, and the useful default for most of it is silence. A route with no ' +
        '<code>cache</code> gets the class its fragments’ reads imply; a route with no <code>stream</code> ' +
        'anywhere lowers to in-order delivery and ships no filler script; a page whose fragments read ' +
        'nothing becomes a file at build time without asking.',
      'And the part that is about <em>time</em> can come from a measurement rather than from you — see ' +
        '<a href="/guide/measuring">a plan generated from measurement</a>.',
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
        'deltas, epochs, the channel, navigation, staging and discovery are each a further entry, and a page ' +
        'that links nowhere does not carry the staging model. Every one has a ceiling and a test that fails ' +
        'when it is crossed.',
      'The ceilings, the entries they cover, and the number that is bigger than all of them are on ' +
        '<a href="/guide/what-ships">what the page downloads</a>.',
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
import { defineIntent } from 'weft'

export const add = defineIntent<{ sku: string; qty: number }>({
  name: 'cart.add',                       // for logs and \`weft why\`. Never on the wire
  writes: ['cart'],                       // the complete set this may invalidate
  input: (raw) => parse(raw),             // throwing here is a 422, not a 500
  async run(ctx, { sku, qty }) {
    await db.cart.add(ctx.session, sku, qty)
    await ctx.revalidate('cart')          // an undeclared tag throws
  },
})`,
    ) +
    nth('intents', 0) +
    prose(
      'That form is not an illustration: <code>app/intents/feedback.ts</code> is a real module in this ' +
        'application, so the manifest generated from it has a route and pressing the button dispatches the ' +
        `intent. Its id is <code>${intentId('app/intents/feedback.ts', 'helpful')}</code> — the first six ` +
        'characters of a hash of the module path and the export name, which is what the client would carry ' +
        'if this page had any JavaScript. The tally is in this process’s memory, because a documentation ' +
        'site has no reason to bind a store.',
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
    nth('live-regions', 0) +
    heading('The same change, in three forms', 'measured') +
    prose(
      'One price rose by two. Here is what each form costs for that change, measured on the render above ' +
        'rather than quoted from a benchmark:',
    ) +
    wireTable() +
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

  'where-it-runs': () =>
    prose(
      'Three mechanisms that look unrelated and are not. Where a render runs, what it may spend, and ' +
        'when it is allowed to paint are all consequences of one property: a render cannot write, so ' +
        'nothing in it depends on anything else having finished.',
    ) +
    heading('A render is a DAG, not a tree walk', 'dag') +
    prose(
      'Every server renderer in production walks depth-first from root to leaf on one thread, and the ' +
        'conflation at the heart of that is treating <em>existence</em> dependency as <em>data</em> ' +
        'dependency. A child usually cannot start because its parent decides whether it exists — not ' +
        'because it needs the parent’s result.',
      'In a plan, <code>needs</code> is data dependency and nothing else. Everything without it is ' +
        'dispatched immediately, so a page of six independent regions is six concurrent renders rather ' +
        'than one walk that visits them in file order.',
    ) +
    sketch(
      'ts',
      `slots: {
  nav:   { fragment: 'nav' },                       // wave 1
  feed:  { fragment: 'feed', load: items },         // wave 1 — no needs, so no waiting
  recs:  { fragment: 'recs', needs: ['feed'] },     // wave 2 — it reads what feed loaded
}`,
    ) +
    heading('An executor is a crash domain', 'executors') +
    prose(
      'Where a fragment runs is a plan decision, not something the fragment knows. The default is ' +
        '<code>inline</code>: the same thread, no boundary, no serialisation. <code>pool:</code> is a ' +
        'worker pool, and the reason to choose one is rarely speed — it is that a fragment which can ' +
        'take down a process should not be able to take down <em>this</em> process.',
    ) +
    table(
      ['Executor', 'Where it runs', 'What a failure costs'],
      [
        ['<code>inline</code>', 'This thread.', 'The request. A crash is the whole render.'],
        [
          '<code>pool:&lt;name&gt;</code>',
          'A worker in that pool.',
          'One region. The page degrades to its placeholder.',
        ],
        [
          '<code>binding:</code> / <code>svc:</code>',
          'Another deployment.',
          'One region, and the boundary is a network hop — see <a href="/guide/composition">composition</a>.',
        ],
      ],
    ) +
    heading('A budget is a limit only where something can be preempted', 'budgets') +
    prose(
      'A slot may declare a CPU ceiling and what happens when it is passed. On a worker pool that is ' +
        'real: the work is spent in one place, measured, and stopped. On <code>inline</code> it is ' +
        '<em>advisory</em> and the framework says so, because several renders and the stream interleave ' +
        'on one thread — a number measured around one of them is a number that measured all of them.',
    ) +
    prose(
      'What a region sends when it is out of budget is declared beside the budget, and it is the cheapest ' +
        'template there is:',
    ) +
    nth('where-it-runs', 0) +
    sketch(
      'ts',
      `slots: {
  recs: {
    fragment: 'recs',
    executor: 'pool:heavy',
    budget: { cpuMs: 40, exceed: 'placeholder' },
    placeholder: { fragment: 'placeholder' },
  },
}`,
    ) +
    note(
      'why',
      'Why the advisory case is not just enforced anyway',
      'Because a number that cannot be right is worse than no number: an operator who sees ' +
        '<code>cpuMs: 40</code> respected on one executor and approximated on another has a dashboard ' +
        'that disagrees with itself. <code>W_CPU_BUDGET_ADVISORY</code> is a warning at build time ' +
        'naming the slot, so the choice to leave it inline is a choice somebody made.',
    ) +
    heading('And when it may paint', 'paint') +
    prose(
      'The third consequence: because a render is read-only, the client can hold a fully resolved region ' +
        'and not show it. That is what an epoch is, and it is what <a href="/guide/navigation">instant ' +
        'navigation</a> is built out of.',
    ),

  measuring: () =>
    prose(
      'The convention generates a plan from the file tree. What the file tree cannot say is what any of it ' +
        '<em>costs</em> — and delivery is a decision about cost. Whether a region should arrive separately ' +
        'depends on how long it takes, on this deployment, with this data.',
      'An author asked to guess that guesses <code>stream: true</code> on everything, which buys the ' +
        'out-of-order filler for a page whose regions all arrive together. So: record what happened, and ' +
        'let the recording decide the part of the plan that is about time.',
    ) +
    heading('Record it', 'record') +
    sketch(
      'sh',
      `weft dev --profile      # or profile: true in weft.config.ts
# .weft/profile.json is written every 30s, and again on the way out`,
    ) +
    prose(
      'What is recorded is per route and per slot, and renders are kept separately from cache hits — a ' +
        'p95 that averaged a 2 ms hit with a 300 ms render describes neither.',
    ) +
    table(
      ['Recorded', 'Why that and not a total'],
      [
        [
          'Samples, per slot',
          'Below <code>MIN_SAMPLES</code> nothing is decided. A decision from four requests is a coin toss with a log line.',
        ],
        [
          'p50 and p95, renders only',
          'The tail is what decides whether a region should arrive separately; the median hides it.',
        ],
        [
          'Hits, counted apart',
          'A region that is nearly always a cache hit does not need to stream, however slow the miss is.',
        ],
        ['Age of the recording', 'A profile from last month is reported as old rather than used quietly.'],
      ],
    ) +
    heading('What it is allowed to decide', 'scope') +
    prose(
      'Delivery, and nothing else. Placement, cache classes, keys and effect sets are the compiler’s, and a ' +
        'recording of last Tuesday has no standing over what the compiler proved. This is the boundary that ' +
        'keeps a profile from becoming a second source of truth about correctness.',
    ) +
    table(
      ['A profile may change', 'A profile may never change'],
      [
        ['Whether a slot streams', 'Which fragment fills a hole'],
        ['The priority it streams at', 'What a fragment reads, or its cache class'],
        ['Whether the page is in-order or out-of-order', 'A key, a TTL, or a <code>Vary</code> header'],
        ['Which routes are worth prefetching', 'Whether a page is static'],
      ],
    ) +
    heading('Read what it decided', 'read-it') +
    sketch(
      'sh',
      `weft profile     # what the recording decided, and what it refuses to decide
weft why /cart   # the plan for one route, and where each fact came from`,
    ) +
    prose(
      '<code>weft profile</code> prints the refusals as prominently as the decisions, which is the ' +
        'property worth having: "not enough samples for <code>recs</code>" is the useful output, and a ' +
        'tool that quietly decided anyway would be a tool you could not run twice.',
    ) +
    note(
      'careful',
      'A recording is an input, not a lock',
      'Nothing is written back into your source. The profile is read at build time; delete it and the ' +
        'build plans delivery the way it did before, from the declarations. That is what makes it safe to ' +
        'record in production and rebuild without one.',
    ),

  navigation: () =>
    prose(
      'A route fetched, parsed, and resolved, painting nothing — and a click that commits it. That is the ' +
        'whole mechanism, and almost none of it was new: an epoch is already data that has arrived and has ' +
        'not been painted, the resident store already keeps templates across visits, and the swap is the ' +
        'one a control that changes a query has always done.',
      'What was missing was the notion of a staged <em>route</em>. Regions are keyed by slot on the page ' +
        'you are on, so without that, tomorrow’s prices could be staged into today’s page.',
    ) +
    nth('navigation', 0) +
    heading('What a click costs', 'cost') +
    table(
      ['State when clicked', 'What happens'],
      [
        ['Staged and resolved', 'A commit. The DOM is swapped from data already in memory — no request.'],
        ['Staged, still arriving', 'The commit waits on the response already in flight. No second request.'],
        ['Not staged', 'An ordinary fetch, then a commit. The same path, without the head start.'],
        [
          'Staging unavailable',
          'A full navigation. The link is an anchor, so the browser does what it always did.',
        ],
      ],
    ) +
    prose(
      'The last row is the reason this is safe to turn on: every rung down from staging is a rung the ' +
        'browser already implements. There is no state to reconstruct, because a staged route that is ' +
        'never committed was never painted.',
    ) +
    heading('Two documents can only swap if they are the same document', 'same-document') +
    prose(
      'A staged route is committed into the page you are on, so the two must have been built from the same ' +
        'layout chain in the same order. When they were not, the destination is a full navigation rather ' +
        'than a swap — <code>E_NOT_THE_SAME_DOCUMENT</code> where the code asks for one explicitly.',
      'That is also what makes shared regions honest: a nav bar that is the same sealed template on both ' +
        'pages is not re-rendered, and one that is not the same template cannot pretend to be.',
    ) +
    note(
      'careful',
      'Only ever a GET',
      'Staging fetches a route ahead of a click, which means it must be safe to fetch a route somebody ' +
        'has not asked for yet. A mutation is an <a href="/guide/intents">intent</a> and intents are ' +
        'POSTs, so there is nothing here to stage wrongly.',
    ) +
    heading('What it adds to the page', 'bytes') +
    prose(
      'Its own client entry, with its own ceiling, and a page that links nowhere does not carry it — see ' +
        '<a href="/guide/what-ships">what the page downloads</a>. Prefetch policy comes from the ' +
        '<a href="/guide/measuring">profile</a> when there is one: the routes worth staging are the ones ' +
        'readers actually went to next.',
    ),

  'what-ships': () =>
    prose(
      'Entries, not a bundle. A page that only adopts and binds imports the adoption path and nothing ' +
        'else; deltas, epochs, the channel, navigation, discovery and staging are each a further entry. ' +
        'What that buys is a cost model you can read off a page’s features rather than off a build report.',
    ) +
    heading('A ceiling per entry, and why', 'per-entry') +
    prose(
      'The design stated one server-side figure — "target under 8 KB" — and the kernel it describes does ' +
        'more than one job. A single number over several jobs is a number you can satisfy by moving its ' +
        'boundary, which makes it a label rather than a gate. So every entry below is a real module a ' +
        'deployment can import on its own, and each says where its ceiling came from.',
    ) +
    (() => {
      // Escaped, and not as a formality: a `limitNote` in the source reads "<5 KB for a content
      // route", and text lifted out of a file is text until something says otherwise.
      const rows = budgets().map((budget) => [
        `<code>${escapeHtml(budget.id)}</code>`,
        escapeHtml(budget.label),
        `${(budget.limit / 1024).toFixed(0)} KB`,
        budget.stated ? 'stated in the design' : 'measured here, then fixed',
      ])
      return table(['Entry', 'Covers', 'Ceiling', 'Where the figure comes from'], rows)
    })() +
    prose(
      'Read out of <code>packages/bench/src/budget.ts</code> when this page rendered, so the ceiling here ' +
        'is the one the gate compares against. <code>pnpm bench budget</code> measures them: rolldown, ' +
        'minified, brotli at quality 11 — what ships.',
    ) +
    note(
      'careful',
      'The honest number is bigger than the table',
      (() => {
        const site = siteWeight()
        return (
          'Those ceilings are measured bundled and minified, and this framework has no bundler: a page ' +
          'fetches the boot module and each module it imports as its own response, served as written with ' +
          `types stripped. This site’s own client is <strong>${(site.brotli / 1024).toFixed(1)} KB</strong> ` +
          `brotli across ${site.modules} modules — walked and compressed the way it actually arrives. ` +
          'Both numbers are published and which is which is stated; the multiplier is in ' +
          '<code>spec/FINDINGS.md</code>.'
        )
      })(),
    ) +
    heading('How a ceiling survives a feature', 'growth') +
    prose(
      'A new capability that would push an entry past its ceiling gets its own entry instead, with its own ' +
        'figure and the sentence saying why it needed one. That is why several rows above say "no design ' +
        'figure": the design did not name them, the repository measured them and drew the line where it ' +
        'actually was. A budget that moves silently is not a budget.',
      'The application-level equivalent is <code>weft.budget.json</code>, committed, so a growth cap is a ' +
        'diff somebody reviews rather than a threshold somebody remembers.',
    ),

  composition: () =>
    prose(
      'Micro-frontend orchestration is a product category with its own runtime, its own registry and its ' +
        'own failure modes. It should not be. A shell is a fragment tree whose leaves are ' +
        '<em>regions</em>, and a region is a fragment that happens to render on another deployment.',
    ) +
    nth('composition', 0) +
    heading('Three things that already existed', 'already') +
    table(
      ['Already there', 'What it does for a region'],
      [
        [
          '<code>ExecutorPort</code>, and that it is a crash domain',
          '<code>binding:</code> and <code>svc:</code> reach another deployment; a failure there degrades one region.',
        ],
        [
          'A registry, which is a port',
          'Resolves the name <code>search</code> to whatever is serving <code>search</code> right now.',
        ],
        [
          'Warp frames, which every render already produces',
          'What comes back over the boundary is the protocol the composite already speaks downward.',
        ],
        [
          '<strong>New:</strong> the region check',
          'Frames arriving from elsewhere are somebody else’s, and a length prefix does not say whose.',
        ],
      ],
    ) +
    prose(
      'So composition is not a second runtime beside this one. It is the pieces already in the framework ' +
        'pointed at each other, plus the one check that a boundary needs and a local call does not.',
    ) +
    heading('A contract, and what happens when it breaks', 'contract') +
    prose(
      'A region declares what it composes and what it needs, and <code>weft verify</code> asks every ' +
        'registry entry what it is serving right now. A remote whose contract has moved is a build-time or ' +
        'deploy-time failure with both sides named, rather than an empty hole at 3am.',
    ) +
    sketch(
      'sh',
      `weft verify           # what this deployment's registry says about every region a route composes
weft verify --probe   # ask each remote what it is serving right now`,
    ) +
    heading('Failure is declared, not discovered', 'degradation') +
    prose(
      'Every region says what the page does without it, and the two available answers are different ' +
        'promises. <code>optional()</code> means the failure is invisible and nobody is paged — right for ' +
        'recommendations. A declared placeholder means the page says one part of it is missing — right for ' +
        'a search box. A region marked critical that cannot be served is a refusal, because a checkout ' +
        'that silently loses its payment panel is worse than a 500.',
    ) +
    note(
      'refused',
      'A region cannot reach back in',
      'A frame from another deployment names the region it is for, and one naming a region this page did ' +
        'not compose is <code>E_REGION_ESCAPE</code>. A tier boundary that trusted its far side would be a ' +
        'tier boundary in name only.',
    ),

  devices: () =>
    prose(
      'The target is every surface at once: desktop browsers, mobile browsers, embedded webviews and old ' +
        'devices. Nothing in this design fails on an old engine — every missing capability costs a wire ' +
        'form, a fill mechanism, or an animation, and never the page.',
    ) +
    table(
      ['Surface', 'Engine', 'What it costs'],
      [
        ['Chrome, Edge, Electron', 'Chromium', 'Nothing. The Chromium-only bonuses are available.'],
        ['Safari, iOS webviews', 'WebKit', 'No compression dictionaries and no speculation rules.'],
        ['Firefox', 'Gecko', 'No cross-document view transitions in stable.'],
        [
          'An old Android webview',
          'An old Chromium',
          'In-order streaming and full navigations, which is how the web worked.',
        ],
      ],
    ) +
    heading('A degradation ladder, not a feature check', 'ladder') +
    prose(
      'Every mechanism on this site has a rung below it that the browser already implements. Out-of-order ' +
        'fill needs a 330-byte inline script; without it the page streams in order. A delta needs a ' +
        'resident template; without one the region arrives as html. Navigation staging needs an epoch; ' +
        'without it a click is a navigation.',
    ) +
    prose('Which means the bottom rung of every ladder is a page that works with JavaScript switched off.') +
    heading('The device tier is a read, so it is an axis', 'axis') +
    nth('devices', 0) +
    prose(
      'Three values is low cardinality, and low cardinality is what lets a read become an ahead-of-time ' +
        'permutation instead of a branch taken per request. The plan can carry a branch per tier; the ' +
        'fragment never learns which one it was rendered for.',
    ) +
    note(
      'why',
      'Why the harness cannot prove all of this',
      'What a real WebKit build does with a frame is not something a Node test knows. So the claims here ' +
        'are split: what the harness proves on every run, what it proves under a real engine with ' +
        'Playwright, and what is a reasoned expectation with the reasoning written down. ' +
        '<code>spec/baseline/devices.md</code> keeps them in three separate lists, deliberately.',
    ),

  versioning: () =>
    prose(
      'Two artifacts were versioned before there was a framework, because a wire format and a compiler ' +
        'output cannot be versioned retroactively: adding a version field later means every client already ' +
        'in the field is unversioned.',
    ) +
    (() =>
      table(
        ['Artifact', 'Id', 'Version', 'Reference implementation'],
        artifacts().map((artifact) => [
          escapeHtml(artifact.what),
          `<code>${escapeHtml(artifact.spec)}</code>`,
          `<code>${escapeHtml(artifact.version)}</code>`,
          `<code>${escapeHtml(artifact.reference)}</code>`,
        ]),
      ))() +
    prose(
      'Those three numbers are read from the constants this build stamps on a document, not typed here. ' +
        'The summary table in <code>spec/VERSIONING.md</code> was one minor behind the source when this ' +
        'page was written, which is the argument for generating it made by the thing it happened to.',
    ) +
    heading('What each component means', 'components') +
    table(
      ['Change', 'What a reader must do', 'What it costs you'],
      [
        ['Patch', 'Nothing. No format change.', 'Nothing.'],
        [
          'Minor',
          'Accept it. Additive fields, and a reader must round-trip what it does not understand.',
          'Nothing — an older reader keeps working, and says <code>forward</code> when asked how.',
        ],
        [
          'Major',
          'Refuse it: <code>E_MAJOR_UNSUPPORTED</code>.',
          'A hard wire break. The id changes too, so the two formats cannot be confused.',
        ],
      ],
    ) +
    prose(
      'The name is part of the contract: <code>weft.template-ir/2</code> and ' +
        '<code>weft.template-ir/3</code> are different <em>formats</em>, not two versions of one. A ' +
        'document whose spec name a reader does not know is <code>E_SPEC_MISMATCH</code> before any ' +
        'version comparison happens.',
    ) +
    heading('Migrations are registered, and they go one way', 'migrations') +
    prose(
      'A stored document on an older minor is migrated up by a registered function, and the registry is ' +
        'checked: a gap in the chain is <code>E_MIGRATION_MISSING</code>, a cycle is ' +
        '<code>E_MIGRATION_CYCLE</code>, and a migration pointing down is ' +
        '<code>E_MIGRATION_DIRECTION</code>. None of that is discovered while serving a request.',
    ) +
    note(
      'why',
      'Why a template version is a hash, and this is not',
      'They answer different questions. <code>2.6.0</code> is "can this reader read this document" — a ' +
        'contract between two pieces of software. A sealed template’s version is a content address: ' +
        '"is this the same template", which is what makes a delta’s base nameable and a cache key ' +
        'derivable. A hash cannot express compatibility and a semver cannot express identity.',
    ),

  testing: () =>
    prose(
      'A fragment compiles to data, and data is the easiest thing there is to test. There is no browser to ' +
        'start, no server to boot for a unit test, and no snapshot file to keep in step — because the ' +
        'thing under test is a sealed template and its render is a pure function of values.',
    ) +
    heading('Render one', 'render') +
    sketch(
      'ts',
      `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from 'weft/server'
import { fragmentIR } from 'weft'
import { render } from '@weft/ir'

test('the badge renders its label', async () => {
  await createApp(process.cwd(), { mode: 'dev', port: 0 })
  const badge = fragmentIR('examples/badge')
  const html = new TextDecoder().decode(render(badge.entry, { label: 'new' }, badge.resolve))
  assert.match(html, /new/)
})`,
    ) +
    prose(
      '<code>fragmentIR</code> hands back the same sealed template the server renders, so a test is not a ' +
        'second compilation that could disagree with production. This site’s own tests are that shape, and ' +
        'they are the reason a broken example cannot ship.',
    ) +
    heading('Assert on what the compiler inferred', 'infer') +
    prose(
      'The interesting assertions are usually not about markup. A fragment’s effect set, its hole classes ' +
        'and its wire forms are all on the template, so the properties this framework cares about are ' +
        'directly checkable:',
    ) +
    sketch(
      'ts',
      `assert.deepEqual(cart.entry.effects.reads, ['identity', 'cookie:currency'])
assert.equal(total.entry.holes[1]?.escape, 'proven-safe')
assert.ok(feed.entry.forms.includes('delta'))`,
    ) +
    prose(
      'A test that a private fragment stayed private is one line, and it fails the moment somebody adds a ' +
        'read that would have made a page uncacheable.',
    ) +
    heading('Serve the whole thing', 'serve') +
    sketch(
      'ts',
      `const app = await createApp(root, { mode: 'dev', port: 0 })
const serving = await serveApp(app)
const response = await fetch(new URL('/cart', serving.url))
assert.equal(response.headers.get('vary'), 'Cookie')
await serving.close()`,
    ) +
    prose(
      'Port zero, so tests run in parallel. What is worth asserting at this level is the envelope — the ' +
        'status, the cache class, <code>Vary</code>, the order the regions arrived in — because those are ' +
        'the things a unit test on a template cannot see.',
    ) +
    heading('Three things the framework checks for you', 'gates') +
    table(
      ['Command', 'What it refuses'],
      [
        [
          '<code>weft build</code>',
          'A fragment outside the subset, a declaration contradicting an inferred fact, a hole nothing fills, a route two files both mean.',
        ],
        ['<code>weft verify</code>', 'A composed region whose contract has moved since this build.'],
        [
          '<code>weft why &lt;route&gt;</code>',
          'Nothing — it prints the plan and where each fact came from. The first thing to run when a page is not what you expected.',
        ],
      ],
    ) +
    note(
      'why',
      'What this site does, if you want a worked example',
      'Every example here is rendered by a test, every export is checked against the module system, every ' +
        'refusal in the framework is scanned for independently, and every spec document has to be named by ' +
        'a page. <code>packages/docs/test/docs.test.ts</code> is about two hundred lines and is the whole ' +
        'of it.',
    ),

  cli: () =>
    prose(
      `<code>weft</code> — ${escapeHtml(tagline())}. Everything below is parsed from the help text the ` +
        'CLI itself prints, so a flag that is not here does not exist, and one that exists cannot be ' +
        'missing from here: the test asserts every implemented command appears on this page.',
    ) +
    heading('Commands', 'commands') +
    (() =>
      table(
        ['Command', 'What it does'],
        commands().map((command) => [
          `<code>${escapeHtml(command.usage)}</code>`,
          escapeHtml(command.summary),
        ]),
      ))() +
    heading('Options', 'options') +
    (() =>
      table(
        ['Option', 'Only for', 'What it does'],
        options().map((option) => [
          `<code>${escapeHtml(option.flag)}</code>`,
          option.only ? `<code>weft ${escapeHtml(option.only)}</code>` : 'any command',
          escapeHtml(option.summary),
        ]),
      ))() +
    heading('The four you will actually type', 'four') +
    prose(
      '<code>weft dev</code> while writing, <code>weft build</code> before shipping, and two that answer ' +
        'questions rather than doing work:',
    ) +
    sketch(
      'sh',
      `weft routes            # the route table, as the file tree produced it
weft why /blog/:slug   # the plan for one route, and where each fact came from`,
    ) +
    prose(
      '<code>weft why</code> is the one worth learning early. Every page on a weft site is the result of a ' +
        'generated plan, and when a page is not what you expected, the plan says which fragment fills which ' +
        'hole, what each one reads, what class that made it, and whether the answer came from a ' +
        'declaration, the compiler or a <a href="/guide/measuring">recording</a>.',
    ) +
    note(
      'careful',
      'Two commands change the world',
      '<code>weft upload</code> PUTs a build to an object store — <code>--dry-run</code> first, always. ' +
        '<code>weft create</code> writes a directory. Everything else reads.',
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
import { defineConfig, redisLeases } from 'weft'
import { workerPool } from '@weft/adapters'

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

export interface Heading {
  id: string
  text: string
}

const HEADING = /<h2 id="([^"]+)"><a class="anchor" href="#[^"]*">([^<]*)<\/a><\/h2>/g

const headings = new Map<string, Heading[]>()

/**
 * The sections of one page, read back out of the markup it produced.
 *
 * Extracted rather than declared beside the prose, because a second list of headings is a list that
 * goes stale the first time somebody renames one. The page is the source; this reads it.
 *
 * Memoised, because reading it means rendering the page — and the search index reads every page's
 * headings on every query. A body is a pure function of the process's own source, so the answer
 * cannot change while the process runs.
 */
export function headingsOf(slug: string): Heading[] {
  const cached = headings.get(slug)
  if (cached) return cached
  const body = BODIES[slug]
  if (!body) return []
  const found = [...body().matchAll(HEADING)].map((match) => ({
    id: match[1] as string,
    text: (match[2] as string).trim(),
  }))
  headings.set(slug, found)
  return found
}

/** Everything a reader could search for, per page: its title, its lede and its section headings. */
export function searchableText(slug: string): string {
  const page = BY_SLUG[slug]
  if (!page) return ''
  return [page.title, page.lede, ...headingsOf(slug).map((section) => section.text)].join(' ')
}

/** How many examples the guide renders in total, for the landing page's own claim about itself. */
export function exampleCount(): number {
  return PAGES.reduce((sum, page) => sum + page.examples.length, 0)
}

/** The contents column, identical on every page under the guide layout — so it is one cache entry. */
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
  const sections = headingsOf(slug)
  const onThisPage = sections.length
    ? `<h2 class="hint">On this page</h2><ul class="contents">${sections
        .map((section) => `<li><a href="#${section.id}">${section.text}</a></li>`)
        .join('')}</ul>`
    : ''
  return `${onThisPage}${specs}${examples}<p class="hint">The guide explains. <a href="https://github.com/raminjafary/weft/tree/main/spec"><code>spec/</code></a> is the reference, with every refusal. <code>pnpm inspect</code> is the live version, with a control.</p>`
}
