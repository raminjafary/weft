/**
 * A line or two per field, showing the shape. The only hand-written thing in the reference — the
 * type says what a field accepts and the doc comment says what it's for; this answers the third
 * question, what you actually type. Keyed by `<reference>.<anchor>`. `docs.test.ts` checks these for
 * renamed exports, same as it does the guide's sketches.
 */
export const EXAMPLES: Record<string, string> = {
  // ── weft.config.ts ─────────────────────────────────────────────────────────
  'config.srcDir': `srcDir: 'src'`,
  'config.outDir': `outDir: 'dist'`,
  'config.css': `css: ['./styles/theme.css', './styles/print.css']`,
  'config.nav': `nav: [
  { href: '/docs', label: 'Docs' },
  { href: '/pricing', label: 'Pricing' },
]`,
  'config.documents': `// A deploy purges the CDN in front of this app, so a prerendered page may be
// answered from the edge for an hour, then served stale for a day while it refreshes.
documents: { shared: 3600, stale: 86400 }`,
  'config.store': `import { memoryStore, tieredStore, kvStore } from '@weftjs/adapters'

// Two tiers: this process first, then the namespace every instance shares.
store: tieredStore([memoryStore({ max: 500 }), kvStore(env.CACHE)])`,
  'config.flags': `// Only a declared axis can be read, so \`ctx.flag('checkout')\` is a build error.
flags: { 'new-cart': ['off', 'on'], theme: ['light', 'dark'] }`,
  'config.session': `// Two applications behind one host cannot both be \`sid\`.
session: { cookie: 'shop_sid' }`,
  'config.executors': `import { workerPool, svcExecutor } from '@weftjs/adapters'

executors: {
  'pool:heavy': workerPool({ size: 4 }),
  'svc:search': svcExecutor({ url: 'https://search.internal' }),
}`,
  'config.telemetry': `import { collectingTelemetry } from '@weftjs/adapters'

telemetry: collectingTelemetry()`,
  'config.regions': `// A route says \`region: { remote: true }\` and calls the slot \`search\`.
// This says what \`search\` is right now.
regions: [
  { name: 'search', url: 'https://search.internal', rev: '2026-08-01' },
  { name: 'promo', url: 'https://promo.internal', rev: '2026-08-14' },
]`,
  'config.registry': `import { manifestRegistry } from '@weftjs/adapters'

// Asked first; \`regions\` above answers a name it does not resolve.
registry: manifestRegistry({ url: process.env.REGION_MANIFEST_URL })`,
  'config.config': `import { envConfig, staticConfig } from '@weftjs/adapters'

// The default. \`staticConfig({ … })\` is the one to bind in a test.
config: envConfig({ prefix: 'WEFT_' })`,
  'config.deployment': `import { hostDeployment } from '@weftjs/adapters'

deployment: hostDeployment()`,
  'config.db': `import { boundedDb } from '@weftjs/adapters'

// A loader that hangs is a slot that degrades, not a request that never ends.
db: boundedDb({ deadlineMs: 800 })`,
  'config.limits': `import { bySession, byAddress } from '@weftjs/core'

// The framework counts, in a fixed window, against the store this deployment bound.
limits: { counted: bySession }

// Or own the counting outright, with a gateway or a Redis script:
// limits: myGatewayLimiter`,
  'config.channel': `// A serverless function terminates no upgrade and outlives no request.
channel: { path: '/_weft/channel', hold: false }`,
  'config.instances': `// Four processes, so \`fanout\` below is what makes an invalidation reach the other three.
instances: 4`,
  'config.site': `// What \`weft site\` writes into the sitemap, and every page's <link rel="canonical">.
site: { origin: 'https://example.com' }`,
  'config.fanout': `import { memoryFanout } from '@weftjs/adapters'

// Needed exactly when \`instances\` is more than one, and inert when it is one.
fanout: memoryFanout({ url: process.env.REDIS_URL })`,
  'config.journal': `import { memoryStore } from '@weftjs/adapters'
import { storeJournal } from '@weftjs/kernel'

// Worth binding when this deployment serves turns and something writes.
journal: storeJournal(memoryStore())`,
  'config.authority': `authority: {
  grants: { editor: ['post:*'], admin: ['post:*', 'user:*'] },
  roles: (subject) => db.roles.of(subject),
}`,
  'config.navigation': `// For an app where the position *is* the reader's place: a long list with a
// filter in the URL. One link at a time can say \`data-weft-scroll="preserve"\`.
navigation: { scroll: 'preserve' }`,
  'config.maxConcurrency': `// Forty queries from one page will melt a database.
maxConcurrency: 4`,
  'config.types': `// Correct, and slower: every hole gets a runtime escape.
types: false`,
  'config.profile': `// Writes .weft/profile.json as it serves. The next build reads it.
profile: process.env.WEFT_ENV === 'staging'`,
  'config.devtools': `// \`weft dev\` only. \`weft start\` refuses by name rather than serving your route table.
devtools: true`,

  // ── authority ──────────────────────────────────────────────────────────────
  'config.authority-grants': `grants: {
  // \`cart:*\` covers every capability under \`cart:\`. A bare \`*\` is refused.
  user: ['cart:read', 'cart:write'],
  admin: ['cart:*', 'order:*'],
}`,
  'config.authority-roles': `roles: async (subject) => (await db.user.find(subject))?.roles ?? []`,
  'config.authority-ambient': `// Where a deliberately public capability goes.
ambient: ['catalogue:read']`,
  'config.authority-anonymous': `anonymous: 'guest'`,
  'config.authority-signing': `import { generateSigningKeys } from '@weftjs/core'

// \`generateSigningKeys()\` prints a pair for a deployment that has none yet.
signing: {
  kid: '2026-08',
  privateKey: process.env.INTENT_SIGNING_KEY,
  publicKeys: { '2026-08': process.env.INTENT_PUBLIC_KEY, '2026-02': OLD_PUBLIC_KEY },
  ttlMs: 60_000,
}`,
  'config.authority-audit': `// A log of denials only is one an escalation is silent in.
audit: ({ allowed, subject, missing }) => log.info('authz', { allowed, subject, missing })`,

  // ── defineRoute ────────────────────────────────────────────────────────────
  'route.layout': `// app/layouts/wide.tsx wraps this page instead of app/layout.tsx.
layout: 'wide'`,
  'route.head': `head: (params) => ({
  title: \`\${params.slug} — Blog\`,
  description: 'One post.',
  meta: { 'og:type': 'article' },
})`,
  'route.layoutValues': `// The layout leaves a \`heading\` hole the framework knows nothing about.
layoutValues: (params) => ({ heading: params.category ?? 'Everything' })`,
  'route.load': `load: async (ctx, params) => ({ post: await ctx.services.posts.get(params.slug) })`,
  'route.cache': `cache: { class: 'public', ttl: '5m', tags: ['posts'] }`,
  'route.document': `// What the response advertises, checked against the strictest class on the page.
document: { class: 'public', ttl: '1m', swr: '10m' }`,
  'route.stream': `stream: { prio: 1 }`,
  'route.incremental': `incremental: true`,
  'route.speculate': `// Warm it whenever its entry is in the last fifth of its life.
speculate: true`,
  'route.live': `live: true`,
  'route.placeholder': `placeholder: 'Loading your cart…'`,
  'route.executor': `executor: 'pool:heavy'`,
  'route.budget': `budget: { cpu: '120ms', js: '8kb', onExceed: 'placeholder' }`,
  'route.budgetFor': `// A page whose subject *is* the budget: move it and watch the exceed policy.
budgetFor: ({ query }) => ({ cpu: query.get('cpu') ?? '120ms', onExceed: 'degrade' })`,
  'route.refresh': `refresh: '30s'`,
  'route.form': `form: { prefer: 'delta', fallback: 'html' }`,
  'route.guard': `// Phase A, so this redirect is a real redirect rather than a mid-stream apology.
guard: async (ctx) => Boolean(await ctx.user())`,
  'route.redirect': `redirect: '/sign-in'`,
  'route.status': `status: 404`,
  'route.slots': `slots: {
  body: { load: loadCart },
  aside: { fragment: 'cart/summary', needs: ['body'] },
}`,
  'route.maxConcurrency': `maxConcurrency: 2`,
  'route.order': `// The exception is a page whose *subject* is the difference between the two orders.
order: (params) => (params.mode === 'stream' ? 'out-of-order' : 'in-order')`,
  'route.etag': `// Only on a page whose slots all buffer: declaring it on one that streams is E_ETAG_STREAMS.
etag: true`,
  'route.static': `static: false,
notStaticBecause: 'the head reads ?src, which the invariance probe cannot invent'`,
  'route.notStaticBecause': `notStaticBecause: 'renders a per-request nonce into the CSP'`,
  'route.params': `// This is what makes a parameterised page a file: two values, two URLs, two files.
params: { category: ['books', 'music'] }`,
  'route.expose': `// \`qty * unitPrice\` recomputed in the browser already sends \`unitPrice\`.
// This is for a value the browser needs for a reason the template cannot show.
expose: ['currency']`,
  'route.exposes': `// The only channel between a shell and the regions inside it.
// A region declaring \`consumes: ['locale']\` on a page that exposes nothing is a build error.
exposes: ['locale', 'cartCount']`,

  // ── slots ──────────────────────────────────────────────────────────────────
  'route.slot-fragment': `// app/fragments/cart/items.tsx
fragment: 'cart/items'`,
  'route.slot-load': `load: (ctx, params) => ({ items: ctx.services.cart.of(params.id) })`,
  'route.slot-html': `// Markup rather than content: a control panel, a readout. Goes through raw().
html: (ctx, params) => \`<p class="hint">\${params.id}</p>\``,
  'route.slot-cache': `cache: { class: 'public', ttl: '1h', tags: ['catalogue'], consistency: 'strong' }`,
  'route.slot-stream': `// A lower number arrives first. \`false\` buffers.
stream: { prio: 2 }`,
  'route.slot-incremental': `// A large template whose values mostly do not move: only the changed holes cost bytes.
incremental: true`,
  'route.slot-speculate': `speculate: 'profile'`,
  'route.slot-executor': `executor: 'svc:search'`,
  'route.slot-budget': `budget: { cpu: '80ms', onExceed: 'fallback' }`,
  'route.slot-budgetFor': `budgetFor: ({ query }) => ({ cpu: \`\${query.get('ms') ?? 80}ms\` })`,
  'route.slot-placeholder': `placeholder: '<div class="skeleton" aria-hidden="true"></div>'`,
  'route.slot-refresh': `// Only does anything on a \`live\` slot: the refresh travels over the channel.
live: true,
refresh: '15s'`,
  'route.slot-form': `form: { prefer: 'patch', fallback: 'html' }`,
  'route.slot-needs': `// A data dependency, so the scheduler puts this slot in a later wave.
needs: ['items']`,
  'route.slot-live': `// An intent writing one of this slot's tags produces a STALE frame
// for exactly the connections showing it.
live: true,
cache: { class: 'public', ttl: '1m', tags: ['cart'] }`,
  'route.slot-region': `region: { remote: true, fallback: 'search/empty', consumes: ['locale'] }`,

  // ── cache, budget, region, head ────────────────────────────────────────────
  'route.cache-class': `class: 'private'`,
  'route.cache-ttl': `ttl: '5m'   // or 300_000`,
  'route.cache-swr': `swr: '1h'`,
  'route.cache-tags': `tags: ['cart', 'prices']`,
  'route.cache-consistency': `consistency: 'strong'`,
  'route.budget-cpu': `cpu: '120ms'`,
  'route.budget-js': `js: '8kb'`,
  'route.budget-grow': `grow: '512b'`,
  'route.budget-onExceed': `onExceed: 'placeholder'`,
  'route.region-remote': `// \`true\` describes nothing, which is legal and expensive: an undescribed
// region reads \`opaque\`, so the document containing it is uncacheable.
remote: { serves: 'search results', form: 'html' }`,
  'route.region-fallback': `fallback: 'search/unavailable'`,
  'route.region-optional': `optional: true`,
  'route.region-csp': `csp: { 'script-src': ["'self'", 'https://maps.example.com'] }`,
  'route.region-consumes': `// Checked against the shell's own \`exposes\`.
consumes: ['locale']`,
  'route.region-critical': `// Ours, and in the first flush. A remote region may not be critical.
critical: true`,
  'route.head-title': `title: 'Your cart'`,
  'route.head-description': `description: 'What you are about to buy.'`,
  'route.head-meta': `meta: { 'og:image': '/card.png', robots: 'noindex' }`,

  // ── defineIntent ───────────────────────────────────────────────────────────
  'intent.name': `name: 'cart.add'`,
  'intent.writes': `// The complete set. \`ctx.revalidate('orders')\` from here throws.
writes: ['cart', 'cart-count']`,
  'intent.reads': `reads: ['session']`,
  'intent.capabilities': `// Refused as E_NO_CAPABILITY_CHECK unless \`authority\` is bound.
capabilities: ['cart:write']`,
  'intent.signed': `// A token this deployment minted. There is no no-JavaScript path for a signed intent.
signed: true`,
  'intent.input': `// Throwing here is E_INTENT_INPUT — a 422, not a 500.
input: (raw) => {
  const { sku, qty } = raw as { sku: unknown; qty: unknown }
  if (typeof sku !== 'string') throw new Error('sku must be a string')
  return { sku, qty: Number(qty) || 1 }
}`,
  'intent.limit': `// What it is counted *against* is the deployment's, in \`limits\`.
limit: { max: 20, windowMs: 60_000 }`,
  'intent.invalidatesAll': `// Every tag in \`writes\`, without naming them a second time.
invalidatesAll: true`,
  'intent.run': `async run(ctx, { sku, qty }) {
  await db.cart.add(ctx.session, sku, qty)
  await ctx.revalidate('cart')
  return { redirect: '/cart' }
}`,

  // ── defineRenderable ───────────────────────────────────────────────────────
  'renderable.name': `name: 'product.details'`,
  'renderable.fragment': `fragment: 'product/details'`,
  'renderable.region': `// Rendered by whichever deployment the registry points \`catalogue\` at.
// The client only ever had an opaque id and is not involved either way.
region: 'catalogue'`,
  'renderable.capabilities': `capabilities: ['catalogue:read']`,
  'renderable.signed': `signed: true`,
  'renderable.limit': `// The one call a client can make that costs server work without writing anything.
limit: { max: 60, windowMs: 60_000 }`,
  'renderable.input': `// Throwing here is E_RENDER_INPUT, not a 500.
input: (raw) => ({ sku: String((raw as { sku: unknown }).sku) })`,
  'renderable.load': `load: (ctx, { sku }) => ctx.services.catalogue.get(sku)`,
}

/** How many fields carry one. Read by the test, so the map cannot quietly empty out. */
export function exampleCount(): number {
  return Object.keys(EXAMPLES).length
}
