/**
 * Render is a DAG, not a tree walk. `needs` is data dependency only; the critical path, not the
 * sum, is the floor. Safe because render is provably read-only. See `spec/kernel/locus.md`.
 */
export interface DagNode {
  name: string
  /** Slots whose *results* this one consumes. */
  needs?: readonly string[]
  /** Higher runs first inside a wave, when the scheduler has a choice. */
  prio?: number
  /** Measured or estimated cost, used for the critical path. */
  ms?: number
  executor?: string
  /** A slot the page is complete without. Still scheduled, but cannot be the end of the critical path. */
  optional?: boolean
}

/** A graph refusal: a cycle, or a dependency on a slot the plan does not have. */
export class PlanGraphError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(`${code} — ${message}`)
    this.name = 'PlanGraphError'
    this.code = code
  }
}

/** The waves, in order. A slot lands in the first wave after everything it needs. */
export interface Schedule {
  waves: string[][]
  /** The widest wave. Compared against the scheduler's concurrency ceiling. */
  width: number
}

/** Slots into waves, from their declared dependencies. Watch the waves, not the sum. */
export function schedule(nodes: readonly DagNode[]): Schedule {
  const byName = new Map(nodes.map((n) => [n.name, n]))
  for (const node of nodes) {
    for (const need of node.needs ?? []) {
      if (!byName.has(need)) {
        throw new PlanGraphError('E_UNKNOWN_SLOT', `${node.name} needs ${need}, which is not in this plan`)
      }
    }
  }

  const placed = new Map<string, number>()
  const waves: string[][] = []
  let remaining = nodes.filter(() => true)

  while (remaining.length) {
    const ready = remaining.filter((n) => (n.needs ?? []).every((need) => placed.has(need)))
    if (!ready.length) {
      const stuck = remaining.map((n) => n.name).sort()
      throw new PlanGraphError('E_PLAN_CYCLE', `slots depend on each other in a cycle: ${stuck.join(' -> ')}`)
    }
    ready.sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0) || a.name.localeCompare(b.name))
    const index = waves.length
    for (const node of ready) placed.set(node.name, index)
    waves.push(ready.map((n) => n.name))
    const done = new Set(ready.map((n) => n.name))
    remaining = remaining.filter((n) => !done.has(n.name))
  }

  return { waves, width: waves.reduce((max, w) => Math.max(max, w.length), 0) }
}

/** The longest chain through the graph, which is the floor on how fast the page can be. */
export interface CriticalPath {
  path: string[]
  ms: number
  /** The number a root-to-leaf sequential walk would have produced, for contrast. */
  sequentialMs: number
}

/** Ties break on depth, so an unmeasured plan still names its longest chain. */
function deeper(a: { ms: number; path: string[] }, b: { ms: number; path: string[] }): boolean {
  return a.ms > b.ms || (a.ms === b.ms && a.path.length > b.path.length)
}

/** The chain that decides the page's floor, so a report can name what to make faster. */
export function criticalPath(nodes: readonly DagNode[]): CriticalPath {
  const byName = new Map(nodes.map((n) => [n.name, n]))
  const best = new Map<string, { ms: number; path: string[] }>()

  const cost = (name: string): { ms: number; path: string[] } => {
    const cached = best.get(name)
    if (cached) return cached
    const node = byName.get(name)
    if (!node) throw new PlanGraphError('E_UNKNOWN_SLOT', `${name} is not in this plan`)
    // Marked before recursing so a cycle is caught here too.
    best.set(name, { ms: 0, path: [name] })
    let deepest: { ms: number; path: string[] } = { ms: 0, path: [] }
    for (const need of node.needs ?? []) {
      const upstream = cost(need)
      if (deeper(upstream, deepest)) deepest = upstream
    }
    const result = { ms: deepest.ms + (node.ms ?? 0), path: [...deepest.path, name] }
    best.set(name, result)
    return result
  }

  let winner: { ms: number; path: string[] } = { ms: 0, path: [] }
  for (const node of nodes) {
    const result = cost(node.name)
    if (node.optional) continue
    if (deeper(result, winner)) winner = result
  }
  const sequentialMs = nodes.reduce((sum, n) => sum + (n.ms ?? 0), 0)
  return { path: winner.path, ms: winner.ms, sequentialMs }
}

/** How wide a wave may be, and what runs each slot. */
export interface DispatchOptions {
  maxConcurrency: number
  /** Called for each node when its turn comes. Rejections are the caller's to police. */
  run(node: DagNode): Promise<void>
  /** The scheduler's say over what runs first inside a wave. Without one, priority then name. */
  order?(ready: readonly DagNode[]): readonly DagNode[]
}

/** Waves with a concurrency ceiling — forty concurrent queries from one page will melt a database. */
export async function dispatch(nodes: readonly DagNode[], options: DispatchOptions): Promise<void> {
  const byName = new Map(nodes.map((n) => [n.name, n]))
  const { waves } = schedule(nodes)
  for (const wave of waves) {
    const nodes_ = wave.map((name) => byName.get(name) as DagNode)
    const ordered = options.order ? [...options.order(nodes_)] : nodes_
    for (let i = 0; i < ordered.length; i += options.maxConcurrency) {
      await Promise.all(ordered.slice(i, i + options.maxConcurrency).map((node) => options.run(node)))
    }
  }
}
