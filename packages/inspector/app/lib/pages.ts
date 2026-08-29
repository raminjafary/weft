import { render, type Values } from '@weftjs/ir'
import { fragmentIR, type CompiledFragment, type RenderContext } from '@weftjs/core'
import type { StationStatus } from './stations.ts'

/** What a station page is made of: a control panel, a body, and a readout of what was measured. Markup helpers only. */
/** A slot's content. The function form receives the render context — a control is a query param read via `ctx.query()`, which taints `route:<key>`. See `spec/kernel/cache.md`. */
export type SlotContent = string | ((ctx: RenderContext) => string | Promise<string>)

export interface PageParts {
  /** Controls. Sent first, because a control you cannot touch until the data arrives is not a control. */
  panel?: SlotContent
  body?: SlotContent
  readout?: SlotContent
}

/** What the numbers on a page are. Every station prints one above its readout — a figure with no provenance is decoration. */
export interface Explainer {
  /** What you are looking at, in one or two sentences. */
  what: string
  /** Which function produced it. The demo has no measurement path of its own. */
  from: string
  /** What it does not cover. */
  caveat?: string
  /** What to touch to make the number move. */
  tryThis?: string
}

export function explain(e: Explainer): string {
  return `<div class="card explain">
    <h3>What you are looking at</h3>
    <p>${e.what}</p>
    <dl class="prov">
      <dt>Measured by</dt><dd><code>${escapeHtml(e.from)}</code></dd>
      ${e.caveat ? `<dt>Does not cover</dt><dd>${e.caveat}</dd>` : ''}
      ${e.tryThis ? `<dt>Try</dt><dd>${e.tryThis}</dd>` : ''}
    </dl>
  </div>`
}

export interface PageMeta {
  path: string
  title: string
  heading: string
  shows: string
  control: string
  status: StationStatus
}

// ── readouts ─────────────────────────────────────────────────────────────────────────

export interface ReadoutRow {
  label: string
  value: string
  note?: string
  state?: 'within' | 'over' | 'plain'
}

/** The readout every station uses, rendered through the compiled `panels.tsx` fragment rather than assembled as a string. */
export async function readout(
  caption: string,
  rows: readonly ReadoutRow[],
  explainer?: Explainer,
): Promise<string> {
  const panels = fragmentIR('fragment:panels')
  const values = {
    caption,
    rows: rows.map((row) => ({
      label: row.label,
      value: row.value,
      note: row.note ?? '',
      state: row.state ?? 'plain',
    })),
  } as unknown as Values
  const table = new TextDecoder().decode(render(panels.entry, values, panels.resolve))
  return `<div class="card">${table}</div>${explainer ? explain(explainer) : ''}`
}

export function renderOf(compiled: CompiledFragment, values: Values): string {
  return new TextDecoder().decode(render(compiled.entry, values, compiled.resolve))
}

/** A control panel. Plain markup on purpose: the framework renders pages, not form widgets. */
export function panel(inner: string, hint?: string): string {
  return `<div class="card"><div class="controls">${inner}</div>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`
}

export function field(label: string, control: string): string {
  return `<label>${label}${control}</label>`
}

/** Which query parameter a control owns: the id after its first dash, by the `<station>-<parameter>` naming convention. */
function paramOf(id: string): string {
  const dash = id.indexOf('-')
  return dash < 0 ? id : id.slice(dash + 1)
}

export function slider(id: string, min: number, max: number, value: number, step = 1): string {
  return (
    `<input type="range" id="${id}" data-weft-control="${paramOf(id)}"` +
    ` min="${min}" max="${max}" step="${step}" value="${value}">`
  )
}

export function pick(id: string, options: readonly string[], selected?: string): string {
  const opts = options
    .map((o) => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`)
    .join('')
  return `<select id="${id}" data-weft-control="${paramOf(id)}">${opts}</select>`
}

/** A button. One whose name ends in `-go`, `-run`, `-reload` or `-reschedule` applies the page's controls, wired by the framework. */
export function press(id: string, label: string): string {
  const applies = /-(go|run|reschedule|reload)$/.test(id) ? ' data-weft-apply' : ''
  return `<button type="button" id="${id}"${applies}>${label}</button>`
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function pre(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`
}
