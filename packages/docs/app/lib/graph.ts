import { escapeHtml } from './escape.ts'

/**
 * The one diagram primitive the architecture page draws everything with.
 *
 * Five of the six figures on that page are the same picture — labelled boxes with lines between
 * them — and drawing each one by hand would mean five chances for a stroke width, a radius or a
 * text baseline to drift apart. So there is one renderer, and a figure is a list of nodes and a
 * list of edges.
 *
 * Every edge is drawn twice: a hairline that *draws itself* from source to target, and a short
 * accent dash that runs the same path a beat later. The hairline says the dependency exists; the
 * dash says which way it points, which is the thing an arrowhead says badly at this scale and a
 * moving mark says exactly. Both are `data-wf`, so reduced motion leaves the finished graph.
 *
 * Coordinates are a viewBox, not pixels — the figure scales to whatever column it lands in, and a
 * node's position is the only thing a caller has to think about.
 */

const enc = escapeHtml

export interface GraphNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  /** Up to two lines under the title. A third would be prose, and prose belongs in the caption. */
  notes?: readonly string[]
  /** The path being traced through the figure — the kernel, the front door, the rung that wins. */
  accent?: boolean
  /** Seconds into the cycle at which this node appears. */
  at: number
}

export interface GraphEdge {
  from: string
  to: string
  /** `down` leaves the source's bottom edge instead of its right — a fall, not a hand-off. */
  down?: boolean
  /**
   * `back` leaves the source's *left* edge and arrives at the target's right — a return.
   *
   * Three of these figures are cycles rather than pipelines: the client tells the server what it
   * holds and the server answers it. Drawn as a forward edge the return would cross every node
   * between the two; drawn as a back edge it bows out to the left and reads as the answer it is.
   */
  back?: boolean
  /** Seconds into the cycle at which the hairline starts drawing. */
  at: number
  /** Seconds at which the accent dash follows it. Later than `at`, always. */
  flow: number
}

export interface GraphOptions {
  /** viewBox height, before the margin is added to both ends. */
  height: number
  /** One cycle, seconds. Every animation on the figure is a phase of this. */
  cycle: number
  /** Baselines for the title and the two note lines, measured down from the node's top edge. */
  baselines?: readonly [number, number, number]
  /** Set where the notes are identifiers rather than sentences. */
  noteMono?: boolean
}

/**
 * The margin around the drawing, in viewBox units.
 *
 * The viewBox is computed from where the nodes actually are rather than fixed at 1320 wide, so the
 * graph sits the same distance from both edges of the figure. Fixing the width instead left the
 * figures whose last column is narrow — the packages, the tiers — visibly shoved against the left
 * edge with a gap on the right, because a node's x is where it belongs relative to the *others* and
 * says nothing about where the drawing should sit in its box.
 */
const MARGIN = 12

/**
 * How far the widest note in a node reaches past its own box.
 *
 * A note is set at 11.5px and is not clipped, so `a station per mechanism` runs past the 168-unit
 * box `@weft/inspector` sits in. Ignoring that put the drawing's boxes on centre and its *text*
 * against the edge; adding a fixed allowance to the right instead made the margins visibly unequal.
 * So the reach is estimated from the text — an average advance width per character, which is close
 * enough at this size — and the viewBox grows only when a note actually needs it.
 */
const ADVANCE = { mono: 6.9, sans: 5.75 }

function noteReach(spec: GraphNode, mono: boolean): number {
  const widest = Math.max(0, ...(spec.notes ?? []).map((line) => line.length))
  return spec.x + 13 + widest * (mono ? ADVANCE.mono : ADVANCE.sans)
}

/** The horizontal control offset, with a floor: a short hop still leaves as a curve, not a jog. */
function reachX(span: number): number {
  return Math.max(span * 0.45, 28)
}

/** The same, falling. A shorter floor, because a vertical hop is a shorter gesture. */
function reachY(span: number): number {
  return Math.max(span * 0.45, 24)
}

function pathOf(from: GraphNode, to: GraphNode, spec: GraphEdge): string {
  if (spec.down === true) {
    const x = from.x + from.w / 2
    const tx = to.x + to.w / 2
    const y1 = from.y + from.h
    const y2 = to.y
    const reach = reachY(y2 - y1)
    return `M${x} ${y1} C${x} ${y1 + reach} ${tx} ${y2 - reach} ${tx} ${y2}`
  }
  if (spec.back === true) {
    const x1 = from.x
    const y1 = from.y + from.h / 2
    const x2 = to.x + to.w
    const y2 = to.y + to.h / 2
    const reach = reachX(x1 - x2)
    return `M${x1} ${y1} C${x1 - reach} ${y1} ${x2 + reach} ${y2} ${x2} ${y2}`
  }
  const x1 = from.x + from.w
  const y1 = from.y + from.h / 2
  const x2 = to.x
  const y2 = to.y + to.h / 2
  const reach = reachX(x2 - x1)
  return `M${x1} ${y1} C${x1 + reach} ${y1} ${x2 - reach} ${y2} ${x2} ${y2}`
}

/**
 * One edge, as its two strokes.
 *
 * `pathLength="600"` normalises every path to the same length whatever its real geometry, which is
 * what lets one keyframe pair drive a 24-unit hop and a 420-unit sweep at the same apparent speed.
 * Without it a long edge would draw slowly and a short one would snap, and the figure would read as
 * though distance meant duration.
 */
function edge(from: GraphNode, to: GraphNode, spec: GraphEdge, cycle: number): string {
  const d = enc(pathOf(from, to, spec))
  return (
    `<path class="gx-line" d="${d}" pathLength="600" stroke-dasharray="600" stroke-dashoffset="600"` +
    ` data-wf style="animation:wf-draw ${cycle}s linear ${spec.at.toFixed(2)}s infinite"></path>` +
    `<path class="gx-flow" d="${d}" pathLength="600" stroke-dasharray="14 586" stroke-dashoffset="600"` +
    ` data-wf style="animation:wf-flow ${cycle}s linear ${spec.flow.toFixed(2)}s infinite"></path>`
  )
}

function node(spec: GraphNode, options: GraphOptions): string {
  const [title, first, second] = options.baselines ?? [26, 44, 59]
  const notes = (spec.notes ?? []).slice(0, 2)
  const kind = spec.accent === true ? ' lit' : ''
  const text = notes
    .map(
      (line, at) =>
        `<text class="gx-note${options.noteMono === true ? ' mono' : ''}" x="${spec.x + 13}" y="${
          spec.y + (at === 0 ? first : second)
        }">${enc(line)}</text>`,
    )
    .join('')
  return (
    `<g class="gx-node${kind}" data-wf style="animation:wf-nodein ${options.cycle}s linear ${spec.at.toFixed(
      2,
    )}s infinite">` +
    `<rect x="${spec.x}" y="${spec.y}" width="${spec.w}" height="${spec.h}" rx="9"></rect>` +
    `<text class="gx-title" x="${spec.x + 13}" y="${spec.y + title}">${enc(spec.title)}</text>` +
    `${text}</g>`
  )
}

/**
 * The figure.
 *
 * Edges are emitted before nodes so the boxes paint over the lines that arrive at them, which is
 * the whole of the z-ordering this needs — SVG has no z-index, and document order is the control.
 */
export function graph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: GraphOptions,
): string {
  const by = new Map(nodes.map((each) => [each.id, each]))
  const lines = edges
    .map((spec) => {
      const from = by.get(spec.from)
      const to = by.get(spec.to)
      if (!from || !to) throw new Error(`E_DOCS_NO_NODE: ${spec.from} -> ${spec.to}`)
      return edge(from, to, spec, options.cycle)
    })
    .join('')
  const mono = options.noteMono === true
  const left = Math.min(...nodes.map((each) => each.x))
  const right = Math.max(...nodes.map((each) => Math.max(each.x + each.w, noteReach(each, mono))))
  const x = left - MARGIN
  const width = right - left + MARGIN * 2
  /**
   * The drawing decides its own size, because only the drawing knows what it is.
   *
   * `max-width` is the natural width: a 740-unit figure in a 786px column should be 740px, not
   * stretched to fill it — the labels are 13px at 1:1 and a figure scaled up past that reads as a
   * mistake. Below the floor it stops shrinking and scrolls inside `overflow-x` instead, because
   * 13px text at half scale is not a smaller diagram, it is an unreadable one. A single rule in the
   * stylesheet could not express either: one sheet serves a 740-unit hero and a 1320-unit
   * architecture figure, and their floors are different numbers.
   */
  const floor = Math.min(width, 620)
  return (
    `<svg class="gx" viewBox="${x} 0 ${width} ${options.height}" width="100%"` +
    ` style="max-width:${Math.round(width)}px;min-width:${Math.round(floor)}px" role="img">` +
    `${lines}${nodes.map((spec) => node(spec, options)).join('')}</svg>`
  )
}
