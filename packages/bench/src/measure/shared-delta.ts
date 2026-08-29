import { baseRenderId, deltaPayload, type Values } from '@weftjs/ir'
import { memoryStore } from '@weftjs/adapters'
import { deltaKey, recordBase, recoverBase } from '@weftjs/kernel'
import { compileScenario, withRows } from '../compiled.ts'
import type { Scenario } from '../workloads/index.ts'

/** The claim phase 6 exists to make, measured. See `spec/kernel/surgical.md`: "Why the shared delta is the point". */
export interface DeltaStrategyResult {
  strategy: 'per-connection' | 'shared'
  /** Arrivals on the same base render, or each on its own. */
  arrival: 'aligned' | 'staggered'
  clients: number
  /** Diffs actually computed. The expensive part, and the number the claim is about. */
  computations: number
  /** Deltas served out of the memo instead of computed. */
  memoized: number
  storeReads: number
  storeWrites: number
  /** Bytes delivered downstream, summed over every client. Identical between strategies by design. */
  bytesDelivered: number
  ms: number
}

export interface SharedDeltaReport {
  scenario: string
  clients: number
  changedRows: number
  totalRows: number
  results: DeltaStrategyResult[]
}

/** A per-connection differ, which is what LiveView's architecture is. See `spec/kernel/surgical.md`. */
function perConnection(
  clients: number,
  prev: Values,
  next: Values,
  ir: Parameters<typeof deltaPayload>[0],
  resolve: Parameters<typeof deltaPayload>[4],
  arrival: 'aligned' | 'staggered',
  bases: string[],
): DeltaStrategyResult {
  const held = Array.from({ length: clients }, (_, i) => (arrival === 'aligned' ? prev : stagger(prev, i)))
  const started = performance.now()
  let computations = 0
  let bytes = 0
  for (let i = 0; i < clients; i++) {
    const payload = deltaPayload(ir, bases[i] as string, held[i] as Values, next, resolve)
    computations++
    bytes += JSON.stringify(payload.changed).length
  }
  return {
    strategy: 'per-connection',
    arrival,
    clients,
    computations,
    memoized: 0,
    storeReads: 0,
    storeWrites: 0,
    bytesDelivered: bytes,
    ms: performance.now() - started,
  }
}

/** The shared strategy: the client names its base, the server recovers it, and the delta is memoized under the transition. */
async function shared(
  clients: number,
  prev: Values,
  next: Values,
  ir: Parameters<typeof deltaPayload>[0],
  resolve: Parameters<typeof deltaPayload>[4],
  arrival: 'aligned' | 'staggered',
): Promise<DeltaStrategyResult> {
  const store = memoryStore()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const held: Values[] = []
  const bases: string[] = []
  for (let i = 0; i < clients; i++) {
    const state = arrival === 'aligned' ? prev : stagger(prev, i)
    held.push(state)
    bases.push(await recordBase(store, ir, state))
  }
  const nextBase = await recordBase(store, ir, next)

  const started = performance.now()
  let computations = 0
  let memoized = 0
  let reads = 0
  let writes = 0
  let bytes = 0

  for (let i = 0; i < clients; i++) {
    const key = deltaKey(ir.version, bases[i] as string, nextBase)
    reads++
    const cached = await store.get(key)
    if (cached) {
      memoized++
      bytes += cached.value.length
      continue
    }
    reads++
    const base = await recoverBase(store, ir.version, bases[i] as string)
    const payload = deltaPayload(ir, bases[i] as string, base as Values, next, resolve)
    computations++
    const encoded = encoder.encode(JSON.stringify(payload.changed))
    writes++
    await store.set(key, encoded, { class: 'shared', tags: [`tpl:${ir.version}`] })
    bytes += encoded.length
    void decoder
  }

  return {
    strategy: 'shared',
    arrival,
    clients,
    computations,
    memoized,
    storeReads: reads,
    storeWrites: writes,
    bytesDelivered: bytes,
    ms: performance.now() - started,
  }
}

/** A different previous state per client, so no two of them share a base render. */
function stagger(prev: Values, i: number): Values {
  const rows = prev.rows
  if (!Array.isArray(rows) || rows.length === 0) return { ...prev, __stagger: i } as unknown as Values
  const copy = [...(rows as Values[])]
  const at = i % copy.length
  copy[at] = { ...(copy[at] as Values), qty: -(i + 1) } as unknown as Values
  return { ...prev, rows: copy } as unknown as Values
}

export async function measureSharedDelta(scenario: Scenario, clients = 1_000): Promise<SharedDeltaReport> {
  const compiled = await compileScenario(scenario)
  if (!compiled.rowBinding) {
    throw new Error(`E_NO_LIST: ${scenario.id} has no list hole, so there is nothing to share a delta over`)
  }
  const values = scenario.values()
  const rows = scenario.rows()
  const nextRows = scenario.transition(rows)
  const prev: Values = withRows(compiled, values, rows)
  const next: Values = withRows(compiled, scenario.transitionValues?.(values) ?? values, nextRows)

  const changed = rows.filter((row, i) => JSON.stringify(row) !== JSON.stringify(nextRows[i])).length
  const results: DeltaStrategyResult[] = []

  for (const arrival of ['aligned', 'staggered'] as const) {
    const bases = await alignedBases(clients, prev, arrival, compiled.root)
    results.push(
      perConnection(clients, prev, next, compiled.root, compiled.resolve, arrival, bases),
      await shared(clients, prev, next, compiled.root, compiled.resolve, arrival),
    )
  }

  return { scenario: scenario.id, clients, changedRows: changed, totalRows: rows.length, results }
}

async function alignedBases(
  clients: number,
  prev: Values,
  arrival: 'aligned' | 'staggered',
  ir: Parameters<typeof baseRenderId>[0],
): Promise<string[]> {
  return Array.from({ length: clients }, (_, i) =>
    baseRenderId(ir, arrival === 'aligned' ? prev : stagger(prev, i)),
  )
}

export function formatSharedDelta(report: SharedDeltaReport): string {
  const lines: string[] = []
  lines.push(
    `${report.scenario}: ${report.clients} clients, ${report.changedRows} of ${report.totalRows} rows changed`,
  )
  for (const arrival of ['aligned', 'staggered'] as const) {
    const rows = report.results.filter((r) => r.arrival === arrival)
    lines.push(`  ${arrival === 'aligned' ? 'all on one base render' : 'each on its own base render'}`)
    for (const r of rows) {
      lines.push(
        `    ${r.strategy.padEnd(15)} ${String(r.computations).padStart(6)} diffs  ` +
          `${String(r.memoized).padStart(6)} memoized  ` +
          `${String(r.storeReads).padStart(6)} reads  ` +
          `${r.ms.toFixed(1).padStart(8)} ms  ` +
          `${String(r.bytesDelivered).padStart(9)} B delivered`,
      )
    }
    const per = rows.find((r) => r.strategy === 'per-connection')
    const shared_ = rows.find((r) => r.strategy === 'shared')
    if (per && shared_) {
      const ratio = shared_.computations === 0 ? Infinity : per.computations / shared_.computations
      lines.push(
        `    diffs: ${per.computations} -> ${shared_.computations} (${ratio.toFixed(0)}x fewer computations)`,
      )
    }
  }
  return lines.join('\n')
}
