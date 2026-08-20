import type { Hole, SignalDecl, Values, WiringEntry } from '../../../ir/src/index.ts'

export interface Authored {
  id: string
  /** parts.length must be holes.length + 1 — the same invariant the IR enforces. */
  parts: string[]
  holes: Hole[]
  wiring?: WiringEntry[]
  signals?: SignalDecl[]
}

export interface Scenario {
  id: string
  label: string
  route: string
  root: Authored
  row?: { authored: Authored; binding: string; count: number }
  values(): Values
  rows(): Values[]
  /** The state transition the update-bytes axis measures: a realistic partial change. */
  transition(rows: Values[]): Values[]
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const PRODUCTS = [
  'Basmati rice 5kg',
  'Olive oil <cold pressed>',
  'Dates & walnuts',
  'Chickpeas 1kg',
  'Sumac 200g',
  'Lamb shoulder',
  'Tahini "original"',
  'Bulgur #2',
]

function hole(index: number, binding: string, opts: Partial<Hole> = {}): Hole {
  return {
    index,
    kind: opts.kind ?? 'text',
    escape: opts.escape ?? 'escape',
    binding,
    path: opts.path ?? [index],
    ...(opts.attr ? { attr: opts.attr } : {}),
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
  }
}

const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`

const shell: Scenario = {
  id: 'shell',
  label: 'Static shell with streaming holes',
  route: '/cart',
  root: {
    id: 'route/cart#shell',
    parts: [
      `${HEAD}<title>`,
      `</title><link rel="stylesheet" href="/a/route.`,
      `.css"><script type="module" src="/a/runtime.`,
      `.js"></script></head><body data-flags="`,
      `"><header class="top"><a href="/" class="brand">Souq</a><nav><a href="/orders">Orders</a><a href="/cart">Cart (`,
      `)</a></nav></header><main><section id="cart-lines"><template shadowrootmode="open"><slot name="cart-lines">`,
      `</slot></template></section><section id="recommendations"><template shadowrootmode="open"><slot name="recs">`,
      `</slot></template></section></main><footer>`,
      `</footer></body></html>`,
    ],
    holes: [
      hole(0, 'title'),
      hole(1, 'cssVersion', { escape: 'proven-safe' }),
      hole(2, 'runtimeVersion', { escape: 'proven-safe' }),
      hole(3, 'flags', { escape: 'proven-safe' }),
      hole(4, 'cartCount', { escape: 'proven-safe' }),
      hole(5, 'cartLinesFallback', { kind: 'slot' }),
      hole(6, 'recsFallback', { kind: 'slot' }),
      hole(7, 'footer'),
    ],
  },
  values: () => ({
    title: 'Your cart — Souq',
    cssVersion: 'a91f3c',
    runtimeVersion: 'c01277',
    flags: '3f2a',
    cartCount: 3,
    cartLinesFallback: '',
    recsFallback: '',
    footer: '© 2026 Souq',
  }),
  rows: () => [],
  transition: (rows) => rows,
}

function listScenario(id: string, label: string, route: string, count: number): Scenario {
  const seed = [...id].reduce((acc, c) => acc * 31 + c.charCodeAt(0), 7919)
  return {
    id,
    label,
    route,
    root: {
      id: `route${route}#lines`,
      parts: [`<ul class="lines" data-epoch="`, `">`, `</ul><p class="total">Total: `, ` IQD</p>`],
      holes: [
        hole(0, 'epoch', { escape: 'proven-safe', attr: 'data-epoch', kind: 'attr' }),
        hole(1, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: `${route}#row template` }),
        hole(2, 'total', { escape: 'proven-safe' }),
      ],
    },
    row: {
      binding: 'rows',
      count,
      authored: {
        id: `route${route}#row`,
        parts: [`<li data-sku="`, `"><span class="name">`, `</span><span class="qty">`, `</span><span class="price">`, `</span></li>`],
        holes: [
          hole(0, 'sku', { kind: 'attr', attr: 'data-sku', escape: 'proven-safe' }),
          hole(1, 'name'),
          hole(2, 'qty', { escape: 'proven-safe' }),
          hole(3, 'price', { escape: 'proven-safe' }),
        ],
        wiring: [
          { path: [0, 2], op: 'text', binding: 'qty' },
          { path: [0, 3], op: 'text', binding: 'price' },
          { path: [0], op: 'event', binding: 'qty', event: 'input', intent: '7f3' },
        ],
        signals: [{ id: 'qty', type: 'number', init: 1 }],
      },
    },
    values: () => ({ epoch: 'e7', total: 12000, rows: [] }),
    rows: () => {
      const rand = lcg(seed)
      return Array.from({ length: count }, (_, i) => ({
        sku: 1000 + i,
        name: PRODUCTS[i % PRODUCTS.length] as string,
        qty: 1 + Math.floor(rand() * 4),
        price: 500 + Math.floor(rand() * 9000),
      }))
    },
    transition: (rows) =>
      rows.map((r, i) => (i % 8 === 3 ? { ...r, qty: Number(r.qty) + 1, price: Number(r.price) + 400 } : r)),
  }
}

export const SCENARIOS: Scenario[] = [
  shell,
  listScenario('cart', 'Cart lines, 12 rows', '/cart', 12),
  listScenario('feed', 'Product feed, 50 rows', '/feed', 50),
]

export function scenario(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id)
  if (!found) throw new Error(`E_UNKNOWN_SCENARIO: ${id}. known: ${SCENARIOS.map((s) => s.id).join(', ')}`)
  return found
}
