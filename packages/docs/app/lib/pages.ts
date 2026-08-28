import type { Example } from './example.ts'
import { votes } from '../intents/feedback.ts'

/**
 * The guide, as a list.
 *
 * Every page names the spec documents it is the introduction to, and `test/docs.test.ts` checks that
 * relation in both directions: a name that does not exist fails, and a spec document no page
 * introduces fails too. So "the guide covers the framework" is a gate rather than a claim, and
 * shipping a mechanism means writing the page that introduces it in the same change.
 *
 * What the three things still are, because covering a document is not being it:
 *
 * - **This site** is the introduction: what the thing is, in order, with examples that run.
 * - **`spec/`** is the reference: the mechanism, its refusals, and what it deliberately does not do.
 * - **`@weftjs/inspector`** is the live version: a station per mechanism, with a control. Its own test
 *   is the one that fails when a capability ships without coverage.
 */
export interface Page {
  /** The URL segment under `/guide`, and the route file's name. */
  slug: string
  title: string
  /** One sentence, shown on the landing page and as the page's lede. */
  lede: string
  group: 'start' | 'render' | 'deliver' | 'change' | 'operate'
  /** Spec documents this page introduces. Checked both ways: it must exist, and it must be named. */
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
    examples: [
      {
        id: 'examples/crumbs',
        title: 'What a wildcard route renders',
        shows:
          'The file is <code>routes/docs/[...].tsx</code> and the path it matched is data — so a breadcrumb is a list hole, and nothing in it knows how deep the URL was.',
        values: {
          trail: [
            { href: '/', label: 'Home' },
            { href: '/guide', label: 'Guide' },
          ],
          here: 'An application is a folder',
        },
      },
    ],
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
    slug: 'scoped-styles',
    title: 'A component’s own stylesheet',
    lede: 'Name a sheet .scoped.css and its selectors reach the elements that component declares, and nothing else on the page.',
    group: 'render',
    covers: ['compiler/scoped-styles.md'],
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
    examples: [
      {
        id: 'examples/feed',
        title: 'A region that cannot be part of the shell',
        shows:
          'Reading the clock taints <code>time</code>, which forces a TTL. The rows are one template projected per item, so what arrives late is values rather than markup.',
        values: {
          count: 3,
          items: [
            { id: 1, title: 'Olive oil, 2L', price: 14 },
            { id: 2, title: 'Basmati rice, 5kg', price: 9 },
            { id: 3, title: 'Medjool dates, 1kg', price: 12 },
          ],
        },
        note: 'The facts below list <code>time</code> as the read. That single entry is why a policy with no <code>ttl</code> on this route is a build error.',
      },
    ],
  },
  {
    slug: 'where-it-runs',
    title: 'Where a render runs, and what it may cost',
    lede: 'Render is a DAG rather than a tree walk, executors are crash domains, and a budget is only a limit where something can be preempted.',
    group: 'deliver',
    covers: ['kernel/locus.md'],
    examples: [
      {
        id: 'examples/placeholder',
        title: 'What a region sends when it is out of budget',
        shows:
          'No holes at all: this template is constant, so rendering it is a buffer copy. A fallback that had to query something could fail the way the region it stands in for did.',
        note: 'Declared as a slot’s <code>placeholder</code>. The page is still a page, and the part that is missing says so.',
      },
    ],
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
    slug: 'measuring',
    title: 'A plan generated from measurement',
    lede: 'The file tree cannot say what anything costs, and delivery is a decision about cost. So record it, and let the recording decide.',
    group: 'deliver',
    covers: ['plan/profile.md'],
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
    slug: 'navigation',
    title: 'Instant navigation',
    lede: 'A route fetched, parsed, and painting nothing, committed by a click.',
    group: 'change',
    covers: ['client/navigation.md'],
    examples: [
      {
        id: 'examples/links',
        title: 'Ordinary anchors',
        shows:
          'Nothing here opts into staging. A link is a link, and what the client does behind it is a deployment’s decision rather than an author’s.',
        values: {
          links: [
            { href: '/guide/the-client', label: 'The client', here: false },
            { href: '/guide/navigation', label: 'Instant navigation', here: true },
            { href: '/guide/intents', label: 'Intents', here: false },
          ],
        },
        note: 'A page that links nowhere never carries the staging model. That is why this is an anchor rather than a component.',
      },
    ],
  },
  {
    slug: 'intents',
    title: 'Intents: the only thing that writes',
    lede: 'A render cannot write. Mutations are intents, addressed by an opaque id, with their writes declared.',
    group: 'change',
    covers: ['kernel/intents.md', 'kernel/authority.md'],
    examples: [
      {
        id: 'examples/helpful',
        title: 'A mutation with no JavaScript at all',
        shows:
          'A form, a hidden field and a POST to the route the intent manifest generated. This one is live: pressing it dispatches a real intent in this process.',
        // The real tally, not a literal. `votes` is exported by the intent module for this, and until
        // this line called it the number on the page was a constant `0` — so every press dispatched
        // a real intent, incremented a real counter, redirected back, and showed zero.
        values: () => ({ page: 'intents', count: votes('intents') }),
        note:
          'Phase A dispatch is what makes a real status, an <code>HttpOnly</code> cookie and a 303 available — the ' +
          'three things a <code>fetch</code> handler cannot give you. The count is real, it is this process’s, and ' +
          'it moves when you press the button — which took three declarations agreeing. The intent names ' +
          '<code>docs.votes</code> in <code>writes</code>, so <code>ctx.revalidate</code> may fire it. The body is ' +
          'a <code>live</code> region tagged with the same name, so the write drops it. And <em>the route carries ' +
          'that tag too</em>: a document held for an hour under no tag is a second cache the invalidation cannot ' +
          'reach, and while it was missing every layer here worked perfectly and the number stayed at zero. ' +
          '<code>W_DOCUMENT_OUTLIVES_INVALIDATION</code> exists so the next person is told instead of guessing. ' +
          'The cost is named too: this page is <code>L0_LIVE</code> rather than a file, which is the trade a page ' +
          'about writing has a reason to make and the other twenty-one guide pages do not.',
      },
    ],
  },
  {
    slug: 'live-regions',
    title: 'Live regions and the channel',
    lede: 'A region can be refreshed over a channel, and the smallest honest form is a delta computed once for every client on the same base.',
    group: 'change',
    covers: ['kernel/surgical.md', 'kernel/transport.md', 'warp/warp-1.md'],
    examples: [
      {
        id: 'examples/prices',
        title: 'One template, three wire forms',
        shows:
          'The same fragment, and one price changed. The table under it is the three encodings measured on this render rather than quoted from a benchmark.',
        values: {
          heading: 'Your basket',
          total: 35,
          lines: [
            { sku: 'OIL-2L', name: 'Olive oil, 2L', price: 14 },
            { sku: 'RICE-5', name: 'Basmati rice, 5kg', price: 9 },
            { sku: 'DATE-1', name: 'Medjool dates, 1kg', price: 12 },
          ],
        },
      },
    ],
  },
  {
    slug: 'what-ships',
    title: 'What the page downloads',
    lede: 'Entries, not a bundle — and a ceiling per entry, because one number over several jobs is a label rather than a gate.',
    group: 'change',
    covers: ['kernel/budgets.md', 'FINDINGS.md'],
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
  {
    slug: 'composition',
    title: 'A region that lives somewhere else',
    lede: 'A shell is a fragment tree whose leaves are regions, and a region is a fragment that happens to render on another deployment.',
    group: 'operate',
    covers: ['kernel/composition.md'],
    examples: [
      {
        id: 'examples/remote',
        title: 'A region, and nothing in it about being remote',
        shows:
          'There is nothing to add. What crosses the boundary is a warp frame — the protocol every render already produces — so the composite does not learn a second runtime.',
        values: {
          query: 'olive oil',
          hits: [
            { sku: 'OIL-2L', name: 'Olive oil, 2L' },
            { sku: 'OIL-5L', name: 'Olive oil, 5L' },
          ],
        },
      },
    ],
  },
  {
    slug: 'devices',
    title: 'Every surface at once',
    lede: 'Nothing here fails on an old engine. Every missing capability costs a wire form, a fill mechanism, or an animation.',
    group: 'operate',
    covers: ['baseline/devices.md'],
    examples: [
      {
        id: 'examples/device',
        title: 'A read with three values is an axis',
        shows:
          'Low cardinality is what lets a read become an ahead-of-time permutation rather than a branch taken per request.',
        note: 'The facts below show <code>device</code> in the read set. The plan can carry a branch per value; the fragment does not know which one it is rendered for.',
      },
    ],
  },
  {
    slug: 'versioning',
    title: 'Versions, and what may change',
    lede: 'Two artifacts were versioned before there was a framework, because a wire format cannot be versioned retroactively.',
    group: 'operate',
    covers: ['VERSIONING.md'],
    examples: [],
  },
  {
    slug: 'testing',
    title: 'Checking your own application',
    lede: 'A fragment is data, so testing one needs no browser, no server and no snapshot to keep in sync.',
    group: 'operate',
    covers: ['FINDINGS.md'],
    examples: [],
  },
  {
    slug: 'cli',
    title: 'The CLI',
    lede: 'Nine commands, and this page is generated from the one that prints them — so it cannot describe a flag that does not exist.',
    group: 'operate',
    covers: [],
    examples: [],
  },
]

export const BY_SLUG: Record<string, Page> = Object.fromEntries(PAGES.map((page) => [page.slug, page]))

/**
 * The five groups, and what each one is about.
 *
 * The `says` line is not decoration: the groups are the reading order, and a reader deciding where
 * to start is choosing between "what the thing is" and "the client, and the only thing allowed to
 * write" rather than between two nouns.
 */
export const GROUPS: { id: Page['group']; label: string; says: string }[] = [
  { id: 'start', label: 'Start here', says: 'what the thing is' },
  { id: 'render', label: 'Rendering', says: 'what a fragment is, and what it compiles to' },
  { id: 'deliver', label: 'Delivery', says: 'reads, keys, streaming, and where a render runs' },
  { id: 'change', label: 'Change', says: 'the client, and the only thing allowed to write' },
  { id: 'operate', label: 'Operating it', says: 'ports, tiers, devices, versions' },
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

/** The group label a page belongs to — the middle crumb. Empty for a slug that has no page. */
export function groupOf(slug: string): string {
  const page = BY_SLUG[slug]
  return page ? (GROUPS.find((group) => group.id === page.group)?.label ?? '') : ''
}
