import { render, type Values } from '@weft/ir'
import { fragmentIR, type CompiledFragment, type RenderContext } from '@weft/core'
import type { StationStatus } from './stations.ts'

/**
 * What a station page is made of: a control panel, a body, and a readout of what was measured.
 *
 * These are markup helpers and nothing more. Building `KernelRoute` objects, filling the shell's
 * three slots and assembling the nav all used to live here; they are the framework's now, and
 * `demo/src/station.ts` is the twenty lines that turn a station into a route.
 */
/**
 * A slot's content. The function form receives the render context, which is how a station's
 * controls reach it: a control on a server-rendered page is a query parameter, and the framework's
 * way to read one is `ctx.query()`. That is not incidental — the read taints `route:<key>`, so a
 * station's own controls appear in its own cache key, which the cache-keys station shows.
 */
export type SlotContent = string | ((ctx: RenderContext) => string | Promise<string>)

export interface PageParts {
  /** Controls. Sent first, because a control you cannot touch until the data arrives is not a control. */
  panel?: SlotContent
  body?: SlotContent
  readout?: SlotContent
}

/**
 * What the numbers on a page are. Every station prints one of these above its readout, because a
 * figure with no statement of what it measures and where it came from is decoration.
 */
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

/**
 * The readout every station uses, rendered through the compiled `panels.tsx` fragment rather than
 * assembled as a string. A number on a station page therefore arrives through the same render
 * path as the content next to it.
 */
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

/**
 * Which query parameter a control owns, taken from its own id.
 *
 * Every control in this demo is named `<station>-<parameter>`, so the parameter is the id after
 * the first dash. That convention used to live in the client as a forty-entry table mapping ids
 * to parameter names — one the framework could not have guessed and the demo had to keep in step
 * with every slider it added. Stated here, once, it is the same fact in the place that already
 * knows both halves.
 */
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

/**
 * A button. One whose name ends in `-go`, `-run`, `-reload` or `-reschedule` applies the page's
 * controls, which the framework wires — so no code here or in the client knows its id.
 */
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
