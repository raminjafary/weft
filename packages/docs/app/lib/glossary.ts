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
    term: 'Cache class',
    short: 'static, shared or private — derived from what a fragment read, never declared.',
    body:
      'A fragment that reads nothing is <code>static</code>; one that reads a cookie, header, locale or ' +
      'flag is <code>shared</code> and keyed by the value; one that reads identity is <code>private</code>. ' +
      'A declaration that contradicts the derivation fails the build, naming the read.',
    see: [{ label: 'Effects and cache', href: '/guide/effects-and-cache' }],
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
    term: 'Plan',
    short: 'A route’s declared placement, delivery and policy — checked against what the compiler inferred.',
    body:
      'Generated from the file convention rather than written by hand. It is validated against the ' +
      'compiler’s facts before it is lowered, so a plan that contradicts the code fails the build with the ' +
      'read that caused it named. It is not a build configuration.',
    see: [{ label: 'What a route declares', href: '/guide/declarations' }],
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
    term: 'Region',
    short: 'A slot on a page whose renderer may live on another deployment.',
    body:
      'From the kernel’s point of view a region is a local async function; the boundary is the executor the ' +
      'registry named one level in. That is the design’s claim that a tier boundary is a port ' +
      'implementation and not a second render path.',
    see: [{ label: 'Live regions', href: '/guide/live-regions' }],
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
    ).join('')
  )
}

export function slug(term: string): string {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
