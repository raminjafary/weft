import type { Values } from '@weftjs/core'

/**
 * The demo's data, generated deterministically from a seed.
 *
 * Deterministic on purpose: a content-addressed delta memo only shares work between clients that
 * are genuinely on the same base render, so a feed built from `Math.random()` would make every
 * visitor their own cache entry and quietly turn the shared-delta station into a lie.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const SOURCES = ['Al-Sabah', 'Reuters', 'Souq Desk', 'Basra Wire', 'Erbil Daily', 'Kirkuk Post']
const NOUNS = [
  'wheat futures',
  'dinar deposits',
  'solar tenders',
  'date exports',
  'freight rates',
  'cement demand',
  'fibre rollout',
  'grid capacity',
  'port throughput',
  'refinery output',
]
const VERBS = ['steadies', 'climbs', 'slips', 'holds', 'jumps', 'eases', 'firms', 'retreats']

export interface FeedItem {
  id: number
  title: string
  source: string
  price: number
  delta: string
  updated: string
}

/**
 * `tick` is what changes. Everything else is a pure function of the index, so two ticks differ in
 * exactly the rows the tick touched — which is what makes the incremental station's arithmetic
 * checkable rather than assertable.
 */
export function feedItems(count: number, tick = 0, changeEvery = 8): FeedItem[] {
  const random = seeded(count * 7919 + 13)
  return Array.from({ length: count }, (_, i) => {
    const moved = tick > 0 && i % changeEvery === tick % changeEvery
    const base = 400 + Math.floor(random() * 9600)
    const price = moved ? base + tick * 37 : base
    const drift = moved ? (tick % 2 === 0 ? 1 : -1) * (1 + (tick % 5)) : 0
    return {
      id: i + 1,
      title: `${NOUNS[i % NOUNS.length]} ${VERBS[i % VERBS.length]}`,
      source: SOURCES[i % SOURCES.length] as string,
      price,
      delta: drift === 0 ? '·' : drift > 0 ? `+${drift}.${(i % 9) + 1}%` : `${drift}.${(i % 9) + 1}%`,
      updated: `${String(6 + (i % 12)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
    }
  })
}

export interface CartLine {
  sku: string
  name: string
  qty: number
  price: number
  total: number
}

const CATALOGUE: readonly { sku: string; name: string; price: number }[] = [
  { sku: 'RICE-5K', name: 'Amber rice, 5 kg', price: 12_000 },
  { sku: 'DATE-1K', name: 'Barhi dates, 1 kg', price: 3_500 },
  { sku: 'OIL-2L', name: 'Sunflower oil, 2 L', price: 6_250 },
  { sku: 'TEA-500', name: 'Ceylon tea, 500 g', price: 4_100 },
  { sku: 'SUGAR-2K', name: 'Cane sugar, 2 kg', price: 2_900 },
  { sku: 'SOAP-6', name: 'Olive soap, 6 bars', price: 5_400 },
]

export const CATALOGUE_SKUS = CATALOGUE.map((item) => item.sku)

export function catalogue(sku: string): { sku: string; name: string; price: number } | undefined {
  return CATALOGUE.find((item) => item.sku === sku)
}

/** One cart per session id. In-process on purpose: a demo that needs a database is not a demo. */
const carts = new Map<string, Map<string, number>>()

export function cartOf(session: string): Map<string, number> {
  let cart = carts.get(session)
  if (!cart) {
    cart = new Map([
      ['RICE-5K', 1],
      ['DATE-1K', 2],
    ])
    carts.set(session, cart)
  }
  return cart
}

export function cartValues(session: string, currency = 'IQD'): Values {
  const cart = cartOf(session)
  const lines: CartLine[] = []
  for (const [sku, qty] of cart) {
    const item = catalogue(sku)
    if (!item || qty <= 0) continue
    lines.push({ sku, name: item.name, qty, price: item.price, total: item.price * qty })
  }
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0)
  const shipping = subtotal > 20_000 ? 0 : 2_500
  return {
    lines,
    subtotal,
    shipping,
    total: subtotal + shipping,
    currency,
  } as unknown as Values
}

export const ARTICLE = {
  title: 'What a fragment is, and why refusing is the point',
  standfirst:
    'A fragment is a unit of render whose read set the compiler can name. Everything else in this framework — the cache key, the wire form, the cache class — is derived from that one fact.',
  byline: 'From the demo, which renders this page with no JavaScript at all',
  blocks: [
    {
      kind: 'p',
      text: 'This page reads nothing. No cookie, no header, no clock, no identity — so its inferred cache class is static, its key is its own content address, and a CDN could serve it without the kernel ever being invoked.',
    },
    {
      kind: 'p',
      text: 'That is not a configuration. Open demo/src/fragments/article.tsx: there is no ctx parameter, so there is nothing to taint, so there is nothing for a cache to vary on. Add one ctx.user() call and this page becomes private, and the effects station will show you the moment it does.',
    },
    {
      kind: 'p',
      text: 'The blocks you are reading are a list hole projected through one sealed row template. Fifty paragraphs would add fifty paragraphs of content and not one byte of template, which is the same property the feed showcase turns into a number.',
    },
    {
      kind: 'p',
      text: 'The only JavaScript this page loads is the demo chrome. A content route needs no update path and no persistence: a page that reads does not need to patch itself, and the runtime that would let it is not on the wire.',
    },
  ],
} as const

export interface DashPanel {
  name: string
  costMs: number
  executor: string
  cacheClass: string
  series: { label: string; value: string; trend: string }[]
}

export function dashPanel(
  name: string,
  costMs: number,
  executor: string,
  cacheClass: string,
  seed: number,
): Values {
  const random = seeded(seed)
  const labels = ['Baghdad', 'Basra', 'Erbil', 'Mosul', 'Najaf']
  const values = labels.map(() => Math.floor(random() * 9000) + 100)
  const peak = Math.max(...values)
  return {
    name,
    costMs,
    executor,
    cacheClass,
    // A computed length. No stylesheet can hold this, which is why the fragment sets it inline:
    // one escaped attribute hole, and no client code to compute it in the browser.
    barStyle: `--bar:${Math.round(((values[0] as number) / peak) * 100)}%`,
    series: labels.map((label, index) => {
      const value = values[index] as number
      return { label, value: value.toLocaleString('en-US'), trend: value % 2 === 0 ? 'up' : 'down' }
    }),
  } as unknown as Values
}

/**
 * The feed's clock. It lives here rather than in a route so that the intent that advances it and
 * the loader that reads it are looking at one number — a demo where those two disagree is a demo
 * whose deltas describe a page nobody was shown.
 */
let tick = 0

export function advance(): number {
  tick += 1
  return tick
}

export function at(): number {
  return tick
}
