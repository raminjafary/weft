import { createElement as h, Suspense, use } from 'react'

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

function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** The same rows, from the same generator, as the harness workload. */
export function makeRows(count, seed) {
  const rand = lcg(seed)
  return Array.from({ length: count }, (_, i) => ({
    sku: 1000 + i,
    name: PRODUCTS[i % PRODUCTS.length],
    qty: 1 + Math.floor(rand() * 4),
    price: 500 + Math.floor(rand() * 9000),
  }))
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function Row({ row }) {
  return h(
    'li',
    { 'data-sku': row.sku },
    h('span', { className: 'name' }, row.name),
    h('span', { className: 'qty' }, row.qty),
    h('span', { className: 'price' }, row.price),
  )
}

function Rows({ rows }) {
  const resolved = typeof rows?.then === 'function' ? use(rows) : rows
  return resolved.map((row) => h(Row, { key: row.sku, row }))
}

/** The slow region sits behind a boundary, so the shell can flush before it resolves. */
export function Lines({ epoch, rows, total, streaming }) {
  const list = h('ul', { className: 'lines', 'data-epoch': epoch }, h(Rows, { rows }))
  return h(
    'div',
    null,
    streaming ? h(Suspense, { fallback: h('ul', { className: 'lines' }) }, list) : list,
    h('p', { className: 'total' }, 'Total: ', total, ' IQD'),
  )
}
