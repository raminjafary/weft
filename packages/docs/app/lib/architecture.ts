import { criticalPath, schedule, serverCapabilities, type DagNode } from '@weftjs/kernel'
import { FRAMES, negotiate, WARP_VERSION, type Transport } from '@weftjs/warp'
import { escapeHtml } from './escape.ts'
import { graph, type GraphEdge, type GraphNode } from './graph.ts'
import { artifacts } from './versions.ts'
import { demoWeight, entryFor } from './budgets.ts'
import { deltaClients, deltaCost, download } from './measured.ts'
import { measured as benchRow } from './bench.ts'

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

/**
 * A wire form's size, from the run that measured it.
 *
 * The same two figures the landing page draws, and they were typed in both places from one
 * measurement — so the delta's compressed size had drifted to 190 here and stayed 187 there. The
 * patch rung carried a ratio no run in `results/` measures at all, which is why it now says where
 * it sits rather than by how much.
 */
function wireSize(candidate: string): string {
  const found = benchRow('update-bytes', candidate, undefined, 'feed')
  if (!found) return 'not measured'
  const raw = `${found.p50.toLocaleString('en-US')} B`
  return found.brotli === undefined ? raw : `${raw} · ${found.brotli.toLocaleString('en-US')} brotli`
}

/**
 * A measured size, or the word for not having one.
 *
 * Both of these were transcribed and both had drifted — the client's by 28 bytes and the kernel's
 * by 155, the latter into disagreeing with the figure `/api/kernel` derives for the same thing.
 * Reading them means the diagram is one commit behind the gate at worst, rather than however many
 * commits it has been since somebody last retyped it.
 */
function bytes(measured: number | undefined): string {
  return measured === undefined ? 'measured by pnpm bench budget' : `${measured.toLocaleString('en-US')} B`
}

/** The notes under each box: what the package is, and the one number that pins it down. */
function packageNotes(): Map<string, string> {
  return new Map([
    ['ir', `${version('Template IR')} · no deps`],
    ['warp', `${version('Warp frames')} · no deps`],
    ['client', `${bytes(entryFor('runtime')?.brotli)} brotli`],
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
export const SLOTS: readonly (DagNode & { reads: string })[] = [
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
      notes: [
        `envelope · keys · waves · the stream — ${bytes(entryFor('kernel')?.brotli)} on the document path`,
      ],
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
      notes: ['/play, and the build says why', 'it cannot be one'],
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
      title: `delta — ${wireSize('segments:delta')}`,
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
      title: 'patch — between the two',
      notes: ['addressed the way adoption addresses the DOM'],
      at: 3,
    },
    {
      id: 'html',
      x: 1006,
      y: 218,
      w: 306,
      h: 59,
      title: `html — ${wireSize('segments:html')}`,
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
      so ${deltaClients()} clients on one base cost one diff — ${deltaCost('shared', 'aligned')} against a
      per-connection differ’s ${deltaCost('per-connection', 'aligned')}. The same clients each on a different
      base share nothing, and the shared path then costs ${deltaCost('shared', 'staggered')} against
      ${deltaCost('per-connection', 'staggered')}.</p>`,
    'All three forms produce identical DOM, so which one you get is never something you have to reason ' +
      'about: you write the fragment once and delivery is negotiated underneath it.',
  )
}

/* ── 6 · the delivery ─────────────────────────────────────────────────────── */

/**
 * The four bindings, and what each one costs — computed, not transcribed.
 *
 * The strategy and the downgrade line under each binding come from `negotiate()` itself, run here
 * at build time against `serverCapabilities()`. A page that restated them would be a page that
 * could disagree with the handshake it describes, and this is the one figure where that would
 * matter most: somebody reads it to decide where to deploy.
 */
const BINDINGS: readonly { id: string; transport: Transport; label: string; down: string; up: string }[] = [
  { id: 'socket', transport: 'socket', label: 'socket', down: 'one WebSocket', up: 'the same socket' },
  { id: 'stream', transport: 'stream', label: 'stream', down: 'a held GET response', up: 'discrete POSTs' },
  { id: 'sse', transport: 'stream', label: 'sse', down: 'text/event-stream', up: 'discrete POSTs' },
  { id: 'turn', transport: 'turn', label: 'turn', down: "the POST's own response", up: 'the same POST' },
]

/** What the server actually settles for a client arriving on each binding. */
function settled(transport: Transport): { strategy: string; resumable: boolean; downgrades: string[] } {
  const caps = serverCapabilities()
  const n = negotiate(
    {
      warp: WARP_VERSION,
      ir: caps.ir,
      forms: ['html', 'delta', 'patch'],
      transport,
      dsd: true,
      vt: true,
      sw: true,
    },
    caps,
  )
  return {
    strategy: n.strategy,
    resumable: n.resumable,
    // The form line is about this hypothetical client's own list, not about the binding, so it is
    // not what this figure is describing.
    downgrades: n.downgrades.filter((d) => !d.startsWith('forms unavailable')),
  }
}

function bindings(): string {
  const nodes: GraphNode[] = [
    {
      id: 'hello',
      x: 6,
      y: 118,
      w: 250,
      h: 74,
      title: 'RESIDENT',
      notes: ['the client names its versions,', 'the forms it takes, and the transport it has'],
      at: 0,
    },
    ...BINDINGS.map((b, i) => {
      const s = settled(b.transport)
      return {
        id: b.id,
        x: 400,
        y: 10 + i * 82,
        w: 400,
        h: 68,
        title: `${b.label} — strategy ${s.strategy}`,
        notes: [`down: ${b.down}`, `up: ${b.up}`],
        accent: b.id === 'socket',
        at: 0.9 + i * 0.25,
      } as GraphNode
    }),
    {
      id: 'warp',
      x: 880,
      y: 118,
      w: 300,
      h: 74,
      title: 'WARP',
      notes: ['every axis settled, and a named', 'downgrade for each one that was not'],
      accent: true,
      at: 2.2,
    },
  ]
  const edges: GraphEdge[] = [
    ...BINDINGS.map((b, i) => ({ from: 'hello', to: b.id, at: 0.5 + i * 0.1, flow: 0.85 + i * 0.2 })),
    ...BINDINGS.map((b, i) => ({ from: b.id, to: 'warp', at: 1.6 + i * 0.1, flow: 2.1 + i * 0.1 })),
  ]
  const turn = settled('turn')
  return figure(
    `${graph(nodes, edges, { height: 350, cycle: 6 })}
    <p class="gfx-note">Every form in figure 5 is available on every binding — a turn is a bounded
      stream, not a degraded one. What differs is only whether the server can speak without being
      asked, which is why the one binding that cannot says so on the handshake:
      <em>${enc(turn.downgrades[0] ?? '')}</em></p>`,
    'The client says which transport it has and the server says what it will do with it. Nothing ' +
      'above the handshake knows which of the four it got.',
  )
}

/**
 * The one difference between the bindings, as the thing it actually is: a delay.
 *
 * Drawn as a timeline rather than a diagram because the difference is temporal and nothing static
 * shows it. On a held binding the write and the telling are the same instant. On a turn the write
 * happens, nothing is delivered — there is no connection to deliver on — and the telling waits for
 * the reader's next request. Both rows run on one cycle so the gap is the figure.
 *
 * Every animated element carries `data-wf`, which is what the site's reduced-motion rule keys on:
 * with motion off the whole thing is still a legible diagram of the two orders of events.
 */
/**
 * When the head reaches a mark, expressed as a delay.
 *
 * `wf-travel` sweeps a playhead across the track over the first 84% of the cycle and holds it at
 * the end for the rest. So a mark standing at `p` percent is reached at `p × 0.84` of the way
 * through, and giving its own animation exactly that delay is what makes the light and the head
 * agree. Derived rather than written down twice, so they still agree when a mark moves.
 */
const HEAD_SWEEP = 0.84
const reached = (at: number, cycle: number): string => (cycle * (at / 100) * HEAD_SWEEP).toFixed(2)

function carried(): string {
  const row = (name: string, note: string, cells: string) =>
    `<div class="dlv-row"><span class="dlv-name">${enc(name)}</span>
      <div class="dlv-track"><span class="dlv-line"></span>${cells}<span class="dlv-head" data-wf
        style="animation:wf-travel 6s linear 0s infinite"></span></div>
      <span class="dlv-note">${enc(note)}</span></div>`
  const mark = (at: number, cls: string, label: string) =>
    `<span class="dlv-mark ${cls}" style="left:${at}%"><i data-wf
       style="animation:wf-step 6s linear ${reached(at, 6)}s infinite"></i>${enc(label)}</span>`
  const turn = settled('turn')
  return figure(
    `<div class="dlv">
      ${row(
        'socket, stream, sse',
        'the write and the telling are one instant',
        `${mark(6, 'dlv-write', 'a write invalidates')}${mark(40, 'dlv-told', 'STALE, pushed')}`,
      )}
      ${row(
        'turn',
        'nothing to push to, so the journal holds it until the reader asks',
        `<span class="dlv-hold"></span>${mark(6, 'dlv-write', 'the same write')}${mark(
          62,
          'dlv-ask',
          'the reader’s next turn',
        )}${mark(88, 'dlv-told', 'STALE, carried')}`,
      )}
    </div>
    <p class="gfx-note">Both rows run on one clock, so the gap is the figure. The dashes are the
      stretch where a held binding has already told the reader and a turn has nobody to tell:
      <em>${enc(turn.downgrades[0] ?? '')}</em></p>`,
    'The whole of what a turn gives up, drawn to scale: not whether the reader is told, but when. ' +
      'Everything the client asks for is answered on the same request that asked.',
  )
}

/**
 * What each frame is for, in a phrase — the one half of the vocabulary a program cannot supply.
 *
 * The *set* and the direction of travel are read from `FRAMES` itself, so a frame added to the
 * protocol appears here without anybody remembering to add it. What cannot be derived is what it
 * means, so that is written down — and `test/docs.test.ts` asserts this record covers the table
 * exactly, which turns "somebody forgot" into a failing build rather than a gap on the page.
 */
export const FRAME_SAYS: Record<string, string> = {
  RESIDENT: 'what I am: versions, forms, transport, engine',
  HELD: 'what I am showing, per region',
  REFRESH: 'this region, again',
  WARM: 'stage this and paint nothing — a template, a route, or a subtree of the plan',
  INTENT: 'run this write',
  RESUME: 'I was evicted; continue from this epoch',
  WARP: 'everything settled, and every downgrade named',
  SHELL: 'the document around the holes',
  SLOT: 'a hole, and which region fills it',
  HTML: 'the whole region, as markup',
  TPL: 'a sealed template you did not hold',
  DATA: 'values, for a region that can project them',
  DELTA: 'only what changed, against a base you named',
  PATCH: 'addressed the way adoption addresses the DOM',
  SIGNAL: 'a shell value a region on this page consumes',
  COMMIT: 'paint the epoch — the only frame that changes what is seen',
  MOD: 'a module this region needs',
  CSS: 'a stylesheet, before the thing it styles paints',
  STALE: 'something you hold is known wrong; ask when you like',
  NAV: 'the route you staged, and whether it shares this shell',
  PLAN: 'routes you have not been to, and what they cost',
  ERROR: 'refused, by name',
  REDIRECT: 'go here instead',
  COOKIE: 'set this, because a channel is not a response',
  ACK: 'your intent, and whether its epoch survives',
  REGION: 'frames another deployment produced, passed through',
}

/** Every frame kind, split by which way it travels — read from the protocol, not retyped. */
export function frameVocabulary(): { up: string[]; down: string[] } {
  const up: string[] = []
  const down: string[] = []
  for (const [kind, spec] of Object.entries(FRAMES)) {
    ;((spec as { dir: string }).dir === 'up' ? up : down).push(kind)
  }
  return { up, down }
}

function vocabulary(): string {
  const { up, down } = frameVocabulary()
  const col = (title: string, note: string, kinds: string[], base: number) =>
    `<div class="voc-col">
      <h4>${enc(title)}<span>${enc(note)}</span></h4>
      <ul>${kinds
        .map(
          (k, i) =>
            `<li data-wf style="animation:wf-nodein 9s linear ${(base + i * 0.12).toFixed(2)}s infinite">
              <code>${enc(k)}</code><span>${enc(FRAME_SAYS[k] ?? '')}</span></li>`,
        )
        .join('')}</ul>
    </div>`
  return figure(
    `<div class="voc">
      ${col('Up', `${up.length} kinds — everything a client can ask`, up, 0.2)}
      ${col('Down', `${down.length} kinds — everything a server can say`, down, 0.5)}
    </div>
    <p class="gfx-note">One vocabulary, every binding. A turn narrows <em>when</em> the right-hand
      column can be sent, never which of it exists — which is why the same client code applies
      frames from a socket, from an event stream and from a POST response without knowing the
      difference.</p>`,
    `${up.length + down.length} frame kinds is the entire protocol surface. The set and the ` +
      'direction here are read from the frame table itself, so this figure cannot drift from it.',
  )
}

/**
 * An epoch: frames that arrive and deliberately do not paint.
 *
 * The other figure on this page that has to move, and for the same reason as the delivery timeline
 * — the whole idea is an ordering. Data lands, and nothing changes on screen. More data lands.
 * Then one `COMMIT`, and everything appears at once. Drawn statically it is two lists; drawn in
 * time it is the reason a background revalidation cannot disturb a half-typed form.
 */
function epochs(): string {
  /**
   * One lane, and the thing that makes the two of them different to look at.
   *
   * Marks in the same places on both lanes, because the frames arrive at the same times — that is
   * the premise. What differs is the screen on the right, which flashes once per *paint*: three
   * times on the lane with no epoch, once on the lane with one. Without it the two rows were the
   * same drawing in two colours, and the idea being shown — that nothing changes until it all
   * changes — was the one thing the figure did not do.
   */
  const lane = (
    name: string,
    note: string,
    cells: readonly { at: number; label: string; paint: boolean }[],
  ) =>
    `<div class="ep-lane">
      <span class="ep-name">${enc(name)}</span>
      <div class="ep-track"><span class="dlv-line"></span>${cells
        .map(
          (c) =>
            `<span class="ep-cell${c.paint ? ' ep-paint' : ''}" style="left:${c.at}%"><i data-wf
              style="animation:wf-step 7s linear ${reached(c.at, 7)}s infinite"></i>${enc(c.label)}</span>`,
        )
        .join(
          '',
        )}<span class="dlv-head" data-wf style="animation:wf-travel 7s linear 0s infinite"></span></div>
      <div class="ep-screen"><span class="ep-screen-label">what the reader sees</span>${cells
        .filter((c) => c.paint)
        .map(
          (c) =>
            `<span class="ep-flash" data-wf
              style="animation:wf-flash 7s linear ${reached(c.at, 7)}s infinite"></span>`,
        )
        .join('')}</div>
      <span class="dlv-note">${enc(note)}</span>
    </div>`
  return figure(
    `<div class="dlv">
      ${lane('without epochs', 'every frame paints as it lands, including the ones nobody asked for', [
        { at: 8, label: 'DELTA — paints', paint: true },
        { at: 38, label: 'DELTA — paints', paint: true },
        { at: 70, label: 'DELTA — paints', paint: true },
      ])}
      ${lane('staged in an epoch', 'three frames change nothing; one COMMIT changes everything, at once', [
        { at: 8, label: 'DELTA — staged', paint: false },
        { at: 38, label: 'DELTA — staged', paint: false },
        { at: 70, label: 'COMMIT — paints', paint: true },
      ])}
    </div>
    <p class="gfx-note">One clock, two lanes, and the head reaches the same three moments in each.
      Only the accent marks changed what the reader sees — which on the second lane is the last one
      alone. A frame carrying an epoch is invisible until its <code>COMMIT</code>, and that is a
      property of where frames are routed rather than of anything an application remembers to do. It
      is also what makes a staged route possible: a whole page can be resolved and held, painting
      nothing, until the reader actually clicks.</p>`,
    'Nothing paints on arrival unless the frame says to — which is what lets the server revalidate ' +
      'under a reader without ever disturbing what they are doing.',
  )
}

/** The axes the handshake settles, each with what it decides and what it costs to lose. */
const AXES: readonly { key: string; is: string; lost: string }[] = [
  {
    key: 'warp',
    is: 'the frame protocol version, settled to the lower of the two',
    lost: 'a major mismatch is fatal on the frame that settles it: the stream is unusable and nothing renders under it, rather than frames arriving that depend on a version nobody has',
  },
  {
    key: 'ir',
    is: 'the template format the client can apply',
    lost: 'a major mismatch drops every client to html — the whole region, re-parsed — because a delta names paths into a template shape it does not have',
  },
  {
    key: 'forms',
    is: 'which of html, delta, patch, split and bundle this client accepts',
    lost: 'the kernel picks the smallest form both sides hold; a client that takes only html gets html, over the wire and not merely in the plan',
  },
  {
    key: 'strategy',
    is: 'how frames move: socket, stream, or collapse',
    lost: 'collapse is the webview case — the host app buffers the document, so holes cannot arrive out of order and slots fold into the document instead',
  },
  {
    key: 'fill',
    is: 'declarative shadow DOM, or a script that moves the nodes',
    lost: 'a client without incremental DSD parsing is filled by script; the DOM is identical either way',
  },
  {
    key: 'commit',
    is: 'whether an epoch commits inside a view transition',
    lost: 'without one the commit is instant — still atomic, just not animated',
  },
  {
    key: 'residency',
    is: 'where resident templates live: a service worker, IndexedDB, or the HTTP cache',
    lost: 'the HTTP cache is the floor, and repeat-visit gains stop being guaranteed',
  },
  {
    key: 'resumable',
    is: 'whether this client may come back with RESUME and continue',
    lost: 'a buffered transport cannot, so an evicted webview starts over rather than continuing from its last commit',
  },
]

function axes(): string {
  return `<dl class="arch-defs">${AXES.map(
    (a) => `<dt><code>${enc(a.key)}</code></dt><dd><b>${enc(a.is)}.</b> ${enc(a.lost)}</dd>`,
  ).join('')}</dl>`
}

/* ── 7 · the build ────────────────────────────────────────────────────────── */

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
      'How a frame reaches the browser at all',
      'Figure 5 is one negotiation and this is the other, and conflating them is the usual mistake. ' +
        '<em>Form</em> decides what a region becomes on the wire. <em>Delivery</em> decides how any frame ' +
        'gets there — and the two are independent, so every form is available on every binding.',
    )}
    ${bindings()}
    ${vocabulary()}

    <div class="arch-prose">
      <p>The whole handshake is one frame each way. The client sends <code>RESIDENT</code>: the protocol
        version it speaks, the template format it can apply, the wire forms it accepts, the transport it
        actually has, and what its engine can do — incremental declarative shadow DOM, view transitions, a
        service worker, IndexedDB. The server answers <code>WARP</code>, which settles every axis at once and
        carries a named line for each one it could not honour.</p>

      <p>That list of names is the part worth dwelling on. A framework that degrades silently is a framework
        whose failures look like bugs: a region that never updates and a navigation that is always a document
        are the same symptom whether the cause is a blocked port, a proxy eating an upgrade, or a client three
        template majors behind. So nothing degrades quietly here. Every downgrade is a sentence on the frame
        that settled it, which is why the one thing a turn cannot do is written into its handshake rather than
        into a paragraph somebody has to find.</p>

      <h3>What the handshake settles</h3>
      ${axes()}

      <h3>The four bindings, and the one that holds nothing</h3>
      <p>Three of the four hold a downstream open, and answer <em>down it</em>. A socket is one connection
        carrying both directions. The streamed binding is a long-lived GET with discrete POSTs going up, and
        the SSE binding is the same arrangement in text framing — which is why it is not the default, since it
        cannot carry binary and pays base64 on every body. All three share one consequence: the server can
        speak first. An invalidation reaches the reader the moment the write happens.</p>

      <p>The fourth holds nothing. A <code>turn</code> carries frames up in a request body and the answer back
        in that request's own response, so it is a function from bytes to bytes with no state between calls.
        That is the only shape that runs on a platform which terminates no upgrade and outlives no request —
        a serverless function — and it needs no server memory because the protocol was already
        client-authoritative: <code>RESIDENT</code> says what the client holds and <code>HELD</code> says what
        it is showing, both in the same body, so a channel built for one request answers exactly as a socket
        would. It opens, is used, and is dropped.</p>

      <p>What it gives up is the ability to be spoken to. With no held downstream there is nowhere to put an
        unasked <code>STALE</code>, so an invalidation waits and is carried on the next turn — which is a real
        limitation and a small one, because everything a client <em>asks</em> for it still gets: intents,
        surgical refreshes, a whole route staged before it is clicked.</p>

      <h3>Which one you get, and who decides</h3>
      <p>The client does not guess. A deployment that cannot hold a connection says so, and the client takes
        turns from its first request. Guessing is worse than it sounds: the upgrade fails, the streamed GET
        then <em>appears</em> to work, and the POSTs that follow land on whichever instance the platform
        happened to route to — so a channel that is merely unavailable ends up looking broken, intermittently.
        A deployment that did not say is still not stranded: the first refusal switches bindings and takes the
        refused frames as a turn rather than losing them.</p>

      <h3>The difference, drawn to scale</h3>
    </div>

    ${carried()}

    <div class="arch-prose">
      <p>The gap a turn leaves is filled from outside the hub, by whichever of two things a deployment
        needs. A <em>fanout</em> carries an invalidation to the other instances holding a connection right now,
        which is what more than one replica requires whatever binding it serves. A <em>journal</em> writes down
        what a client with no connection will ask for later. The hub knows about neither: it takes one hook and
        tells whatever is on the other end, because which of them applies is a property of the deployment and
        not of the protocol.</p>
    </div>

    ${heading(
      '7',
      'What paints, and when',
      'Frames arriving is not the same as the page changing, and keeping those two apart is what ' +
        'makes a background revalidation safe. Data staged under an epoch is resolved, held, and ' +
        'invisible; only <code>COMMIT</code> paints, and it paints all of it at once.',
    )}
    ${epochs()}

    ${heading(
      '8',
      'From your files to what the browser fetches',
      'The build produces sealed templates, a generated plan, a manifest and revved assets — and prints ' +
        'which pages became files. Nothing is bundled at any point, which is why the byte budget is measured ' +
        `on the real walk over HTTP: ${demoWeight().brotli.toLocaleString('en-US')} B brotli for the demo, ` +
        `agreeing within ${download().drift} with the same walk over the build's own graph.`,
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
