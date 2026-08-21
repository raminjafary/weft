import { render, type Values } from '../../packages/ir/src/index.ts'
import type { KernelRoute, KernelSlot, RenderContext } from '../../packages/kernel/src/index.ts'
import { compileDemo, type Compiled } from './compile.ts'
import { SHOWCASES, type Station, type StationStatus } from './stations.ts'

const utf8 = new TextEncoder()

/**
 * Every page in this demo is the same compiled shell with three slots filled differently.
 *
 * One shell means one sealed template for thirty-four pages, which is the claim the components
 * station makes as a number: page weight tracks content, not pages. It also means the kernel cuts
 * every page at the same three points and can send the chrome before it knows anything about what
 * fills them.
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

const NAV = [
  { href: '/', label: 'Stations' },
  ...SHOWCASES.map((s) => ({ href: `/app/${s.id}`, label: s.title.replace(/^A(n)? /, '') })),
  { href: '/spec', label: 'Coverage' },
]

export function shellValues(meta: PageMeta): Values {
  return {
    title: `${meta.title} · weft demo`,
    css: '/demo.css',
    runtime: '/demo/boot.ts',
    heading: meta.heading,
    status: meta.status,
    shows: meta.shows,
    control: meta.control,
    nav: NAV.map((item) => ({
      href: item.href,
      label: item.label,
      current: item.href === meta.path ? 'yes' : 'no',
    })),
  } as unknown as Values
}

const EMPTY = utf8.encode('')

function slot(name: string, content: SlotContent | undefined): KernelSlot {
  return {
    name,
    id: `demo/pages#${name}`,
    version: `page-${name}`,
    effects: { reads: [], writes: [], envelope: [], residency: 'either' },
    render: async (ctx) => {
      if (content === undefined) return EMPTY
      const text = typeof content === 'function' ? await content(ctx) : content
      return utf8.encode(text)
    },
  }
}

/**
 * A page as a `KernelRoute`. The shell is a compiled fragment and the slots are bytes, which is
 * exactly the arrangement `KernelSlot` describes: the kernel does not care whether a slot's bytes
 * came from a template or from a string, only that it did not have to wait for them.
 */
export async function page(meta: PageMeta, parts: PageParts): Promise<KernelRoute> {
  const { shell } = await compileDemo()
  return {
    path: meta.path,
    template: shell.entry,
    values: shellValues(meta),
    resolve: shell.resolve,
    shell: { id: shell.entry.id, version: shell.entry.version, effects: shell.entry.effects },
    order: 'in-order',
    slots: [slot('panel', parts.panel), slot('body', parts.body), slot('readout', parts.readout)],
  }
}

export function fromStation(station: Station, path: string): PageMeta {
  return {
    path,
    title: station.title,
    heading: station.title,
    shows: station.shows,
    control: station.control,
    status: station.status,
  }
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
  const { panels } = await compileDemo()
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

export function renderOf(compiled: Compiled, values: Values): string {
  return new TextDecoder().decode(render(compiled.entry, values, compiled.resolve))
}

/** A control panel. Plain markup on purpose: the framework renders pages, not form widgets. */
export function panel(inner: string, hint?: string): string {
  return `<div class="card"><div class="controls">${inner}</div>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`
}

export function field(label: string, control: string): string {
  return `<label>${label}${control}</label>`
}

export function slider(id: string, min: number, max: number, value: number, step = 1): string {
  return `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">`
}

export function pick(id: string, options: readonly string[], selected?: string): string {
  const opts = options
    .map((o) => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`)
    .join('')
  return `<select id="${id}">${opts}</select>`
}

export function press(id: string, label: string): string {
  return `<button type="button" id="${id}">${label}</button>`
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function pre(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`
}
