import { fileURLToPath } from 'node:url'
import type { Values } from '../../../ir/src/index.ts'

export interface Scenario {
  id: string
  label: string
  route: string
  /** The .tsx the templates are compiled from. Nothing here is a hand-written IR. */
  fixture: string
  /** Root values, excluding the list binding, which comes from rows(). */
  values(): Values
  rows(): Values[]
  /** The state transition the update-bytes axis measures: a realistic partial change. */
  transition(rows: Values[]): Values[]
}

const fixture = (name: string) => fileURLToPath(new URL(`../../../compiler/fixtures/${name}`, import.meta.url))

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

const shell: Scenario = {
  id: 'shell',
  label: 'Static shell with streaming holes',
  route: '/cart',
  fixture: fixture('shell.tsx'),
  values: () => ({
    title: 'Your cart — Souq',
    cssVersion: '/a/route.a91f3c.css',
    runtimeVersion: '/a/runtime.c01277.js',
    flags: '3f2a',
    cartCount: 3,
    cartLines: '',
    recs: '',
    footer: '© 2026 Souq',
  }),
  rows: () => [],
  transition: (rows) => rows,
}

function lines(id: string, label: string, route: string, count: number): Scenario {
  const seed = [...id].reduce((acc, c) => acc * 31 + c.charCodeAt(0), 7919)
  return {
    id,
    label,
    route,
    fixture: fixture('lines.tsx'),
    values: () => ({ epoch: 'e7', total: 12000 }),
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
  lines('cart', 'Cart lines, 12 rows', '/cart', 12),
  lines('feed', 'Product feed, 50 rows', '/feed', 50),
]

export function scenario(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id)
  if (!found) throw new Error(`E_UNKNOWN_SCENARIO: ${id}. known: ${SCENARIOS.map((s) => s.id).join(', ')}`)
  return found
}
