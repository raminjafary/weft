import { deltaPayload, patchPayload, render, type Values } from '@weftjs/ir'
import { fragmentIR } from '@weftjs/core'
import { table } from './markup.ts'

/**
 * The three wire forms of one region, measured on this render.
 *
 * Every page that has ever explained surgical updates has explained them with a number from a
 * benchmark, and a number from a benchmark is a number about somebody else's page. These are
 * computed here, now, from the sealed template of `examples/prices` and two value sets that differ
 * by one price — so what the table says is what this fragment costs, and a change to the fragment
 * changes the table rather than dating it.
 *
 * The forms are not three implementations. `render`, `patchPayload` and `deltaPayload` all read the
 * same `TemplateIR`, which is what the equivalence check in the benchmark harness is asserting when
 * it refuses to publish a number until every form has produced identical bytes.
 */
export interface WireSize {
  form: string
  bytes: number
  carries: string
  needs: string
}

const BEFORE: Values = {
  heading: 'Your basket',
  total: 35,
  lines: [
    { sku: 'OIL-2L', name: 'Olive oil, 2L', price: 14 },
    { sku: 'RICE-5', name: 'Basmati rice, 5kg', price: 9 },
    { sku: 'DATE-1', name: 'Medjool dates, 1kg', price: 12 },
  ],
}

/** One price rose by two, so the row and the total changed and nothing else did. */
const AFTER: Values = {
  heading: 'Your basket',
  total: 37,
  lines: [
    { sku: 'OIL-2L', name: 'Olive oil, 2L', price: 16 },
    { sku: 'RICE-5', name: 'Basmati rice, 5kg', price: 9 },
    { sku: 'DATE-1', name: 'Medjool dates, 1kg', price: 12 },
  ],
}

export function wireSizes(): WireSize[] {
  const fragment = fragmentIR('examples/prices')
  const { entry, resolve } = fragment
  const html = render(entry, AFTER, resolve).byteLength
  const patch = JSON.stringify(patchPayload(entry, entry.version, BEFORE, AFTER, resolve)).length
  const delta = JSON.stringify(deltaPayload(entry, entry.version, BEFORE, AFTER, resolve)).length
  return [
    {
      form: 'html',
      bytes: html,
      carries: 'the region, rendered',
      needs: 'nothing — always available',
    },
    {
      form: 'patch',
      bytes: patch,
      carries: 'the markup of the holes that changed, as DOM writes',
      needs: 'nothing resident on the client',
    },
    {
      form: 'delta',
      bytes: delta,
      carries: 'the changed values only',
      needs: 'the template, and the base render the client names',
    },
  ]
}

/** The comparison, as the page shows it: the forms, their sizes, and what each one asks for. */
export function wireTable(): string {
  const sizes = wireSizes()
  const html = sizes.find((size) => size.form === 'html')?.bytes ?? 0
  const rows = sizes.map((size) => [
    `<code>${size.form}</code>`,
    `${size.bytes} B`,
    html && size.bytes < html ? `${Math.round((1 - size.bytes / html) * 100)}% smaller` : '—',
    size.carries,
    size.needs,
  ])
  return (
    table(['Form', 'Bytes', 'Against html', 'What it carries', 'What it needs'], rows) +
    `<p class="hint">Measured when this page rendered, from the sealed template of
    <code>examples/prices</code> and two value sets one price apart. JSON payloads are counted as
    written; a socket sends them inside a warp frame, which adds its own header.</p>`
  )
}
