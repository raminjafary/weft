import { criticalPath, schedule, type DagNode } from '@weftjs/kernel'
import { escapeHtml } from './escape.ts'
import { graph, type GraphEdge, type GraphNode } from './graph.ts'
import { artifacts } from './versions.ts'

/**
 * The architecture, drawn — the top of `/guide`, before the directory of pages.
 *
 * The guide is twenty-two pages and each one takes a single mechanism apart. That order is right
 * for learning it and wrong for deciding whether to: somebody who has read page one knows what a
 * fragment is and still has no idea what the framework *is*. So the index opens with the whole
 * thing at once — ten packages, one request path, three tiers, three wire forms — and every later
 * page is then one box out of these six figures, with its refusals.
 *
 * Nothing here is a picture of the architecture. The dependency graph is checked against the
 * workspace, the wave schedule is computed by the kernel's own scheduler on the slots shown, and
 * the two wire versions are the constants a build stamps. A diagram that could drift from the thing
 * it draws is worse than no diagram, because it is believed.
 */

const enc = escapeHtml

/** One figure: the drawing, its overflow, and the sentence under it. */
function figure(body: string, caption: string): string {
  return `<figure class="gfx">
    <div class="gfx-in">${body}</div>
    <figcaption>${caption}</figcaption>
  </figure>`
}

function heading(n: string, title: string, lede: string): string {
  return `<h2 class="arch-h">${enc(n)} · ${enc(title)}</h2><p class="arch-say">${lede}</p>`
}

/* ── 1 · the packages ─────────────────────────────────────────────────────── */

/** Where each package sits, and what it is allowed to know. The columns are the dependency depth. */
const PACKAGES: readonly GraphNode[] = [
  { id: 'ir', x: 10, y: 24, w: 168, h: 50, title: '@weftjs/ir', at: 0 },
  { id: 'warp', x: 10, y: 108, w: 168, h: 50, title: '@weftjs/warp', at: 0.3 },
  { id: 'client', x: 10, y: 192, w: 168, h: 50, title: '@weftjs/client', at: 0.6 },
  { id: 'compiler', x: 250, y: 60, w: 168, h: 50, title: '@weftjs/compiler', at: 1.1 },
  { id: 'kernel', x: 250, y: 200, w: 168, h: 50, title: '@weftjs/kernel', accent: true, at: 1.5 },
  { id: 'plan', x: 520, y: 40, w: 168, h: 50, title: '@weftjs/plan', at: 2 },
  { id: 'adapters', x: 520, y: 180, w: 168, h: 50, title: '@weftjs/adapters', at: 2.3 },
  { id: 'weft', x: 790, y: 110, w: 168, h: 50, title: 'weft', accent: true, at: 2.8 },
  { id: 'docs', x: 1080, y: 20, w: 168, h: 50, title: '@weftjs/docs', at: 3.4 },
  { id: 'inspector', x: 1080, y: 100, w: 168, h: 50, title: '@weftjs/inspector', at: 3.6 },
  { id: 'bench', x: 1080, y: 180, w: 168, h: 50, title: '@weftjs/bench', at: 3.8 },
  { id: 'create', x: 1080, y: 260, w: 168, h: 50, title: 'create-weft', at: 4 },
]

/**
 * The arrows, and every one is checked.
 *
 * `verify()` reads each package's own manifest and refuses to render a dependency that is not
 * declared there — so an arrow on this page cannot outlive the dependency it draws. What the figure
 * deliberately does *not* draw is every edge: `weft` depends on `@weftjs/ir` as well as on the kernel
 * that depends on it, and drawing both says nothing the first one did not. Direction is the claim.
 */
const DEPENDS: readonly (readonly [string, string])[] = [
  ['compiler', 'ir'],
  ['kernel', 'ir'],
  ['kernel', 'warp'],
  ['plan', 'ir'],
  ['plan', 'kernel'],
  ['adapters', 'compiler'],
  ['adapters', 'kernel'],
  ['adapters', 'warp'],
  ['weft', 'client'],
  ['weft', 'plan'],
  ['weft', 'adapters'],
  ['weft', 'kernel'],
  ['docs', 'weft'],
  ['inspector', 'weft'],
  ['bench', 'kernel'],
]

/** A wire format's version, as the build would stamp it. */
function version(what: string): string {
  return artifacts().find((each) => each.what === what)?.version ?? ''
}

/** The notes under each box: what the package is, and the one number that pins it down. */
function packageNotes(): Map<string, string> {
  return new Map([
    ['ir', `${version('Template IR')} · no deps`],
    ['warp', `${version('Warp frames')} · no deps`],
    ['client', '6,109 B brotli'],
    ['compiler', 'TSX → IR, on Oxc'],
    ['kernel', 'the request path'],
    ['plan', 'plan DSL, validation'],
    ['adapters', '14 ports implemented'],
    ['weft', 'the front door'],
    ['docs', 'this site, as an app'],
    ['inspector', 'a station per mechanism'],
    ['bench', 'the benchmarks'],
    ['create', 'depends on nothing'],
  ])
}

function packages(): string {
  const notes = packageNotes()
  const nodes = PACKAGES.map((each) => ({ ...each, notes: [notes.get(each.id) ?? ''] }))
  const edges: GraphEdge[] = DEPENDS.map(([dependent, on], at) => ({
    from: on,
    to: dependent,
    at: 0.5 + at * 0.13,
    flow: 1 + at * 0.13,
  }))
  return figure(
    graph(nodes, edges, { height: 400, cycle: 6.4, baselines: [21, 38, 53], noteMono: true }),
    `The real workspace dependency graph, animated in <code>pnpm build</code> order: ` +
      `${PACKAGES.slice(0, 8)
        .map((each) => enc(each.title.replace('@weftjs/', '')))
        .join(
          ' · ',
        )}. Every arrow is an actual dependency, and a test fails the build if one stops being one.`,
  )
}

/* ── 2 · the request ──────────────────────────────────────────────────────── */

const STATES: readonly GraphNode[] = [
  { id: 'received', x: 0, y: 18, w: 224, h: 59, title: 'received', notes: ['the request arrives'], at: 0 },
  {
    id: 'envelope',
    x: 268,
    y: 18,
    w: 224,
    h: 59,
    title: 'envelope',
    notes: ['status · headers · cookies'],
    accent: true,
    at: 1.05,
  },
  {
    id: 'planned',
    x: 536,
    y: 18,
    w: 224,
    h: 59,
    title: 'planned',
    notes: ['keys resolved, waves built'],
    at: 2.1,
  },
  {
    id: 'streaming',
    x: 804,
    y: 18,
    w: 224,
    h: 59,
    title: 'streaming',
    notes: ['slots land as they finish'],
    at: 3.15,
  },
  { id: 'settled', x: 1072, y: 18, w: 224, h: 59, title: 'settled', notes: ['last byte'], at: 4.2 },
]

function request(): string {
  const order = STATES.map((each) => each.id)
  const edges: GraphEdge[] = order.slice(0, -1).map((from, at) => ({
    from,
    to: order[at + 1] as string,
    at: 0.7 + at * 1.05,
    flow: 1.15 + at * 1.05,
  }))
  const phases = `<div class="phases">
    <div class="phase lit">
      <p class="phase-head">Valid here · phase A, EnvelopeContext</p>
      <div class="phase-calls">${['status()', 'header()', 'cookie()', 'sendEarlyHints()']
        .map((call) => `<span>${enc(call)}</span>`)
        .join('')}</div>
      <p class="phase-say">103 Early Hints goes out here at effectively zero milliseconds, with the envelope
        still open — and it reports whether it actually went out.</p>
    </div>
    <div class="phase">
      <p class="phase-head">Not available here · phase B, RenderContext</p>
      <div class="phase-calls">${['read()', 'slot()'].map((call) => `<span>${enc(call)}</span>`).join('')}</div>
      <p class="phase-say">Cache-Control and Vary are written before the seal, from the resolved keys. After
        it, there is nothing to write them with.</p>
    </div>
  </div>`
  return figure(
    graph(STATES, edges, { height: 124, cycle: 6 }) + phases,
    'Five states, and a hard line through the middle of them. Writing a header after the response has begun ' +
      'is not a rule you have to remember here; it is a method that does not exist on the type you are holding.',
  )
}

/* ── 3 · the waves ────────────────────────────────────────────────────────── */

/**
 * Nine slots, and the kernel's own scheduler run over them.
 *
 * The waves, the start times, the critical path and the sequential total are all computed by
 * `schedule()` and `criticalPath()` from `@weftjs/kernel` — the functions the request path itself
 * calls. Nothing on this figure is a number somebody worked out and typed: change a duration here
 * and every bar, every keyframe and both totals move, because they are all derived from it.
 */
const SLOTS: readonly (DagNode & { reads: string })[] = [
  { name: 'header', ms: 20, reads: 'reads nothing' },
  { name: 'nav', ms: 10.9, reads: 'reads nothing' },
  { name: 'items', ms: 20, reads: 'reads the cart' },
  { name: 'feed', ms: 22, reads: 'reads the feed' },
  { name: 'total', needs: ['items'], ms: 9.3, reads: 'needs items' },
  { name: 'prices', needs: ['items'], ms: 8.4, reads: 'needs items' },
  { name: 'related', needs: ['feed'], ms: 14, reads: 'needs feed' },
  { name: 'summary', needs: ['total', 'prices'], ms: 12, reads: 'needs total, prices' },
  { name: 'footer', needs: ['related'], ms: 6.7, reads: 'needs related' },
]

/** The full width of the clock, ms. One tick every 10, and the axis has room past the last bar. */
const CLOCK = 48

/** When each slot starts: the moment the last slot it names has landed. */
function starts(): Map<string, number> {
  const at = new Map<string, number>()
  const by = new Map(SLOTS.map((slot) => [slot.name, slot]))
  const settle = (name: string): number => {
    const slot = by.get(name)
    if (!slot) throw new Error(`E_DOCS_NO_SLOT: ${name}`)
    const from = at.get(name)
    if (from !== undefined) return from + (slot.ms ?? 0)
    const begin = Math.max(0, ...(slot.needs ?? []).map((need) => settle(need)))
    at.set(name, begin)
    return begin + (slot.ms ?? 0)
  }
  for (const slot of SLOTS) settle(slot.name)
  return at
}

function waves(): string {
  const plan = schedule([...SLOTS])
  const path = criticalPath([...SLOTS])
  const critical = new Set(path.path)
  const at = starts()
  const pct = (ms: number) => (ms / CLOCK) * 100

  const columns = plan.waves.map((wave) =>
    // The scheduler sorts a wave by name; the figure reads better in the order the slots were
    // declared, which is the order the route file has them in.
    SLOTS.filter((slot) => wave.includes(slot.name)),
  )
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  columns.forEach((column, col) => {
    const height = column.length * 72 - 13
    column.forEach((slot, row) => {
      nodes.push({
        id: slot.name,
        x: 6 + col * 522,
        y: (330 - 45 - height) / 2 + row * 72,
        w: 200,
        h: 59,
        title: slot.name,
        notes: [slot.reads],
        accent: critical.has(slot.name),
        at: col * 1.7,
      })
    })
  })
  for (const slot of SLOTS) {
    for (const need of slot.needs ?? []) {
      const col = columns.findIndex((column) => column.some((each) => each.name === slot.name))
      edges.push({ from: need, to: slot.name, at: col * 1.5, flow: col * 1.5 + 0.45 })
    }
  }

  const heads = plan.waves
    .map((wave, at2) => `<span>wave ${at2 + 1}${at2 === 0 ? ` — all ${wave.length} at once` : ''}</span>`)
    .join('')

  const rows = SLOTS.map((slot, index) => {
    const from = at.get(slot.name) ?? 0
    return `<div class="gantt-row${critical.has(slot.name) ? ' lit' : ''}">
      <span class="gantt-name">${enc(slot.name)}</span>
      <span class="gantt-track"><span data-wf class="gantt-bar" style="left:${pct(from).toFixed(
        2,
      )}%;width:${pct(slot.ms ?? 0).toFixed(2)}%;animation:wf-g${index} 6s linear infinite"></span></span>
      <span class="gantt-ms">${(slot.ms ?? 0).toFixed(1)} ms</span>
    </div>`
  }).join('')

  const ticks = [0, 10, 20, 30, 40]
    .map((ms) => `<span class="gantt-tick" style="left:${pct(ms).toFixed(2)}%">${ms}</span>`)
    .join('')

  return figure(
    `<div class="wave-heads">${heads}</div>
    ${graph(nodes, edges, { height: 330, cycle: 6 })}
    <div class="gantt">
      <p class="gantt-head">What runs when — the same ${SLOTS.length} slots on a clock</p>
      ${rows}
      <div class="gantt-row axis">
        <span class="gantt-name"></span>
        <span class="gantt-track">${ticks}
          <span class="gantt-tick lit" style="left:${pct(path.ms).toFixed(2)}%">${path.ms.toFixed(1)} ms</span>
          <span data-wf class="gantt-play" style="animation:wf-play80 6s linear infinite"></span>
        </span>
        <span class="gantt-ms"></span>
      </div>
      <div class="gantt-row sum">
        <span class="gantt-name">sequential</span>
        <span class="gantt-track"><span data-wf class="gantt-bar"
          style="left:0;width:100%;animation:wf-grow 6s cubic-bezier(.2,.7,.3,1) infinite"></span></span>
        <span class="gantt-ms">${path.sequentialMs.toFixed(1)} ms</span>
      </div>
    </div>
    ${ganttKeyframes()}`,
    `Nothing in wave 1 depends on anything, so all ${plan.waves[0]?.length ?? 0} start at once — the bars ` +
      'leave the origin together and the wave finishes when its slowest member does. Wave 2 begins per slot, ' +
      'the moment the slot it names lands: ' +
      `${enc('total')} and ${enc('prices')} at ${at.get('total')?.toFixed(0)} ms when ${enc('items')} ` +
      `finishes, ${enc('related')} at ${at.get('related')?.toFixed(0)} ms when ${enc('feed')} does. ` +
      `${SLOTS.length} slots take ${path.ms.toFixed(1)} ms concurrently against ` +
      `${path.sequentialMs.toFixed(1)} ms one after another, and the accent chain is the critical path.`,
  )
}

/**
 * The bars' keyframes, generated from the schedule.
 *
 * A bar has to grow while its slot runs and then *hold* until the cycle ends, and how far into the
 * cycle it starts and stops is different for every one of the nine — which a shared keyframe with a
 * per-bar delay cannot express, because a delay moves the whole curve rather than one edge of it.
 *
 * So these nine are computed rather than written, and they are the only CSS on this site that is
 * not in a stylesheet: they are data, they change when a duration changes, and a hand-maintained
 * copy in `styles.css` would be nine chances to disagree with the chart beside it. The playhead
 * reaches the end of the clock at 80% of the cycle, so a slot at `ms` is at `ms / 48 * 80` percent.
 */
function ganttKeyframes(): string {
  const at = starts()
  const frames = SLOTS.map((slot, index) => {
    const from = ((at.get(slot.name) ?? 0) / CLOCK) * 80
    const to = from + ((slot.ms ?? 0) / CLOCK) * 80
    return (
      `@keyframes wf-g${index}{0%,${from.toFixed(1)}%{transform:scaleX(0)}` +
      `${to.toFixed(1)}%,94%{transform:scaleX(1)}100%{transform:scaleX(0)}}`
    )
  }).join('')
  return `<style>${frames}</style>`
}

/* ── 4 · the tiers ────────────────────────────────────────────────────────── */

function tiers(files: number): string {
  const nodes: GraphNode[] = [
    { id: 'request', x: 6, y: 104, w: 160, h: 41, title: 'a request', at: 0 },
    {
      id: 'l0',
      x: 400,
      y: 6,
      w: 520,
      h: 59,
      title: 'L0 — a file',
      notes: ['.weft/static/ · answered before the kernel is reached, with an ETag and a 304'],
      accent: true,
      at: 0.9,
    },
    {
      id: 'kernel',
      x: 400,
      y: 104,
      w: 520,
      h: 59,
      title: 'the kernel',
      notes: ['envelope · keys · waves · the stream — 8,118 B on the document path'],
      at: 1.8,
    },
    {
      id: 'hop',
      x: 400,
      y: 202,
      w: 520,
      h: 59,
      title: 'a region hop',
      notes: ['another process · a service binding · another pod — over Warp frames'],
      at: 2.7,
    },
    {
      id: 'not-modified',
      x: 1080,
      y: 10,
      w: 232,
      h: 74,
      title: '304, no body',
      notes: [`${files} of this site’s pages stop`, 'here'],
      accent: true,
      at: 1.2,
    },
    {
      id: 'dynamic',
      x: 1080,
      y: 206,
      w: 232,
      h: 74,
      title: 'static: false',
      notes: ['/play and /search, with a reason', 'each'],
      at: 3.1,
    },
  ]
  const edges: GraphEdge[] = [
    { from: 'request', to: 'l0', at: 0.5, flow: 0.95 },
    { from: 'l0', to: 'not-modified', at: 1, flow: 1.45 },
    { from: 'l0', to: 'kernel', down: true, at: 1.5, flow: 1.95 },
    { from: 'kernel', to: 'hop', down: true, at: 2.4, flow: 2.85 },
    { from: 'hop', to: 'dynamic', at: 3, flow: 3.45 },
  ]
  return figure(
    graph(nodes, edges, { height: 290, cycle: 6 }),
    'A request falls only as far as it must. <code>weft build</code> renders every route twice under two ' +
      'deliberately different requests and writes the byte-identical ones out as files; what cannot be a ' +
      'file says why, in the build output, every time.',
  )
}

/* ── 5 · the negotiation ──────────────────────────────────────────────────── */

function negotiation(): string {
  const nodes: GraphNode[] = [
    {
      id: 'held',
      x: 6,
      y: 100,
      w: 250,
      h: 74,
      title: 'HELD',
      notes: ['the client names the template version', 'and the base render it holds'],
      at: 0,
    },
    {
      id: 'template',
      x: 336,
      y: 100,
      w: 250,
      h: 59,
      title: 'holds the template?',
      notes: ['advertised as a coarse digest'],
      at: 0.9,
    },
    {
      id: 'projectable',
      x: 666,
      y: 100,
      w: 260,
      h: 74,
      title: 'values projectable?',
      notes: ['a raw() value, an isolated instance or a', 'slot hole says no'],
      at: 1.8,
    },
    {
      id: 'delta',
      x: 1006,
      y: 10,
      w: 306,
      h: 74,
      title: 'delta — 371 B · 187 brotli',
      notes: ['one write per changed value, into DOM that', 'already exists'],
      accent: true,
      at: 2.7,
    },
    {
      id: 'patch',
      x: 1006,
      y: 118,
      w: 306,
      h: 59,
      title: 'patch — 4.3–6.0× smaller',
      notes: ['addressed the way adoption addresses the DOM'],
      at: 3,
    },
    {
      id: 'html',
      x: 1006,
      y: 218,
      w: 306,
      h: 59,
      title: 'html — 6,289 B · 605 brotli',
      notes: ['the whole region, re-parsed'],
      at: 3.3,
    },
  ]
  const edges: GraphEdge[] = [
    { from: 'held', to: 'template', at: 0.5, flow: 0.95 },
    { from: 'template', to: 'projectable', at: 1.4, flow: 1.85 },
    { from: 'projectable', to: 'delta', at: 2.3, flow: 2.75 },
    { from: 'projectable', to: 'patch', at: 2.5, flow: 2.95 },
    { from: 'template', to: 'html', at: 2.7, flow: 3.15 },
  ]
  return figure(
    `${graph(nodes, edges, { height: 300, cycle: 6 })}
    <p class="gfx-note">A delta is memoized under <code>delta:&lt;tpl&gt;:&lt;from&gt;-&gt;&lt;to&gt;</code>,
      so a thousand clients on one base cost one diff — 0.3 ms against a per-connection differ’s 8.2 ms. A
      thousand clients each on a different base share nothing, and the shared path then costs 17.3 ms against
      9.2.</p>`,
    'All three forms produce identical DOM, so which one you get is never something you have to reason ' +
      'about: you write the fragment once and delivery is negotiated underneath it.',
  )
}

/* ── 6 · the build ────────────────────────────────────────────────────────── */

function build(files: number): string {
  const stages: readonly { title: string; note: string; accent?: boolean }[] = [
    { title: 'app/**.tsx', note: 'what you wrote' },
    { title: 'Oxc', note: 'parse — no bundler' },
    {
      title: `IR ${version('Template IR')}`,
      note: 'segments · holes · effects',
    },
    { title: 'sealed templates', note: 'and the generated plan' },
    { title: 'manifest', note: 'every URL carries a digest' },
    { title: `${files} files`, note: 'served without the kernel', accent: true },
  ]
  const nodes: GraphNode[] = stages.map((stage, at) => ({
    id: String(at),
    x: at * 222,
    y: 16,
    w: 198,
    h: 59,
    title: stage.title,
    notes: [stage.note],
    ...(stage.accent === true ? { accent: true } : {}),
    at: at * 0.85,
  }))
  const edges: GraphEdge[] = stages.slice(0, -1).map((_, at) => ({
    from: String(at),
    to: String(at + 1),
    at: 0.45 + at * 0.85,
    flow: 0.9 + at * 0.85,
  }))
  return figure(
    `${graph(nodes, edges, { height: 108, cycle: 6 })}
    <p class="gfx-aside"><code>weft dev</code><span>serves the same bytes at stable names with no-store — a
      stylesheet you just edited, served as immutable, is a framework that lies to you for a year.</span></p>`,
    'Client modules are TypeScript with their types stripped by Node and two bare specifiers rewritten, so ' +
      'what runs in the browser is the file on disk.',
  )
}

/* ── the section ──────────────────────────────────────────────────────────── */

/** The three things, and the job each one has. It closes the section and opens the directory. */
function three(): string {
  const items = [
    {
      what: 'spec/',
      says: 'the reference: the mechanism, its refusals, and what each deliberately does not do',
    },
    { what: '@weftjs/inspector', says: 'the live version: a station per capability, each with a control' },
    { what: 'this guide', says: 'the introduction: what it is, in order, with examples that run' },
  ]
  return `<div class="arch-three">${items
    .map(
      (item) => `<div><span class="arch-what">${enc(item.what)}</span>
        <p>${enc(item.says)}</p></div>`,
    )
    .join('')}</div>`
}

export interface ArchCounts {
  /** How many of this site's routes `weft build` wrote out as files. */
  files: number
  /** How many pages the directory below lists. */
  pages: number
}

export function architecture(counts: ArchCounts): string {
  return `<section class="arch">
    <div class="arch-where">
      <span class="arch-tag">/guide — the front door</span>
      <span class="arch-note">This is the top of the Guide index. It opens the page; the directory of all
        ${counts.pages} pages sits directly below it, on the same route.</span>
      <a class="arch-down" href="#directory">The page directory ↓</a>
    </div>
    <p class="kicker">Before the ${counts.pages} pages</p>
    <h1 class="arch-title">The architecture, and where every idea lives in it</h1>
    <p class="arch-lede">${PACKAGES.length - 2} packages, one request path, three tiers and three wire forms.
      Read this page and the rest of the guide is detail: each later page takes one box out of these diagrams
      and shows what it refuses. Everything below is the real dependency graph and the real state machine —
      every figure states what it measured and on what.</p>

    ${heading(
      '1',
      'Ten packages, and what each one is allowed to know',
      'The dependency direction is the design. <code>@weftjs/ir</code> and <code>@weftjs/warp</code> are data ' +
        'formats with no dependencies at all; the kernel knows about those two and nothing else, which is ' +
        'what lets the same kernel run on Node, Deno, Bun, a worker and the edge with no adapter to choose. ' +
        'The client package sits beside the server rather than under it, so one code path serves a socket, ' +
        'an SSE stream and a test.',
    )}
    ${packages()}

    ${heading(
      '2',
      'One request, and the line through the middle of it',
      'A document request is a state machine, and the envelope closes partway through it. Everything a ' +
        'response header can say has to be said before that point — which is why the two halves are ' +
        'different context types rather than the same object with a rule attached.',
    )}
    ${request()}

    ${heading(
      '3',
      'What runs at once, and what has to wait',
      'Inside <code>planned</code>, the slots become waves. A slot that names another in <code>needs</code> ' +
        'lands in a later one; everything else goes together. The saving is real and bounded, and the reason ' +
        'it is safe is a property of the whole design rather than a scheduler trick.',
    )}
    ${waves()}

    ${heading(
      '4',
      'Three tiers, and how far a request falls',
      'The fastest request is the one the kernel never sees. <code>weft build</code> renders every route ' +
        'twice under two deliberately different requests and writes the byte-identical ones out as files, so ' +
        '<code>weft start</code> can answer them before routing. What cannot be a file says why, in the ' +
        'build output, every time.',
    )}
    ${tiers(counts.files)}

    ${heading(
      '5',
      'The negotiation this framework is named for',
      'A region that changed has three ways onto the wire, and the kernel picks per request from what the ' +
        'client says it holds. The fragment is unaware of all of it: the same declaration serves a first ' +
        'visit, a surgical refresh and a client holding a template from last week.',
    )}
    ${negotiation()}

    ${heading(
      '6',
      'From your files to what the browser fetches',
      'The build produces sealed templates, a generated plan, a manifest and revved assets — and prints ' +
        'which pages became files. Nothing is bundled at any point, which is why the byte budget is measured ' +
        'on the real walk over HTTP: 46,698 B brotli for the demo, agreeing within 0.3% with the same walk ' +
        'over the bundle.',
    )}
    ${build(counts.files)}
    ${three()}
  </section>`
}

/**
 * Every arrow in figure 1, checked against the manifest that would have to declare it.
 *
 * Exported so `test/docs.test.ts` can run it: a diagram is the one kind of documentation nobody
 * re-reads, so the drift has to be caught by something that does.
 */
export function drawnDependencies(): readonly (readonly [string, string])[] {
  return DEPENDS.map(
    ([dependent, on]) => [packageName(dependent as string), packageName(on as string)] as const,
  )
}

/**
 * A node id back to the name its `package.json` carries.
 *
 * The framework's node is `weft` because that is the command and the directory; the package is
 * `@weftjs/core`, because npm already serves a `weft` belonging to somebody else.
 */
function packageName(id: string): string {
  if (id === 'weft') return '@weftjs/core'
  if (id === 'create') return 'create-weft'
  return `@weftjs/${id}`
}
