import { plainTerms, verdictPair, type Refusal, type Verdict } from './figures.ts'
import { hero } from './heroes.ts'
import { staticPages } from './pages.ts'

/**
 * What every guide page opens with, before its prose.
 *
 * Three things, in this order: a figure of the mechanism moving, what it accepts against what it
 * refuses, and the whole page in four sentences. The order is the argument — a reader should be
 * able to stop after any one of them and have learnt something true, and the one most likely to be
 * read is the one that costs the least, so it goes last where a scroll lands.
 *
 * The refusal is beside the acceptance rather than at the foot of the page because the constraints
 * are the design here. Somebody deciding whether this framework will fight them should meet the
 * boundary on the way in.
 */

export interface Opener {
  /** Absent where the page's subject is not a refusal. `scoped-styles` is the one. */
  ok?: Verdict
  no?: Refusal
  /** The page in four sentences, for a reader meeting the mechanism for the first time. */
  plain: string
  /** What the hero figure is showing. */
  caption: string
}

const OPENERS: Record<string, Opener> = {
  'getting-started': {
    ok: {
      title: 'An application with no config file',
      body: 'You get an in-process store, a cookie session, no flag axes and inline as the only executor — a real single-process deployment, not a placeholder. Bind a port in weft.config.ts later and nothing else in the application changes.',
    },
    no: {
      title: 'reading a flag nobody declared',
      body: 'A typo becomes a build error instead of a branch that silently never runs.',
      chips: ['what you wrote', 'flags must be declared in weft.config.ts', 'build error'],
    },
    plain:
      'Run one command and you get a folder that already serves a page. The framework reads the tree — there is no registry to update, no route config, and no build step to understand before your first edit. --template minimal gives you four files instead of twenty-one if you would rather start from almost nothing.',
    caption:
      'Every file the command writes, in both templates. There is no src/, no bundler config, no route manifest and no plugin list: the routes/ subtree is the route table, and weft.config.ts arrives with every line commented out because an application with no config still has a real store, a cookie session and an executor.',
  },
  'an-application': {
    ok: {
      title: 'A parameter set, fully declared',
      body: 'params: { category: [’pantry’, ’household’] } is one document per value, each proved on its own — so a passing check for one says nothing about the other.',
    },
    no: {
      title: 'half the values enumerated',
      body: 'Files for some URLs of a route and a live render for the rest is the one outcome nobody could debug.',
      chips: ['what you wrote', 'a route’s params must cover every value or none', 'refused'],
    },
    plain:
      'Where a file sits is its URL. A name in square brackets is a parameter, three dots is a wildcard, and a .data.ts beside a page is that page’s declaration. A layout.tsx in a directory wraps every route beneath it.',
    caption:
      'The route table is the file tree, and the plan that places everything on a page is generated from the same walk. Nothing is registered anywhere.',
  },
  fragments: {
    ok: {
      title: 'A hole the compiler can name',
      body: 'A prop, a field, a mapped list, a derived value. The body is read once and never executed, so what lands in a hole is always a value rather than a call.',
    },
    no: {
      title: 'a call inside a hole',
      body: 'There is nowhere for the call to happen. Compute it before the fragment, or name an intent for an event.',
      chips: ['what you wrote', 'a fragment body is a declaration, not code that runs', 'refused'],
    },
    plain:
      'You write a function that returns markup. The compiler reads it once, never runs it, and turns it into an array of finished bytes with gaps. Rendering is walking that array and dropping today’s values into the gaps.',
    caption:
      'A fragment lowers to segments and holes. The bytes never change, only what lands in the holes — which is why a render can be a copy and an update can name one hole.',
  },
  components: {
    ok: {
      title: 'One root, children as the sole child',
      body: 'A component compiles without seeing its call site, so its shape has to be predictable from the file alone.',
    },
    no: {
      title: 'children beside a sibling',
      body: 'Two more follow from the same rule: E_COMPONENT_NOT_SINGLE_ROOT and E_PRIVATE_COMPONENT_NESTED.',
      chips: [
        'what you wrote',
        'the children hole must be the only child of its element',
        'E_CHILDREN_NOT_SOLE_CHILD',
      ],
    },
    plain:
      'One fragment can sit inside another. Because the compiler lowers each one without seeing where it will be used, a component has to be predictable: a single root, and children as the sole child of their element.',
    caption:
      'Composition happens in the byte stream. At runtime there is no tree to walk and no component to instantiate — the child’s segments are simply part of the parent’s.',
  },
  /**
   * The one page with no verdict pair.
   *
   * Scoped styles are a mechanism Vue, Svelte and Angular already have, so the page has no refusal
   * to open with — what is interesting about it is *when* the attribute is stamped, which is what
   * the figure and this caption say. A pair invented to fill the slot would be furniture.
   */
  'scoped-styles': {
    plain: '',
    caption:
      'The same mechanism Vue, Svelte and Angular use. What is different is when it happens: a template here is data rather than a function, so the attribute is stamped into the sealed bytes by the compiler — nothing at runtime, and one attribute per element on the wire.',
  },
  layouts: {
    ok: {
      title: 'A route filling the holes of its chain',
      body: 'Two of this guide’s holes come from the document and two from the section layout, and the page’s declaration does not say which is which.',
    },
    no: {
      title: 'filling a hole no layout declares',
      body: 'The error names the chain it looked through, so you can see which layout you meant.',
      chips: ['what you wrote', 'the chain is walked and the name is not in it', 'build error'],
    },
    plain:
      'A layout is the page around your page. app/layout.tsx is the document itself; a layout.tsx inside a directory wraps everything under it. Each one leaves named holes, and a route fills the ones it knows about.',
    caption:
      'Holes fill outside in. Two of this site’s four holes come from the guide layout and two from the document, and nothing in a page’s declaration says which is which.',
  },
  'effects-and-cache': {
    ok: {
      title: 'A class derived from the reads',
      body: 'Read nothing and the page is a file. Read the locale and it is one shared entry per value. Read identity and it is private — all three decided for you.',
    },
    no: {
      title: '.cache(’public’) on a fragment that read identity',
      body: 'The failure names identity, so you know which read contradicted you.',
      chips: ['what you wrote', 'the declaration disagrees with the inferred effects', 'build failure'],
    },
    plain:
      'You never write a cache key. The compiler notes every read a fragment makes — the user, a cookie, the locale, a query parameter — and that set of reads is the key. Read nothing and your page is a file; read identity and it is private to one person.',
    caption:
      'The key is what the compiler saw the fragment read. There is no setter in the kernel, the plan DSL or the plugin surface, and that absence is the enforcement.',
  },
  'slots-and-streaming': {
    ok: {
      title: 'stream: true, with a placeholder',
      body: 'The shell stops waiting for that region; the placeholder is declared, cheap and visibly incomplete, and the real markup lands in the same hole later.',
    },
    no: {
      title: 'etag: true on a route whose slots stream',
      body: 'The streaming slots are named. On a route whose slots all buffer, the same line gets a strong tag and a 304 that costs no body.',
      chips: ['what you wrote', 'an ETag digests a whole entity; the envelope seals first', 'E_ETAG_STREAMS'],
    },
    plain:
      'Mark the slow part of the page as a slot and the shell stops waiting for it. Everything fast goes out immediately, the slow region sends a placeholder, and its real markup arrives later and lands in the right hole.',
    caption:
      'Both lanes settle at 103 ms with identical DOM in Chromium, Firefox and WebKit. The difference is when the fast region became visible, and it costs 329 bytes of inline script.',
  },
  'where-it-runs': {
    ok: {
      title: 'A budget on a preemptible executor',
      body: 'pool: is a real worker_threads pool, so a breach terminates the render mid-loop and the slot falls to its declared behaviour.',
    },
    no: {
      title: 'a CPU budget on inline',
      body: 'The breach is reported with a message saying the render ran to completion anyway — rather than pretending it was stopped.',
      chips: ['what you wrote', 'inline cannot be preempted', 'reported, not enforced'],
    },
    plain:
      'Slots that do not depend on each other run at the same time. Saying a slot needs another puts it in a later wave. Where a slot runs is separate: in the request, deferred, in a worker pool, or on another deployment entirely.',
    caption:
      'Nine slots, three waves: a 42.7 ms critical path against a 123.3 ms sequential walk. Safe for one reason — render is provably read-only, so two fragments cannot observe each other’s side effects.',
  },
  declarations: {
    ok: {
      title: 'A route stating what it is',
      body: 'Head, cache policy, loader, guard, slots, parameter set. Delivery is then derived, and the build prints which pages became files.',
    },
    no: {
      title: 'a declaration the framework cannot honour',
      body: 'Every one names what it looked at: the read, the streaming slot, the undeclared parameter, the live region.',
      chips: ['what you wrote', 'checked against the inferred effects at build time', 'named refusal'],
    },
    plain:
      'A route declares what it is, not how to cache it: a title, a loader, a guard, its slots, its parameter set. Everything about delivery is then derived — and a declaration the framework cannot honour fails the build with the reason named.',
    caption:
      'The build prints the reason for every page that did not become a file: an undeclared parameter, a read, a live region, a streaming slot.',
  },
  measuring: {
    ok: {
      title: 'A recording changing delivery',
      body: 'A slow region streams; a uniformly fast page buffers, so the 329-byte filler stays off the wire.',
    },
    no: {
      title: 'a profile moving placement or a key',
      body: 'And a slot with fewer than eight renders decides nothing at all.',
      chips: ['what you wrote', 'a recording has no standing over inferred effects', 'not offered'],
    },
    plain:
      'Run the dev server with --profile and it records what each render actually cost. The next build uses that recording to decide what streams and what buffers. It never touches placement, cache classes or keys — a recording of last Tuesday has no standing over what the compiler inferred.',
    caption:
      'A slow region streams; a uniformly fast page buffers, so the 329-byte filler stays off the wire. A slot with fewer than eight renders decides nothing.',
  },
  'the-client': {
    ok: {
      title: 'A signal, changed by an intent',
      body: 'Adoption records where each value lives; a write reaches those nodes and nothing else. The binding for an event is an intent name.',
    },
    no: {
      title: 'a shape a signal decides',
      body: 'A conditional value over the same signal is reactive and allowed — the refusal names which one you wrote.',
      chips: ['what you wrote', 'a conditional shape belongs to the server', 'E_BRANCH_ON_SIGNAL'],
    },
    plain:
      'The browser does not re-render what the server sent. The runtime walks the DOM the parser already built, writes down where each value lives, and stops. After that, a change is one write to one node.',
    caption:
      'Adopting a 50-row region costs 0.047 ms in Chromium against 0.076 ms to parse the same markup — and a 12-path delta applies in 0.0017 ms.',
  },
  navigation: {
    ok: {
      title: 'Hover stages, click commits',
      body: 'The staged epoch paints nothing, so prefetch cannot disturb the present and rollback is discarding it. 254 bytes on the client.',
    },
    no: {
      title: 'staging on loopback',
      body: '17 ms staged against 606 ms on a slow page; on loopback a staged click loses to the browser. That is the floor of the idea, and the table says so.',
      chips: ['what you wrote', 'there is no latency to hide', 'slower, and stated'],
    },
    plain:
      'Hovering a link fetches the next page into a staging area that paints nothing. Clicking swaps it in as one atomic change. If you never click, nothing you saw was disturbed — discarding a staged epoch is free.',
    caption:
      '17 ms staged against 606 ms, and 7–19× on ordinary pages at 100 ms injected RTT. On loopback a staged click is slower than letting the browser do it, which is the honest floor of the idea.',
  },
  intents: {
    ok: {
      title: 'writes, declared up front',
      body: 'The framework drops exactly the tags you named and nothing else. Naming nothing is legitimate for an intent that owns no cached state — and the client never names your code: an intent is addressed by an opaque id derived from its module and export, so renaming the export does not change the wire.',
    },
    no: {
      title: 'invalidating a tag outside writes',
      body: 'An undeclared write is an invalidation nobody could predict by reading the code, and predicting it by reading the code is the whole value of the effect graph. Unlike the read guard, this one is not dev-only.',
      chips: ['what you wrote', 'the tag is checked against the declaration', 'E_UNDECLARED_WRITE · 500'],
    },
    plain:
      'Nothing but an intent may write. It declares four things — a name, the tags it invalidates, a validator for its input, and a body — and that is the whole surface. Post it from a plain form and the page works with JavaScript switched off; dispatch it from the channel and the same four things run.',
    caption:
      'One dispatch, two callers. A form post and a channel frame reach the same input() and the same run(); only the answer differs — a 303 for the browser that submitted, an ACK for the client that dispatched. The tags in writes are what become refreshes.',
  },
  'live-regions': {
    ok: {
      title: 'HELD, and the smallest form that will do',
      body: 'No template if the client has one, values alone if they project, one COMMIT when a staged set should become visible.',
    },
    no: {
      title: 'a POST whose downstream has dropped',
      body: 'The frames were understood and there was nowhere to put the answer, so it says so — a silent 200 would be the wrong answer to a real question. A frame arriving from the wrong direction is rejected before anything reads it.',
      chips: ['what you wrote', 'the half-duplex bindings answer on the other connection', 'E_NO_DOWNSTREAM'],
    },
    plain:
      'A live region keeps a page current without polling it. The client opens by saying which templates and which base render it holds; the server diffs against that base and sends the smallest form that will do. A thousand clients on the same base cost one diff, because the answer is memoized by the transition rather than computed per connection.',
    caption:
      'One socket, and a vocabulary small enough to read in full. The client opens by naming what it already holds, so the server can send the smallest thing that will do — and when the upgrade does not survive the path, the same frames arrive over an SSE stream and a POST instead.',
  },
  'what-ships': {
    ok: {
      title: 'An entry inside its ceiling',
      body: 'The gate is the real walk over HTTP — 46,698 B brotli for the demo — and the build writes weft.budget.json so a change is a diff.',
    },
    no: {
      title: 'an entry over its ceiling',
      body: 'Each capability has its own entry and its own ceiling, so the first feature to arrive cannot spend the headroom every later one needs.',
      chips: ['what you wrote', 'budget({ js, grow }) is enforced by weft build', 'build failure'],
    },
    plain:
      'There is no bundler. The browser fetches the files on disk with their types stripped, so what you read is what runs. The budget is measured on that real fetch, not on an imaginary bundle.',
    caption:
      'The bundled figure is the code, not the download, and the difference is 3.5×. The gated number is the walk over HTTP, which agrees with the bundle walk within 0.3%.',
  },
  deploying: {
    ok: {
      title: 'Eleven ports bound by the front door',
      body: 'No configuration at all for a first deployment. Bind a port and only that behaviour changes.',
    },
    no: {
      title: 'a declared rate limit with no limiter',
      body: 'Not unlimited. Likewise an edge key-value store refuses lease outright, because a lease that is not atomic guards nothing.',
      chips: ['what you wrote', 'a port that is not bound never approximates', 'E_NO_RATE_LIMIT'],
    },
    plain:
      'Ports are the things your deployment provides: a store, a limiter, a registry, a clock. You swap a port to change where something lives; you add a plugin to add something to a request. Ports replace, plugins extend.',
    caption:
      'A port that is not bound refuses by name and never approximates: a declared rate limit with no limiter is an error, not unlimited.',
  },
  composition: {
    ok: {
      title: 'A region naming itself',
      body: 'REGION carries the name the shell asked for, the contract it believes it serves, and the revision serving it — which is what makes the splice checkable.',
    },
    no: {
      title: 'a SHELL, COOKIE or PLAN from a region',
      body: 'The refusal names the authority it would have borrowed, and that region degrades to its fallback.',
      chips: ['what you wrote', 'those frames are the composite’s, not a region’s', 'E_REGION_FRAME'],
    },
    plain:
      'A region is a slot whose renderer might live somewhere else. The shell names it, a registry says what is serving it right now, and what comes back is the same Warp frames every render here already produces. Rolling a region is a registry write, not a redeploy.',
    caption:
      'The same region composed in-process and over a binding produces byte-identical markup — the test that fails first if the collapsed monolith becomes a special case.',
  },
  devices: {
    ok: {
      title: 'Three engines, measured directly',
      body: 'Chromium, Firefox and WebKit, never aggregated, with WebKit labelled a desktop proxy rather than an iOS number.',
    },
    no: {
      title: '--engines ios with no device attached',
      body: 'It says “not measured” with a reason instead of reporting a zero.',
      chips: ['what you wrote', 'a desktop proxy has nothing honest to fall back on', 'refuses by name'],
    },
    plain:
      'A browser engine on a laptop is not a phone. Three engines are measured directly; iOS and Android are real lanes that refuse to run until a device is attached, because a desktop proxy has nothing honest to fall back on.',
    caption:
      'It never aggregates engines, and it says “not measured” with a reason instead of reporting a zero.',
  },
  versioning: {
    ok: {
      title: 'A minor version, either direction',
      body: 'Minors round-trip: a newer peer reads an older frame and an older peer reads a newer one.',
    },
    no: {
      title: 'a peer speaking a different major',
      body: 'A partial translation that half-works is the one failure nobody could debug in production.',
      chips: [
        'what you wrote',
        'the version is a constant the build stamped on the document',
        'refused, both versions named',
      ],
    },
    plain:
      'Two wire formats are versioned on their own: the template IR and the Warp frame protocol. A minor version travels in both directions. A major refuses the connection rather than guessing at a translation.',
    caption:
      'The version a document carries is the constant the build stamped on it, so what a page claims and what the code does cannot drift apart.',
  },
  testing: {
    ok: {
      title: 'Every region agreeing',
      body: 'weft verify --probe walks the whole tree, each tier answering for its own registry, and exits 0.',
    },
    no: {
      title: 'regions disagreeing',
      body: 'And W_REGION_TREE_DEEPER when a route turns out to cross more boundaries than its plan could count.',
      chips: ['what you wrote', 'the probe compares what each region says it serves', 'exit non-zero'],
    },
    plain:
      'You can ask a running deployment what it is actually serving, and it will disagree out loud. Conformance runs as plain node --test over the packages and your own application, with no test framework to install.',
    caption:
      'Each tier answers for its own registry and the tier above splices, so the whole tree prints as one graph — and a subtree travels only in a probe’s answer.',
  },
  cli: {
    ok: {
      title: 'A flag the binary accepts',
      body: 'This page is the --help text, parsed, so what you read is what the command takes.',
    },
    no: {
      title: 'an unknown flag or template',
      body: 'Nothing is scaffolded or built on a typo.',
      chips: ['what you wrote', 'the argument is checked before anything runs', 'usage, and a non-zero exit'],
    },
    plain:
      'Ten commands, and each one answers a question you would otherwise have to guess at: what routes exist, what plan a route got, what a render costs, what every region is serving, and what the build turned into files.',
    caption:
      'This page is the --help text, parsed — so the flags you read here are exactly the flags the binary accepts.',
  },
}

/**
 * The opening of one page: its figure, then whichever of the other two it has.
 *
 * Every page has a figure. `scoped-styles` has neither a verdict pair nor a plain-terms panel,
 * because its subject is a mechanism three other frameworks already have and the interesting part
 * is in the figure. A missing piece writes nothing rather than an empty frame.
 */
export function opener(slug: string): string {
  const figure = hero(slug, staticPages())
  const found = OPENERS[slug]
  if (!found) return figure
  const pair = found.ok && found.no ? verdictPair(found.ok, found.no) : ''
  return `${figure}${pair}${found.plain ? plainTerms(found.plain) : ''}`
}

/** The caption under a page's hero figure. Read by `heroes.ts`, which draws the figure itself. */
export function caption(slug: string): string {
  return OPENERS[slug]?.caption ?? ''
}

/** Which slugs open with a verdict pair. Read by the test, so a new page cannot quietly skip it. */
export function opened(): string[] {
  return Object.keys(OPENERS).filter((slug) => OPENERS[slug]?.ok !== undefined)
}
