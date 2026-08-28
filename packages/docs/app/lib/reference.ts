import { declarationOf, defaultsOf, type Declaration, type Field } from './declared.ts'

/**
 * The declaration surfaces, as a section.
 *
 * The guide explains a mechanism and shows the two or three fields that make the point. That is
 * what a guide is for, and it is not what somebody has in front of them at four in the afternoon
 * with a config file open and a question about one key. Neither was the API page: an interface
 * reaches it as a single signature, so `WeftConfig` arrived truncated at 880 characters with an
 * ellipsis where twenty-nine options should have been, and `RouteModule`'s twenty-eight the same.
 *
 * So this is the other half: one page per thing you write, one entry per field, with the type as
 * written, the default the loader actually applies, and the doc comment its author left above it.
 * Nothing here is prose about the framework — every sentence in an entry came out of the source
 * that implements it, which is what makes the section's claim ("these are all the options") a gate
 * `test/docs.test.ts` can check rather than a promise.
 */
export interface Group {
  /** The interface, in the file that declares it. */
  name: string
  file: string
  /** What a reader calls this: `weft.config.ts`, `slots`, `cache`. */
  title: string
  /** The anchor prefix, so `cache` on two interfaces is two anchors. */
  prefix: string
  /** One sentence about when this group applies. Empty uses the interface's own doc comment. */
  note: string
}

export interface Reference {
  /** URL segment under `/reference`. */
  id: string
  /**
   * What the page is made of.
   *
   * `declaration` is an interface exploded into its members, which is five of the six. The other
   * two are the same section for the same reason — a reader with a config file open wants them —
   * but their source is not an interface: the folder convention is a doc comment the discovery
   * reads out of, and the ports are a walk of two packages.
   */
  kind: 'declaration' | 'directories' | 'ports'
  title: string
  /** What you write, for the rail: `weft.config.ts`, `defineRoute`. */
  label: string
  blurb: string
  /** The paragraphs above the first option. Authored markup, like the guide's prose. */
  opening: readonly string[]
  /** A whole file, annotated, before the options. */
  example: { lang: string; caption: string; code: string }
  groups: readonly Group[]
  /** The file whose `??` expressions are the defaults, when the surface has any. */
  defaults?: string
  /** Where the argument for this surface is made. */
  seeAlso: readonly { href: string; label: string }[]
}

const CONFIG = 'packages/weft/src/config.ts'
const ROUTE = 'packages/weft/src/route.ts'

export const REFERENCES: readonly Reference[] = [
  {
    id: 'config',
    kind: 'declaration',
    title: 'weft.config.ts',
    label: 'weft.config.ts',
    blurb:
      'Every option a deployment may state, with the type it accepts and the default it gets by leaving it out.',
    opening: [
      'A weft application needs no configuration file. Without one it gets an in-process store, a cookie ' +
        'session, no flag axes and <code>inline</code> as its only executor — which is a real deployment for ' +
        'one process and an honest starting point for any other, because the moment a port is bound here ' +
        'nothing else in the application changes.',
      'The file default-exports <code>defineConfig({…})</code>, an identity function that exists for the ' +
        'types so the object is checked as it is written. <code>weft.config.ts</code>, ' +
        '<code>weft.config.js</code> and <code>weft.config.mjs</code> are all looked for, in that order, and ' +
        'the first one found wins. A file that exports something else is ' +
        '<a href="/errors/E_CONFIG_NO_DEFAULT"><code>E_CONFIG_NO_DEFAULT</code></a>.',
      'Every default below is read out of the loader that applies it rather than typed beside it, so a ' +
        'number that changes in the framework changes on this page in the same commit.',
    ],
    example: {
      lang: 'ts',
      caption: 'weft.config.ts — a deployment that binds something',
      code: `import { bySession, defineConfig, redisLeases } from '@weftjs/core'
import { memoryStore, workerPool } from '@weftjs/adapters'

export default defineConfig({
  port: 3000,

  // Where the store lives. Wrapped, so a nonce is spent across every instance.
  store: redisLeases(memoryStore(), { url: process.env.REDIS_URL }),

  // Executors beyond \`inline\` and \`client\`. A slot naming one not bound here fails the build.
  executors: { 'pool:heavy': workerPool({ size: 4 }) },

  // Flag axes. Only a declared axis can be read, so a typo is a build error.
  flags: { 'new-cart': ['off', 'on'] },

  // What a call is counted against. The framework does the counting.
  limits: { counted: bySession },

  // How long a shared cache may serve a prerendered document, and its grace period after.
  documents: { shared: 3600, stale: 86400 },

  // More than one process runs this, so an invalidation has to reach the others.
  instances: 4,

  // Absolute URLs the build cannot derive: the sitemap's entries and every canonical link.
  site: { origin: 'https://example.com' },
})`,
    },
    groups: [
      { name: 'WeftConfig', file: CONFIG, title: 'Options', prefix: '', note: '' },
      {
        name: 'AuthorityConfig',
        file: 'packages/weft/src/authority.ts',
        title: 'authority',
        prefix: 'authority',
        note:
          'What the <code>authority</code> option above takes. Bound, an intent may declare a capability or ' +
          'a signature; unbound, an intent that declares either is refused by name at startup rather than ' +
          'waved through.',
      },
    ],
    defaults: CONFIG,
    seeAlso: [
      { href: '/guide/deploying', label: 'Deploying: ports, plugins and the build' },
      { href: '/guide/composition', label: 'Composition: what a region binding is' },
      { href: '/reference/ports', label: 'Every port, and what implements it' },
    ],
  },
  {
    id: 'route',
    kind: 'declaration',
    title: 'defineRoute',
    label: 'defineRoute',
    blurb:
      'Every field a route’s .data.ts may declare — placement, cache policy, budgets, streaming, regions — and what each one decides.',
    opening: [
      'A route’s <code>.data.ts</code> default-exports <code>defineRoute({…})</code>. It is read at ' +
        '<em>build time</em>, so everything here becomes part of the generated plan rather than a branch ' +
        'taken per request — and everything here is checked against what the compiler inferred from the ' +
        'fragments it places. A declaration that contradicts a derivation loses, at build time, with the ' +
        'read that caused it named.',
      'There is deliberately no cache key. Keys are derived from what a fragment was seen to read, and a ' +
        'declaration that could state one could disagree with the code.',
      'Everything below is optional, and the useful default for most of it is silence: a route with no ' +
        '<code>cache</code> gets the class its fragments’ reads imply, a route with no <code>stream</code> ' +
        'anywhere lowers to in-order delivery and ships no filler script, and a page whose fragments read ' +
        'nothing becomes a file at build time without being asked.',
    ],
    example: {
      lang: 'ts',
      caption: 'app/routes/cart.data.ts',
      code: `import { defineRoute } from '@weftjs/core'
import { loadCart, loadRecommendations } from '../lib/cart.ts'

export default defineRoute({
  head: { title: 'Cart' },
  layoutValues: { heading: 'Your cart' },

  // Checked against the strictest class anything on this page implies.
  cache: { class: 'private' },

  slots: {
    // The route's own file. \`body\` is never given a \`fragment\`.
    body: { load: loadCart, live: true },

    // A later wave: it reads what \`body\` loaded, so the scheduler waits for it.
    recs: {
      fragment: 'cart/recs',
      needs: ['body'],
      load: loadRecommendations,
      stream: { prio: 2 },
      cache: { class: 'public', ttl: '5m', tags: ['recs'] },
      budget: { cpu: '120ms', onExceed: 'degrade' },
      placeholder: 'Loading recommendations…',
    },

    // A fragment that may render on another deployment. Where is the deployment's to say.
    promo: {
      fragment: 'cart/promo',
      region: { remote: true, fallback: 'cart/promo-empty', optional: true },
    },
  },
})`,
    },
    groups: [
      { name: 'RouteModule', file: ROUTE, title: 'The route', prefix: '', note: '' },
      {
        name: 'SlotDeclaration',
        file: ROUTE,
        title: 'slots',
        prefix: 'slot',
        note:
          'One entry per hole the layout leaves. <code>body</code> is the route’s own file and is never ' +
          'given a <code>fragment</code>; every other name has to be a hole the document actually leaves, or ' +
          'the build refuses it with the holes it does leave listed.',
      },
      {
        name: 'CacheDeclaration',
        file: ROUTE,
        title: 'cache',
        prefix: 'cache',
        note:
          'What a slot declares about being held, checked against what its fragment was seen to read. The ' +
          'same shape fills <code>document</code>, which is what the response itself advertises.',
      },
      {
        name: 'BudgetDeclaration',
        file: ROUTE,
        title: 'budget',
        prefix: 'budget',
        note:
          "What a slot may spend, in the spellings a person writes: <code>'120ms'</code>, " +
          "<code>'8kb'</code>.",
      },
      {
        name: 'RegionDeclaration',
        file: ROUTE,
        title: 'region',
        prefix: 'region',
        note:
          'A slot that is a fragment living somewhere else. It declares that there <em>is</em> a boundary ' +
          'and what the shell expects across it — never where, because a shell naming the tier would make ' +
          'rolling that region a redeploy of every shell that names it. Where is ' +
          '<a href="/reference/config#regions"><code>regions</code></a> in the config.',
      },
      {
        name: 'HeadDeclaration',
        file: ROUTE,
        title: 'head',
        prefix: 'head',
        note:
          'What goes in the document head for this route. A function of the params, never of the request — ' +
          'a head that varied per request would vary the document’s cache key.',
      },
    ],
    seeAlso: [
      { href: '/guide/declarations', label: 'Declarations: what a route says' },
      { href: '/guide/slots-and-streaming', label: 'Slots, waves and streaming' },
      { href: '/guide/effects-and-cache', label: 'Effects and the cache key' },
    ],
  },
  {
    id: 'intent',
    kind: 'declaration',
    title: 'defineIntent',
    label: 'defineIntent',
    blurb:
      'Every field a mutation declares: what it writes, who may run it, and how much of it one caller gets.',
    opening: [
      'A render cannot write — that is enforced by the type of the context a render receives — so every ' +
        'mutation is an intent, and intents are the only thing in this framework allowed to change anything.',
      'A module under <code>app/intents/</code> is the manifest. The id a client carries is ' +
        '<code>intentId(module, export)</code>: six hex characters derived from the file path and the export ' +
        'name and from nothing else. So renaming the function changes the wire, and the wire never discloses ' +
        'a function name.',
      'Three of the fields below declare something this deployment has to have bound, and each is refused ' +
        'rather than waved through when it is not: a capability with no check is ' +
        '<a href="/errors/E_NO_CAPABILITY_CHECK"><code>E_NO_CAPABILITY_CHECK</code></a>, a signature with no ' +
        'verifier is <a href="/errors/E_NO_VERIFIER"><code>E_NO_VERIFIER</code></a>, and a limit with nothing ' +
        'counting is <a href="/errors/E_NO_RATE_LIMIT"><code>E_NO_RATE_LIMIT</code></a>.',
    ],
    example: {
      lang: 'ts',
      caption: 'app/intents/cart.ts',
      code: `import { defineIntent } from '@weftjs/core'

export const add = defineIntent<{ sku: string; qty: number }>({
  name: 'cart.add',                  // for logs and \`weft why\`. Never on the wire
  writes: ['cart'],                  // the complete set this may invalidate
  capabilities: ['cart:write'],      // refused unless \`authority\` is bound
  limit: { max: 20, windowMs: 60_000 },
  input: (raw) => parse(raw),        // throwing here is a 422, not a 500
  async run(ctx, { sku, qty }) {
    await db.cart.add(ctx.session, sku, qty)
    await ctx.revalidate('cart')     // an undeclared tag throws
  },
})`,
    },
    groups: [
      { name: 'Intent', file: 'packages/kernel/src/intent.ts', title: 'The intent', prefix: '', note: '' },
    ],
    seeAlso: [
      { href: '/guide/intents', label: 'Intents: the only thing that writes' },
      { href: '/reference/config#authority', label: 'authority: who may run one' },
    ],
  },
  {
    id: 'renderable',
    kind: 'declaration',
    title: 'defineRenderable',
    label: 'defineRenderable',
    blurb:
      'The catalogue: what a browser may ask to have rendered, by opaque id, and the gates that ask passes.',
    opening: [
      'A module under <code>app/renderables/</code> is to a render request what an intent module is to a ' +
        'mutation, down to the derivation: the id is <code>intentId(module, export)</code>, the same six hex ' +
        'characters the compiler writes into a template’s wiring.',
      'A directory rather than a flag on a fragment, because the set of things a <em>client</em> can name is ' +
        'a security boundary and it should be visible in the file tree. <code>app/fragments/</code> holds ' +
        'everything a page composes; this holds what a browser may ask for. Making the second set the first ' +
        'would turn every component in an application into a public endpoint taking arbitrary props.',
      'The id resolves through the registry, so an entry served by this process today can be served by a ' +
        'region on another deployment tomorrow and the client cannot tell.',
    ],
    example: {
      lang: 'ts',
      caption: 'app/renderables/product.ts',
      code: `import { defineRenderable } from '@weftjs/core'

export const details = defineRenderable<{ sku: string }>({
  name: 'product.details',
  fragment: 'product/details',       // or \`region: 'catalogue'\`, resolved by the registry
  capabilities: ['catalogue:read'],
  limit: { max: 60, windowMs: 60_000 },
  input: (raw) => ({ sku: String((raw as { sku: unknown }).sku) }),
  load: (ctx, { sku }) => ctx.services.catalogue.get(sku),
})`,
    },
    groups: [
      {
        name: 'RenderableDeclaration',
        file: 'packages/weft/src/renderables.ts',
        title: 'The renderable',
        prefix: '',
        note: '',
      },
    ],
    seeAlso: [
      { href: '/guide/live-regions', label: 'Live regions and the channel' },
      { href: '/guide/composition', label: 'Composition: regions across deployments' },
    ],
  },
  {
    id: 'directories',
    kind: 'directories',
    title: 'Files and directories',
    label: 'Files and directories',
    blurb: 'Every path the framework gives a meaning to, read out of the convention the discovery walks.',
    opening: [
      'A weft application is a folder. The route table <em>is</em> the file tree, and nothing downstream of ' +
        'it may add a route — <code>weft build</code> generates plans from what the discovery found, and a ' +
        'page that is not in <code>app/routes/</code> does not exist.',
      'The rules are the ones Nuxt, Remix and SvelteKit converged on, because somebody arriving here should ' +
        'not have to learn a third vocabulary for the same idea. What is different is what a file may ' +
        '<em>say</em>, and that is the rest of this section.',
      'The table below is parsed out of the doc comment the discovery keeps beside the walk itself, so a ' +
        'path the framework stops recognising stops appearing here.',
    ],
    example: {
      lang: 'text',
      caption: 'the whole convention, as a tree',
      code: `app/
  layout.tsx              the document. Its <slot> holes are what a route fills
  layouts/error.tsx       the 404 and the 500. Absent means the framework's own
  layouts/<name>.tsx      an alternate document, chosen with defineRoute({ layout })
  client.ts               the application's own client code, loaded after adoption
  styles.css              appended after the framework's own
  routes/index.tsx        /
  routes/about.tsx        /about
  routes/blog/[slug].tsx  /blog/:slug
  routes/docs/[...].tsx   /docs/*
  routes/docs/layout.tsx  wraps every route at or under /docs
  routes/x.data.ts        x.tsx's head, cache policy, loader, guard and slots
  routes/x.css            linked only by the pages that render x
  routes/x.scoped.css     the same, narrowed to the elements x.tsx declares
  slots/<name>.tsx        fills the layout hole of that name on every route
  fragments/<name>.tsx    a component, referenced by name from a route's slots
  intents/**.ts           mutations. The manifest is generated from this directory
  renderables/**.ts       fragments a client may ask for by opaque id
weft.config.ts            what this deployment binds`,
    },
    groups: [],
    seeAlso: [
      { href: '/guide/an-application', label: 'An application is a folder' },
      { href: '/guide/layouts', label: 'Layouts and nested layouts' },
      { href: '/reference/route', label: 'What a .data.ts may declare' },
    ],
  },
  {
    id: 'ports',
    kind: 'ports',
    title: 'Ports and adapters',
    label: 'Ports and adapters',
    blurb: 'Every seam the kernel refuses to know about, what implements it, and which config key binds it.',
    opening: [
      'Everything a framework normally does for you is a <em>port</em> here: the store, the session, the ' +
        'flags, the executors, the registry, the transport. The kernel imports nothing but the WinterTC ' +
        'Minimum Common Web API, so anything that is not the document request path is on the other side of ' +
        'one of these interfaces.',
      'Most of them are bound by the front door with no configuration at all, which is what makes an ' +
        'application with no <code>weft.config.ts</code> a real deployment rather than a demo mode. The ' +
        '<em>Config key</em> column says which ones a deployment can take over, and links to the option ' +
        'that does it.',
      'A port has one implementation at a time, and swapping it changes where something happens. A plugin ' +
        'adds to a request without replacing anything. The one thing neither may do is write a cache key, ' +
        'because a key that can be written by hand is a key that can be written wrongly.',
    ],
    example: {
      lang: 'ts',
      caption: 'binding three of them, and leaving the rest alone',
      code: `import { defineConfig } from '@weftjs/core'
import { envConfig, hostDeployment, tieredStore, memoryStore, kvStore } from '@weftjs/adapters'

export default defineConfig({
  // Two tiers: this process, then the namespace every instance shares.
  store: tieredStore([memoryStore({ max: 500 }), kvStore(env.CACHE)]),

  // Settings from WEFT_-prefixed environment variables. This is also the default.
  config: envConfig({ prefix: 'WEFT_' }),

  // The deployment names itself from whatever the host calls a revision.
  deployment: hostDeployment(),
})`,
    },
    groups: [],
    seeAlso: [
      { href: '/guide/deploying', label: 'Deploying: ports, plugins and the build' },
      { href: '/reference/config', label: 'The config keys that bind them' },
      { href: '/api/adapters', label: '@weftjs/adapters, export by export' },
    ],
  },
]

export const BY_ID: Record<string, Reference> = Object.fromEntries(
  REFERENCES.map((reference) => [reference.id, reference]),
)

export function referenceIds(): string[] {
  return REFERENCES.map((reference) => reference.id)
}

/** One group, read once. A page renders every group and the rail counts them. */
const declarations = new Map<string, Declaration>()

export function groupDeclaration(group: Group): Declaration {
  const key = `${group.file}#${group.name}`
  const held = declarations.get(key)
  if (held) return held
  const value = declarationOf(group.file, group.name)
  declarations.set(key, value)
  return value
}

const defaultTables = new Map<string, Map<string, string>>()

export function defaultsFor(reference: Reference): Map<string, string> {
  if (!reference.defaults) return new Map()
  const held = defaultTables.get(reference.defaults)
  if (held) return held
  const value = defaultsOf(reference.defaults)
  defaultTables.set(reference.defaults, value)
  return value
}

/** `port` on the config, `slot-cache` on a route — unique on the page, and stable in a URL. */
export function anchorOf(group: Group, field: Field): string {
  return group.prefix ? `${group.prefix}-${field.name}` : field.name
}

/** How many fields a reference documents, which is the number the rail and the index show. */
export function fieldCount(reference: Reference): number {
  return reference.groups.reduce((sum, group) => sum + groupDeclaration(group).fields.length, 0)
}
