import { escapeHtml, note, prose } from './markup.ts'

/**
 * The words this framework uses in a way another framework does not.
 *
 * A glossary earns its place exactly where a familiar word has been given a narrower meaning — and
 * this design does that repeatedly. "Slot" is not a Vue slot, "hydration" does not happen, "delta"
 * is not a diff, and "plan" is not a build config. A reader who maps each of those onto what they
 * already know will be wrong in a way the surrounding prose will not correct.
 */
export interface Term {
  term: string
  short: string
  body: string
  /** Where to read more. */
  see?: readonly { label: string; href: string }[]
}

export const TERMS: readonly Term[] = [
  {
    term: 'Adoption',
    short: 'Attaching behaviour to server-rendered DOM without re-rendering it.',
    body:
      'The client walks the wiring the compiler emitted and attaches one binding per node that reads a ' +
      'value. No component code runs and no virtual tree is built, so the cost is the number of bindings ' +
      'rather than the number of components. It replaces hydration rather than being a faster version of it.',
    see: [{ label: 'The client', href: '/guide/the-client' }],
  },
  {
    term: 'Anchor',
    short: 'A marker comment that makes a text hole addressable after the page is painted.',
    body:
      'A value between two other values has no element of its own, so there is nothing for a later ' +
      'update to write into. The compiler emits a marker comment and records its ordinal on the hole, ' +
      'which is what lets a delta write one word of a sentence without wrapping it in a span nobody ' +
      'asked for.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Axis',
    short: 'A low-cardinality read the plan can be built for ahead of time, per value.',
    body:
      'A flag with two branches, a device tier with three, a locale with a known set: the plan can carry ' +
      'a variant per value rather than a branch taken per request. High-cardinality reads — a cookie ' +
      'holding a session — become key components instead. A plugin may add an axis; nothing may write a ' +
      'key.',
    see: [{ label: 'Every surface at once', href: '/guide/devices' }],
  },
  {
    term: 'Base render',
    short: 'The value set a client is holding, named so a delta can be computed against it.',
    body:
      'A delta is a function of two states, so the server has to know which state the client has. The ' +
      'client names it by content address; the server recovers that render from the store. This is what ' +
      'lets one delta computation serve every client on the same base, where a per-connection diff needs ' +
      'a process per connection.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Budget',
    short: 'A ceiling: CPU for a region, bytes for a client entry. Enforced only where it can be.',
    body:
      'A CPU budget is real on a worker pool and advisory on the inline executor, and the framework warns ' +
      'rather than reporting a number that measured several renders at once. A byte budget is per client ' +
      'entry, committed to the repository, so growth is a diff somebody reviews.',
    see: [
      { label: 'Where it runs', href: '/guide/where-it-runs' },
      { label: 'What ships', href: '/guide/what-ships' },
    ],
  },
  {
    term: 'Cache class',
    short: 'static, shared or private — derived from what a fragment read, never declared.',
    body:
      'A fragment that reads nothing is <code>static</code>; one that reads a cookie, header, locale or ' +
      'flag is <code>shared</code> and keyed by the value; one that reads identity is <code>private</code>. ' +
      'A declaration that contradicts the derivation fails the build, naming the read.',
    see: [{ label: 'Effects and cache', href: '/guide/effects-and-cache' }],
  },
  {
    term: 'Capability',
    short: 'A named permission an intent requires. Declared and unchecked means refused, not allowed.',
    body:
      "An intent may declare <code>capabilities: ['cart:checkout']</code>, and a deployment with nothing " +
      'bound to check it refuses every call rather than waving them through — <code>E_NO_CAPABILITY_CHECK</code>. ' +
      'Grants are rows an operator can see and change, which is the difference between authority and a ' +
      'branch in a framework.',
    see: [{ label: 'Intents', href: '/guide/intents' }],
  },
  {
    term: 'Delta',
    short: 'The changed values of a region, addressed by hole. Not a DOM diff.',
    body:
      'There is nothing to reconcile: the client holds the template, so a delta names holes and new ' +
      'values. It is the smallest wire form and it is only available when the client can prove it holds ' +
      'the template and names its base render.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Derived value',
    short: 'A value computed from other bindings, travelling as an expression tree rather than code.',
    body:
      'A total computed from a quantity and a price is a derived value. The expression is data the client ' +
      'evaluates, so there is no closure on the wire and no component to ship; one whose inputs are all ' +
      'props is resolved once at render, and one that reads a signal is reactive on the client.',
    see: [{ label: 'The client', href: '/guide/the-client' }],
  },
  {
    term: 'Effect set',
    short: 'What a fragment reads, inferred by the compiler. The input to every cache decision.',
    body:
      'Reads, writes, envelope effects and residency. Reads become the cache key and the <code>Vary</code> ' +
      'header; writes stay empty on fragments because a render cannot write. A read the compiler cannot ' +
      'name statically is a build error rather than a key with a hole in it.',
    see: [{ label: 'Effects and cache', href: '/guide/effects-and-cache' }],
  },
  {
    term: 'Epoch',
    short: 'A set of staged values committed atomically, or discarded.',
    body:
      'An optimistic update is staged into an epoch and every region in it flips in one paint. Rollback ' +
      'is discarding the epoch — nothing was painted, so there is nothing to un-paint and no prior state ' +
      'to reconstruct.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Escape elision',
    short: 'Dropping the escape call on a hole whose type cannot hold markup.',
    body:
      'Escaping a number produces the same bytes as not escaping it, so the compiler asks the type checker ' +
      'and lowers that hole as <code>proven-safe</code>. It is a type question, which is why it needs a ' +
      'checker: with <code>--no-types</code> every hole escapes, and the page says so.',
    see: [{ label: 'Fragments', href: '/guide/fragments' }],
  },
  {
    term: 'Executor',
    short: 'Where a fragment runs, and therefore what its failure can take down.',
    body:
      '<code>inline</code> is this thread and no boundary. <code>pool:</code> is a worker, so a crash costs ' +
      'one region rather than the request. <code>binding:</code> and <code>svc:</code> reach another ' +
      'deployment. The reason to choose one is usually the crash domain rather than the speed.',
    see: [{ label: 'Where it runs', href: '/guide/where-it-runs' }],
  },
  {
    term: 'Fragment',
    short: 'The unit this framework compiles: a function that returns markup, lowered to a sealed template.',
    body:
      'A fragment is also a unit of delivery. It has a cache key, a wire form, an executor and a budget — ' +
      'which is the difference between it and a component: a component is a rendering idea, and a ' +
      'fragment is a rendering idea with a delivery story attached.',
    see: [{ label: 'Fragments', href: '/guide/fragments' }],
  },
  {
    term: 'Hole',
    short: 'A gap in a sealed template, addressed by the binding that fills it.',
    body:
      'Holes have kinds — text, attribute, list, component, slot, children — and each kind says who ' +
      'produces its bytes. A <code>slot</code> hole is a boundary this render does not own; so is an ' +
      'isolated component instance, which is why the plan layer treats them as one list.',
    see: [{ label: 'Fragments', href: '/guide/fragments' }],
  },
  {
    term: 'Intent',
    short: 'The only thing allowed to write. Addressed by an opaque id, with its writes declared.',
    body:
      'A render cannot write, enforced by the type of the context it receives. Every mutation is an intent ' +
      'with a declared write set; an undeclared invalidation throws rather than being permitted, because ' +
      'an invalidation nobody can predict by reading the code defeats the point of the effect graph.',
    see: [{ label: 'Intents', href: '/guide/intents' }],
  },
  {
    term: 'Isolation',
    short: 'Cutting the byte stream around a private instance so its caller stays shared.',
    body:
      'A private fragment inside a shared one would normally make the whole thing private. Instead the ' +
      'compiler leaves a boundary the kernel fills, exactly as it does for a slot — so one signed-in card ' +
      'does not make a page uncacheable. Inside a list row there is nowhere to cut, and that case is ' +
      'refused by name.',
    see: [{ label: 'Components', href: '/guide/components' }],
  },
  {
    term: 'L0',
    short: 'The tier where a document is a file and the kernel is never invoked.',
    body:
      'A page whose every fragment reads nothing is resolved at build time and written as a file. A ' +
      'parameterised route joins that tier when its parameters are a set the application declared. Every ' +
      'page that is not a file is refused by name, with the read that caused it.',
    see: [{ label: 'Ports, config and the build', href: '/guide/deploying' }],
  },
  {
    term: 'Locus',
    short: 'Where a render runs: inline, deferred, a worker pool, another deployment.',
    body:
      'Declared per slot as an executor. It is a separate question from placement — which hole a fragment ' +
      'fills — and from delivery, which is when its bytes arrive. Keeping the three apart is what lets a ' +
      'profile decide one of them from measurement without touching the others.',
    see: [{ label: 'What a route declares', href: '/guide/declarations' }],
  },
  {
    term: 'Patch',
    short: 'The middle wire form: the markup of the holes that changed, as DOM writes.',
    body:
      'Smaller than the whole region and cheaper to accept than a delta, because it needs nothing resident ' +
      'on the client — no template and no base render. It is the rung a client reaches when it has just ' +
      'arrived, or when it lost what it was holding.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Placeholder',
    short: 'The bytes a region sends when it cannot be served: declared, cheap, visibly incomplete.',
    body:
      'Declared next to the budget or the region it stands in for, and usually a template with no holes so ' +
      'that rendering it cannot fail the way the thing it replaces did. The alternative — an empty hole — ' +
      'is a page that looks finished and is not.',
    see: [{ label: 'Where it runs', href: '/guide/where-it-runs' }],
  },
  {
    term: 'Plan',
    short: 'A route’s declared placement, delivery and policy — checked against what the compiler inferred.',
    body:
      'Generated from the file convention rather than written by hand. It is validated against the ' +
      'compiler’s facts before it is lowered, so a plan that contradicts the code fails the build with the ' +
      'read that caused it named. It is not a build configuration.',
    see: [{ label: 'What a route declares', href: '/guide/declarations' }],
  },
  {
    term: 'Plugin',
    short: 'An addition to a request that declares what it reads and provides. Ordered by inference.',
    body:
      'A port replaces; a plugin adds. Because each one declares its reads and provisions, the order is ' +
      'derived rather than configured — and a cycle or an ambiguity is a build error rather than a race. ' +
      'The one thing no plugin may do is write a cache key.',
    see: [{ label: 'Deploying', href: '/guide/deploying' }],
  },
  {
    term: 'Port',
    short:
      'A capability the kernel refuses to implement: store, session, flags, executor, transport, registry.',
    body:
      'A port has one implementation at a time, and swapping it changes where something happens rather ' +
      'than adding to it. Plugins are the other axis: they extend a request, declare what they read and ' +
      'provide, and their ordering is inferred from those declarations.',
    see: [{ label: 'Ports, config and the build', href: '/guide/deploying' }],
  },
  {
    term: 'Profile',
    short: 'A recording of what renders cost, which decides delivery and nothing else.',
    body:
      'Samples per route and per slot, renders kept apart from cache hits, written while serving. The next ' +
      'build plans streaming and priority from it. What it may never touch is placement, cache classes or ' +
      'keys: a recording of last Tuesday has no standing over what the compiler proved.',
    see: [{ label: 'Measuring', href: '/guide/measuring' }],
  },
  {
    term: 'Region',
    short: 'A slot on a page whose renderer may live on another deployment.',
    body:
      'From the kernel’s point of view a region is a local async function; the boundary is the executor the ' +
      'registry named one level in. That is the design’s claim that a tier boundary is a port ' +
      'implementation and not a second render path.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Registry',
    short: 'A port that resolves a region name to whatever is serving it right now.',
    body:
      'The indirection that makes composition ordinary: a shell composes the name <code>search</code>, and ' +
      'what answers is a deployment decision rather than a URL in a template. <code>weft verify</code> asks ' +
      'the registry, and <code>--probe</code> asks the remotes themselves.',
    see: [{ label: 'Composition', href: '/guide/composition' }],
  },
  {
    term: 'Renderable',
    short: 'A fragment a browser is allowed to ask for by opaque id. A closed set.',
    body:
      'Everything else is unreachable from the client, which is what makes "the client may request a ' +
      'render" safe to offer at all. The id is derived rather than declared, so it discloses nothing about ' +
      'the module it came from.',
    see: [{ label: 'The client', href: '/guide/the-client' }],
  },
  {
    term: 'Sealed template',
    short: 'Pre-encoded UTF-8 segments with holes, and a version that is a hash of its content.',
    body:
      'Sealed because nothing can change it after compilation: the version is a content address, so two ' +
      'renders of the same template with the same values are the same bytes by construction. It is data, ' +
      'which is what lets a client hold one and be sent only values.',
    see: [{ label: 'Fragments', href: '/guide/fragments' }],
  },
  {
    term: 'Shell',
    short: 'The document a route renders into. May be a chain of nested layouts.',
    body:
      'Its <code>&lt;slot&gt;</code> holes are the boundaries the route’s slots fill, and the two sets have ' +
      'to agree exactly. A chain’s boundaries are the union of its layers minus the holes the links fill, ' +
      'and its reads are the union of what every layer reads.',
    see: [{ label: 'Layouts', href: '/guide/layouts' }],
  },
  {
    term: 'Signal',
    short: 'Client-owned state. The server renders its initial value; the browser owns it after adoption.',
    body:
      'The graph is pull-based with linked edges: setting a signal marks its readers stale and nothing ' +
      'recomputes until it is read. A value computed from a signal is <em>derived</em>, and its expression ' +
      'travels on the wire as a tree rather than as code.',
    see: [{ label: 'The client', href: '/guide/the-client' }],
  },
  {
    term: 'Slot',
    short: 'A hole in a document that the render does not own. Not a Vue slot and not shadow DOM.',
    body:
      'The point is not layout, it is delivery: the bytes before a slot can be on the wire before anything ' +
      'is known about what fills it. A fragment that reads something slow becomes a hole by construction, ' +
      'which is why a first byte is never downstream of a slow query.',
    see: [{ label: 'Slots and streaming', href: '/guide/slots-and-streaming' }],
  },
  {
    term: 'Staging',
    short: 'Data that has arrived and resolved and has not been painted.',
    body:
      'An epoch one level up: a whole route fetched behind a link, committed by the click. A staged route ' +
      'that is never committed was never painted, so there is nothing to roll back — and a destination ' +
      'that is not the same document is a full navigation rather than a swap.',
    see: [{ label: 'Instant navigation', href: '/guide/navigation' }],
  },
  {
    term: 'Taint',
    short: 'What a read leaves on a fragment. The taint set is the cache key.',
    body:
      'Every <code>ctx</code> call taints, and nothing else does: <code>cookie:currency</code>, ' +
      '<code>identity</code>, <code>time</code>, <code>device</code>. A read the compiler cannot name ' +
      'statically is <code>E_UNTRACKED_EFFECT</code> — refused, because a key with a hole in it is one ' +
      'reader’s bytes in another reader’s cache.',
    see: [{ label: 'Effects and cache', href: '/guide/effects-and-cache' }],
  },
  {
    term: 'Tier',
    short: 'How far down the stack a request gets answered. L0 is a file; the kernel is not invoked.',
    body:
      'A page whose fragments read nothing is resolved at build time and written out. One that reads a ' +
      'low-cardinality axis can be written per value. Everything else is served by the kernel, and a page ' +
      'that could not join the file tier is refused by name with the read that caused it.',
    see: [{ label: 'Deploying', href: '/guide/deploying' }],
  },
  {
    term: 'Wave',
    short: 'A round of slots dispatched concurrently. A slot that needs another lands in a later one.',
    body:
      'The scheduler reads <code>needs</code> declarations and derives the rounds, so a data dependency is ' +
      'a fact rather than an ordering somebody maintained. Watch the waves rather than the sum: four ' +
      'panels of very different cost do not add up.',
    see: [{ label: 'Slots and streaming', href: '/guide/slots-and-streaming' }],
  },
  {
    term: 'Wire form',
    short: 'How a region’s update is encoded: html, patch or delta. Negotiated, and proven equivalent.',
    body:
      'Every form of a fragment must produce identical bytes, and the benchmark harness refuses to publish ' +
      'a number until it has checked that they do. Which form is used depends on what the client can prove ' +
      'it holds, not on a preference.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Warp',
    short: 'The frame protocol between server and client. Versioned independently of the framework.',
    body:
      'Negotiation, frames for templates, regions, epochs, staleness and intents, over any of three ' +
      'bindings: a socket, an event stream with posts up, or a plain response. A wire format cannot be ' +
      'versioned retroactively, which is why it shipped before the framework did.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
  },
  {
    term: 'Wiring',
    short: 'The list of places in a template where a value reaches the DOM. What the client attaches.',
    body:
      'One entry per binding site — a text position, an attribute, a property, an event that names an ' +
      'intent — emitted by the compiler and walked once on adoption. This is the cost model: a page ships ' +
      'as many entries as it has live bindings, not as many as it has components. The facts panel under ' +
      'every example on this site lists them.',
    see: [{ label: 'The client', href: '/guide/the-client' }],
  },
]

export function glossaryBody(): string {
  return (
    prose(
      'Every entry here is a word this framework uses in a way another framework does not. A reader who ' +
        'maps one onto what they already know will be wrong in a way the surrounding prose does not correct.',
    ) +
    note(
      'careful',
      'Four of these are false friends',
      '<strong>Slot</strong> is about delivery, not layout. <strong>Delta</strong> is not a DOM diff. ' +
        '<strong>Plan</strong> is not a build configuration. And hydration does not happen at all — the ' +
        'word for what replaces it is <strong>adoption</strong>.',
    ) +
    `<div class="terms">` +
    TERMS.map(
      (term) => `<section class="term" id="${slug(term.term)}">
      <h2><a class="anchor" href="#${slug(term.term)}">${escapeHtml(term.term)}</a></h2>
      <p class="short">${term.short}</p>
      <p>${term.body}</p>
      ${
        term.see?.length
          ? `<p class="hint">See ${term.see
              .map((link) => `<a href="${link.href}">${escapeHtml(link.label)}</a>`)
              .join(', ')}</p>`
          : ''
      }
    </section>`,
    ).join('') +
    `</div>`
  )
}

export function slug(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
