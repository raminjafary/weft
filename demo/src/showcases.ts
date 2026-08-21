import type { Values } from '../../packages/ir/src/index.ts'
import type { RouteResolver } from '../../packages/kernel/src/index.ts'
import {
  every,
  factsFrom,
  guard,
  plan,
  routeEntry,
  shell,
  slot,
  type RouteBindings,
  type SlotFacts,
} from '../../packages/plan/src/index.ts'
import { compileDemo, listBinding, type Compiled } from './compile.ts'
import { ARTICLE, cartValues, dashPanel, feedItems } from './data.ts'
import { field, panel, pick, press, slider, shellValues } from './pages.ts'

/**
 * The showcases, authored the way the design says an application is authored: a plan says where
 * things go, the compiler says what they read, and a bindings object says what they render. Three
 * files, no overlap, and nothing stated twice.
 *
 * The stations take the kernel apart. These four put it back together, because a framework can win
 * every isolated station and still be miserable to build a page with.
 */
const utf8 = new TextEncoder()

/**
 * The channel readout every live showcase carries. `data-channel` is what tells the client to open
 * one on load; without it the connection is opened on the first click that needs it.
 */
const LOG = `<span data-channel="1" hidden></span>
     <p class="hint">channel: <span id="channel-state" class="mono">opening…</span> · <span id="channel-writes" class="mono">0 DOM writes</span></p>
     <div class="card log" id="frame-log"></div>`

async function facts(): Promise<Record<string, SlotFacts>> {
  const compiled = await compileDemo()
  return factsFrom(Object.values(compiled).map((c) => ({ fragments: [{ entry: c.entry }] })))
}

const id = (c: Compiled): string => c.entry.id

function markupSlot(c: Compiled, html: string): RouteBindings['slots'][string] {
  return { fragment: { entry: c.entry, resolve: c.resolve }, values: () => ({ html }) as unknown as Values }
}

function meta(path: string, title: string, heading: string, shows: string, control: string): Values {
  return shellValues({ path, title, heading, shows, control, status: 'live' })
}

// ── the feed ─────────────────────────────────────────────────────────────────────────

const FEED_PANEL =
  panel(
    [
      field('rows', slider('feed-rows', 20, 400, 120, 20)),
      field('tick every (ms)', slider('feed-interval', 250, 4000, 1000, 250)),
      field('binding', pick('feed-binding', ['stream', 'sse', 'socket'])),
      press('feed-connect', 'open channel'),
      press('feed-tick', 'tick once'),
    ].join(''),
    'Every tick invalidates one key on the server. Each open connection is told, asks for a delta, and the first to ask pays for it.',
  ) + `<div class="card">${LOG}</div>`

export async function feedRoute(): Promise<ReturnType<typeof routeEntry>> {
  const c = await compileDemo()
  const rows = listBinding(c.feed)
  const built = plan('/app/feed', [
    shell(id(c.shell)),
    slot('panel').fragment(id(c.markup)).buffered(),
    // The feed reads the clock, so a policy without a ttl is a build error. This is the compiler
    // contradicting the plan, and the plan losing.
    slot('body')
      .fragment(id(c.feed))
      .stream({ prio: 1 })
      .cache('public', { ttl: '30s', swr: '5m', tags: ['feed'] })
      .refresh(every('30s'))
      .form({ prefer: 'delta', fallback: 'html' })
      .incremental(),
    slot('readout').fragment(id(c.markup)).buffered(),
  ])
  return routeEntry(
    built,
    { facts: await facts() },
    {
      shell: { entry: c.shell.entry, resolve: c.shell.resolve },
      shellValues: () =>
        meta(
          '/app/feed',
          'A content-heavy feed',
          'A content-heavy feed',
          'Hundreds of rows, one sealed row template, nothing that reads identity — so the whole region is one shared cache entry.',
          'Change the row count, open a channel, and tick it. One row in eight moves.',
        ),
      slots: {
        panel: markupSlot(c.markup, FEED_PANEL),
        body: {
          fragment: { entry: c.feed.entry, resolve: c.feed.resolve },
          values: (ctx) => {
            const count = Number(ctx.query('rows') ?? 120)
            const tick = Number(ctx.query('tick') ?? 0)
            return {
              heading: 'Markets',
              count,
              generated: ctx.now(),
              [rows]: feedItems(count, tick),
            } as unknown as Values
          },
          placeholder: utf8.encode('<p class="skeleton"></p>'),
        },
        readout: markupSlot(
          c.markup,
          '<div class="card" id="feed-readout"><h3>Readout</h3><p class="hint">Open the channel to fill this.</p></div>',
        ),
      },
    },
  )
}

// ── the cart ─────────────────────────────────────────────────────────────────────────

const CART_PANEL =
  panel(
    [
      field('sku', pick('cart-sku', ['RICE-5K', 'DATE-1K', 'OIL-2L', 'TEA-500', 'SUGAR-2K'])),
      press('cart-add', 'add (fetch + optimistic)'),
      press('cart-fail', 'add, but make it fail'),
      `<form method="post" action="/app/cart" class="controls">
       <input type="hidden" name="sku" value="OIL-2L">
       <button type="submit" name="op" value="add">add with no JavaScript</button>
     </form>`,
      press('cart-refresh', 'refresh over the channel'),
    ].join(''),
    'The last button in the row is a plain form post. It answers with a 303 back to this page, which is the whole progressive-enhancement story.',
  ) + `<div class="card">${LOG}</div>`

export async function cartRoute(): Promise<ReturnType<typeof routeEntry>> {
  const c = await compileDemo()
  const built = plan('/app/cart', [
    shell(id(c.shell)),
    guard('session.required', { redirect: '/app/cart?anonymous=1' }),
    slot('panel').fragment(id(c.markup)).buffered(),
    // Reads identity, so `private` is the only policy the compiler will accept. Declaring
    // `public` here fails the build and names `identity`.
    slot('body')
      .fragment(id(c.cart))
      .stream({ prio: 1 })
      .cache('private', { tags: ['cart'] }),
    slot('readout').fragment(id(c.greeting)).buffered().cache('private'),
  ])
  return routeEntry(
    built,
    { facts: await facts() },
    {
      shell: { entry: c.shell.entry, resolve: c.shell.resolve },
      shellValues: () =>
        meta(
          '/app/cart',
          'A cart, which is the hard case',
          'A cart, which is the hard case',
          'One private fragment inside a shared shell. The shell stays shared; only this region is per-user.',
          'Add a line three ways: optimistically over the channel, deliberately failing, and with no JavaScript at all.',
        ),
      guards: { 'session.required': (ctx) => Boolean(ctx.cookie('sid')) },
      slots: {
        panel: markupSlot(c.markup, CART_PANEL),
        body: {
          fragment: { entry: c.cart.entry, resolve: c.cart.resolve },
          values: async (ctx) => {
            const session = ctx.cookie('sid') ?? 'anonymous'
            const user = (await ctx.user()) ?? 'guest'
            return { ...cartValues(session, ctx.cookie('currency') ?? 'IQD'), user } as unknown as Values
          },
        },
        readout: {
          fragment: { entry: c.greeting.entry, resolve: c.greeting.resolve },
          values: async (ctx) =>
            ({
              user: (await ctx.user()) ?? 'guest',
              tier: ctx.header('x-tier') ?? 'standard',
            }) as unknown as Values,
        },
      },
    },
  )
}

// ── the article ──────────────────────────────────────────────────────────────────────

export async function articleRoute(): Promise<ReturnType<typeof routeEntry>> {
  const c = await compileDemo()
  const blocks = listBinding(c.article)
  const built = plan('/app/article', [
    shell(id(c.shell)),
    slot('panel').fragment(id(c.markup)).buffered(),
    // Reads nothing, so the class is static and the key is the content address. No ttl is needed
    // because there is no clock read to expire.
    slot('body').fragment(id(c.article)).buffered().cache('public', { ttl: '1h' }),
    slot('readout').fragment(id(c.markup)).buffered(),
  ])
  return routeEntry(
    built,
    { facts: await facts() },
    {
      shell: { entry: c.shell.entry, resolve: c.shell.resolve },
      shellValues: () =>
        meta(
          '/app/article',
          'An article',
          'An article',
          'The case where almost nothing should ship. This fragment reads nothing, so its class is static.',
          'Disable JavaScript and reload. Nothing changes, because nothing on this page needed it.',
        ),
      slots: {
        panel: markupSlot(
          c.markup,
          panel('', 'No controls. That is the demonstration: there is nothing on this page to drive.'),
        ),
        body: {
          fragment: { entry: c.article.entry, resolve: c.article.resolve },
          values: () =>
            ({
              title: ARTICLE.title,
              standfirst: ARTICLE.standfirst,
              byline: ARTICLE.byline,
              [blocks]: ARTICLE.blocks,
            }) as unknown as Values,
        },
        readout: markupSlot(c.markup, ''),
      },
    },
  )
}

// ── the ordinary page ────────────────────────────────────────────────────────────────

const CATEGORIES: Record<
  string,
  { intro: string; items: { name: string; price: number; unit: string; badge: string; available: boolean }[] }
> = {
  pantry: {
    intro:
      'Three cards, one sealed component template, and a page that arrives in one piece. No slot on this route asks to stream, so the plan lowers to in-order and nothing pays for a fill mechanism.',
    items: [
      { name: 'Amber rice, 5 kg', price: 12_000, unit: 'IQD', badge: 'Basra mill', available: true },
      { name: 'Barhi dates, 1 kg', price: 3_500, unit: 'IQD', badge: 'in season', available: true },
      { name: 'Ceylon tea, 500 g', price: 4_100, unit: 'IQD', badge: 'back in stock soon', available: false },
    ],
  },
  household: {
    intro:
      'The same component, different props. Changing the category changes the content and not the template — which is the whole reason page weight tracks content here rather than tracking the number of components on the page.',
    items: [
      { name: 'Sunflower oil, 2 L', price: 6_250, unit: 'IQD', badge: 'bulk', available: true },
      { name: 'Cane sugar, 2 kg', price: 2_900, unit: 'IQD', badge: 'household', available: true },
      { name: 'Olive soap, 6 bars', price: 5_400, unit: 'IQD', badge: 'Nablus', available: true },
    ],
  },
}

export async function ordinaryRoute(): Promise<ReturnType<typeof routeEntry>> {
  const c = await compileDemo()
  const built = plan('/app/ordinary/:category', [
    shell(id(c.shell)),
    slot('panel').fragment(id(c.markup)).buffered(),
    // Buffered, not streamed. The plan says nothing about streaming, so `orderOf` derives
    // `in-order` — and in-order needs no fill mechanism, so the filler is not loaded.
    slot('body').fragment(id(c.ordinary)).buffered().cache('public', { ttl: '10m' }),
    slot('readout').fragment(id(c.markup)).buffered(),
  ])
  return routeEntry(
    built,
    { facts: await facts() },
    {
      shell: { entry: c.shell.entry, resolve: c.shell.resolve },
      shellValues: (params) =>
        meta(
          '/app/ordinary/pantry',
          `${params.category ?? 'pantry'} — an ordinary page`,
          'An ordinary page',
          'No streaming, no channel, no deltas. One route, one component rendered three times, and a page that arrives in one piece.',
          'Switch category in the nav below. The template does not change; only the content does.',
        ),
      slots: {
        panel: markupSlot(
          c.markup,
          panel(
            [
              '<a class="pill" href="/app/ordinary/pantry">pantry</a>',
              '<a class="pill" href="/app/ordinary/household">household</a>',
            ].join(''),
            'Two ordinary links. No client-side navigation, because there is none yet — and the page does not need it to be fast.',
          ),
        ),
        body: {
          fragment: { entry: c.ordinary.entry, resolve: c.ordinary.resolve },
          values: (_ctx, params) => {
            const key = params.category === 'household' ? 'household' : 'pantry'
            const category = CATEGORIES[key] as (typeof CATEGORIES)[string]
            const [a, b, d] = category.items as [
              (typeof category.items)[number],
              (typeof category.items)[number],
              (typeof category.items)[number],
            ]
            return {
              category: key === 'household' ? 'Household' : 'Pantry',
              intro: category.intro,
              firstName: a.name,
              firstPrice: a.price,
              firstUnit: a.unit,
              firstBadge: a.badge,
              firstAvailable: a.available,
              secondName: b.name,
              secondPrice: b.price,
              secondUnit: b.unit,
              secondBadge: b.badge,
              secondAvailable: b.available,
              thirdName: d.name,
              thirdPrice: d.price,
              thirdUnit: d.unit,
              thirdBadge: d.badge,
              thirdAvailable: d.available,
            } as unknown as Values
          },
        },
        readout: markupSlot(
          c.markup,
          `<div class="card"><h3>What this page cost</h3>
          <dl class="prov">
            <dt>Sealed templates</dt><dd>2 — the page and the card, whatever the card count</dd>
            <dt>Component instances</dt><dd>3, projected into the card's holes rather than mounted</dd>
            <dt>Streaming order</dt><dd><code>in-order</code>, derived: no slot asked to stream</dd>
            <dt>Fill mechanism</dt><dd>none, so the out-of-order filler is not on the wire</dd>
            <dt>Cache class</dt><dd><code>public</code> — this fragment reads nothing but its route param</dd>
          </dl></div>`,
        ),
      },
    },
  )
}

/** A panel's declared latency, read from the query so the slowest one can be driven from the page. */
function queryNumber(ctx: { query(k: string): string | undefined }, key: string, fallback: number): number {
  return Number(ctx.query(key) ?? fallback)
}

/** Real waiting. A dashboard whose slow panel is not slow demonstrates nothing. */
async function slow(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

// ── the dashboard ────────────────────────────────────────────────────────────────────

const DASH_PANEL = panel(
  [
    field('slowest panel (ms)', slider('dash-slow', 0, 1500, 600, 50)),
    field('cpu budget (ms)', slider('dash-budget', 20, 800, 200, 20)),
    field('on exceed', pick('dash-exceed', ['placeholder', 'stale', 'fallback', 'client', 'fail'])),
    press('dash-reload', 'reload with these'),
  ].join(''),
  'The slowest panel needs the traffic panel, so it cannot start until that one lands. Watch the waves, not the sum.',
)

export async function dashboardRoute(): Promise<ReturnType<typeof routeEntry>> {
  const c = await compileDemo()
  const dash = c['dash-shell'] as Compiled
  const built = plan('/app/dashboard', [
    shell(id(dash)),
    slot('panel').fragment(id(c.markup)).buffered(),
    slot('traffic').fragment(id(c.dashboard)).stream({ prio: 3 }).cache('public', { ttl: '60s' }),
    slot('revenue').fragment(id(c.dashboard)).stream({ prio: 2 }).cache('public', { ttl: '60s' }),
    slot('errors').fragment(id(c.dashboard)).stream({ prio: 2 }).cache('public', { ttl: '60s' }),
    // Needs traffic, so the scheduler puts it in a later wave. A budget on it is advisory here and
    // says so: the demo binds no pool, so `inline` is the only executor there is.
    slot('slowest')
      .fragment(id(c.dashboard))
      .needs('traffic')
      .stream({ prio: 1 })
      .budget({ cpu: '200ms', onExceed: 'placeholder' }),
    slot('readout').fragment(id(c.markup)).buffered(),
  ])

  return routeEntry(
    built,
    { facts: await facts() },
    {
      shell: { entry: dash.entry, resolve: dash.resolve },
      shellValues: () =>
        ({
          title: 'A dashboard with slow panels · weft demo',
          css: '/demo.css',
          runtime: '/demo/boot.ts',
          nav: (shellValues({
            path: '/app/dashboard',
            title: '',
            heading: '',
            shows: '',
            control: '',
            status: 'live',
          }).nav ?? []) as unknown as Values[string],
        }) as unknown as Values,
      slots: {
        panel: markupSlot(c.markup, DASH_PANEL),
        traffic: {
          fragment: { entry: c.dashboard.entry, resolve: c.dashboard.resolve },
          values: async () => {
            await slow(40)
            return dashPanel('Traffic', 40, 'inline', 'public', 11)
          },
          placeholder: utf8.encode('<div class="dash-panel"><p class="skeleton"></p></div>'),
        },
        revenue: {
          fragment: { entry: c.dashboard.entry, resolve: c.dashboard.resolve },
          values: async () => {
            await slow(120)
            return dashPanel('Revenue', 120, 'inline', 'public', 23)
          },
          placeholder: utf8.encode('<div class="dash-panel"><p class="skeleton"></p></div>'),
        },
        errors: {
          fragment: { entry: c.dashboard.entry, resolve: c.dashboard.resolve },
          values: async () => {
            await slow(80)
            return dashPanel('Errors', 80, 'inline', 'public', 31)
          },
          placeholder: utf8.encode('<div class="dash-panel"><p class="skeleton"></p></div>'),
        },
        slowest: {
          fragment: { entry: c.dashboard.entry, resolve: c.dashboard.resolve },
          values: async (ctx) => {
            const ms = queryNumber(ctx, 'slow', 600)
            await slow(ms)
            return dashPanel('Cohort retention', ms, 'inline', 'uncached', 47)
          },
          placeholder: utf8.encode('<div class="dash-panel"><p class="skeleton">over budget</p></div>'),
        },
        readout: markupSlot(
          c.markup,
          '<div class="card" id="dash-readout"><h3>Waves</h3><p class="hint">Filled from the trace on load.</p></div>',
        ),
      },
    },
  )
}

export async function showcaseRoutes(): Promise<ReturnType<typeof routeEntry>[]> {
  return Promise.all([ordinaryRoute(), feedRoute(), cartRoute(), articleRoute(), dashboardRoute()])
}

export type { RouteResolver }
