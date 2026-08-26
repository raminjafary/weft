import type { Example } from './example.ts'

/**
 * The guide, as a list.
 *
 * Every page names the spec documents it is the introduction to, and `test/docs.test.ts` refuses a
 * name that does not exist — so a page cannot point at a document that has been renamed. What the
 * test deliberately does *not* require is that every spec document has a page: three things in this
 * repository have three jobs, and pretending one of them is all three is how a documentation site
 * turns into a worse copy of a reference.
 *
 * - **This site** is the introduction: what the thing is, in order, with examples that run.
 * - **`spec/`** is the reference: the mechanism, its refusals, and what it deliberately does not do.
 * - **`@weft/inspector`** is the live version: a station per mechanism, with a control. Its own test
 *   is the one that fails when a capability ships without coverage.
 */
export interface Page {
  /** The URL segment under `/guide`, and the route file's name. */
  slug: string
  title: string
  /** One sentence, shown on the landing page and as the page's lede. */
  lede: string
  group: 'start' | 'render' | 'deliver' | 'change' | 'operate'
  /** Spec documents this page introduces. Checked for existence, not for coverage. */
  covers: readonly string[]
  /** Examples this page renders, in order. Every one is compiled by this application. */
  examples: readonly Example[]
}

export const PAGES: readonly Page[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    lede: 'A folder is an application. Three files and one command.',
    group: 'start',
    covers: [],
    examples: [
      {
        id: 'examples/badge',
        title: 'The smallest fragment',
        shows: 'One hole, one sealed template. This is the unit everything else is made of.',
        values: { label: 'new' },
        note: 'Open the file at that path. Nothing else produced the markup beside it.',
      },
    ],
  },
  {
    slug: 'an-application',
    title: 'An application is a folder',
    lede: 'The route table is the file tree, and the plan that places everything on a page is generated from it.',
    group: 'start',
    covers: ['kernel/routing.md'],
    examples: [],
  },
  {
    slug: 'fragments',
    title: 'Fragments and templates',
    lede: 'A fragment compiles to a sealed template: pre-encoded bytes with holes, and a version that is a hash of its content.',
    group: 'render',
    covers: ['ir/template-ir-2.md', 'compiler/supported-subset.md'],
    examples: [
      {
        id: 'examples/total',
        title: 'Escape elision is a type question',
        shows:
          'Two holes, one annotation apart. Open the facts below: <code>count</code> is <code>proven-safe</code> and <code>name</code> is <code>escape</code>, and nothing in the file said so.',
        values: { name: 'Olive oil', count: 3 },
        note: 'This is why the examples here are real files: elision needs a checker, and a snippet nobody type-checked has no types to elide by.',
      },
      {
        id: 'examples/list',
        title: 'A list is one row template',
        shows: 'Three rows, two sealed templates. Page weight tracks content rather than markup.',
        values: {
          rows: [
            { sku: 'OIL-2L', name: 'Olive oil, 2L', price: 14 },
            { sku: 'RICE-5', name: 'Basmati rice, 5kg', price: 9 },
            { sku: 'DATE-1', name: 'Medjool dates, 1kg', price: 12 },
          ],
        },
      },
    ],
  },
  {
    slug: 'components',
    title: 'One fragment inside another',
    lede: 'A tag is resolved to a sealed template at build time, not mounted at runtime.',
    group: 'render',
    covers: ['compiler/supported-subset.md'],
    examples: [
      {
        id: 'examples/card',
        title: 'A component hole',
        shows:
          'The card renders the badge. Two sealed templates, and the instance is a projection of the caller’s values rather than a value of its own.',
        values: { title: 'Olive oil, 2L', label: 'new' },
        note: 'Which is what keeps a component transparent to a delta: a change to the parent binding is a change to the child’s hole, with no path syntax to invent.',
      },
    ],
  },
  {
    slug: 'effects-and-cache',
    title: 'What a fragment reads decides everything',
    lede: 'The cache key, the class and the Vary header are derived from the reads the compiler saw. None of them can be declared.',
    group: 'deliver',
    covers: ['compiler/effects.md', 'kernel/cache.md'],
    examples: [
      {
        id: 'examples/greeting',
        title: 'A read becomes a key component',
        shows:
          'One <code>ctx.cookie</code> call. The facts below show <code>cookie:currency</code> in the read set, which is where the cache key and <code>Vary</code> come from.',
        note: 'A read the compiler cannot name statically is <code>E_UNTRACKED_EFFECT</code> — a build error rather than a key with a hole in it.',
      },
      {
        id: 'examples/private',
        title: 'Identity contains itself',
        shows:
          'One <code>ctx.user()</code> read makes this region private. Because it is a slot rather than part of the document, the document stays shared.',
      },
    ],
  },
  {
    slug: 'slots-and-streaming',
    title: 'Slots, and why the shell never waits',
    lede: 'A fragment that reads something slow becomes a hole by construction, so the first byte is never downstream of the query.',
    group: 'deliver',
    covers: ['kernel/streaming.md', 'kernel/lifecycle.md'],
    examples: [],
  },
  {
    slug: 'layouts',
    title: 'Layouts, and documents that nest',
    lede: 'A route names one document. That document may be a chain, and the chain comes from the directory tree.',
    group: 'render',
    covers: ['kernel/routing.md'],
    examples: [],
  },
  {
    slug: 'declarations',
    title: 'What a route declares',
    lede: 'Placement, delivery, cache policy and budgets are declared per route — and checked against what the compiler inferred.',
    group: 'deliver',
    covers: ['plan/plan.md'],
    examples: [],
  },
  {
    slug: 'the-client',
    title: 'Adoption, signals, and what ships',
    lede: 'No hydration: the server-rendered DOM is adopted, and what the client wires is one entry per binding.',
    group: 'change',
    covers: ['client/adoption.md', 'client/signals.md'],
    examples: [
      {
        id: 'examples/signals',
        title: 'A signal and a derived value',
        shows:
          'The derived expression travels as a tree the client evaluates. There is no closure on the wire and no component to hydrate.',
        values: { unitPrice: 14 },
        note: 'The facts below list a wiring entry per node that reads the signal. That is the cost model: bindings, not components.',
      },
    ],
  },
  {
    slug: 'intents',
    title: 'Intents: the only thing that writes',
    lede: 'A render cannot write. Mutations are intents, addressed by an opaque id, with their writes declared.',
    group: 'change',
    covers: ['kernel/intents.md', 'kernel/authority.md'],
    examples: [],
  },
  {
    slug: 'live-regions',
    title: 'Live regions and the channel',
    lede: 'A region can be refreshed over a channel, and the smallest honest form is a delta computed once for every client on the same base.',
    group: 'change',
    covers: ['kernel/surgical.md', 'kernel/transport.md', 'warp/warp-1.md'],
    examples: [],
  },
  {
    slug: 'deploying',
    title: 'Ports, config, and the build',
    lede: 'Ports replace, plugins extend. Fourteen are declared and eleven are bound by the front door with no configuration at all.',
    group: 'operate',
    covers: ['kernel/ports.md', 'kernel/static.md'],
    examples: [],
  },
]

export const BY_SLUG: Record<string, Page> = Object.fromEntries(PAGES.map((page) => [page.slug, page]))

export const GROUPS: { id: Page['group']; label: string }[] = [
  { id: 'start', label: 'Start here' },
  { id: 'render', label: 'Rendering' },
  { id: 'deliver', label: 'Delivery' },
  { id: 'change', label: 'Change' },
  { id: 'operate', label: 'Operating it' },
]

/** The page before and after this one, so a guide reads as a sequence rather than a set. */
export function neighbours(slug: string): { previous?: Page; next?: Page } {
  const index = PAGES.findIndex((page) => page.slug === slug)
  if (index < 0) return {}
  return {
    ...(index > 0 ? { previous: PAGES[index - 1] as Page } : {}),
    ...(index < PAGES.length - 1 ? { next: PAGES[index + 1] as Page } : {}),
  }
}
