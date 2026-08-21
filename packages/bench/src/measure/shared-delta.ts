import { baseRenderId, deltaPayload, type Values } from '@weft/ir'
import { memoryStore } from '@weft/adapters'
import { deltaKey, recordBase, recoverBase } from '@weft/kernel'
import { compileScenario, withRows } from '../compiled.ts'
import type { Scenario } from '../workloads/index.ts'

/**
 * The claim phase 6 exists to make, measured.
 *
 * LiveView is the strongest prior art and the one thing it structurally cannot do is the whole
 * opportunity: it keeps the previous render in a process per connected user, so a diff is
 * computed per connection and can never be shared. Ten thousand users watching one price list
 * produce ten thousand identical diffs.
 *
 * Keeping the render state on the client inverts that. The client names the base render it
 * holds, so a delta is a pure function of two content-addressed states — which makes it
 * cacheable by exactly the machinery that already exists, and one computation can serve every
 * client making the same transition.
 *
 * **What is being compared, precisely.** Both strategies use the same differ over the same
 * templates and the same transition. The only variable is where the previous state lives and
 * therefore whether a diff can be shared. That is the architectural difference and it is the
 * whole of what this measures.
 *
 * **What is not being compared.** Phoenix is not running here. This does not measure BEAM
 * scheduling, Phoenix's wire encoding, its own tracked-comprehension optimisation, or any
 * constant factor of a real LiveView deployment — those need Elixir on the machine. The
 * per-connection number is a real per-connection differ implemented in this harness, and the
 * claim it supports is structural: a per-connection differ does N diffs where a shared one does
 * one, and no amount of tuning changes the N.
 *
 * **Both arrival patterns are reported**, because only one of them favours us. When every
 * client holds the same base — a broadcast, a feed, a price list — the shared strategy is N:1.
 * When every client holds a different base, there is nothing to share and the shared strategy
 * does the same N diffs *plus* a store read and write for each, so it is slightly worse than
 * per-connection. Reporting only the first number would be advocacy.
 */
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

/**
 * A per-connection differ, which is what LiveView's architecture is: state per connection, a
 * diff per connection, and no way for two connections to share one. Implemented rather than
 * modelled so the comparison is between two running things.
 */
function perConnection(
  clients: number,
  prev: Values,
  next: Values,
  ir: Parameters<typeof deltaPayload>[0],
  resolve: Parameters<typeof deltaPayload>[4],
  arrival: 'aligned' | 'staggered',
  bases: string[],
): DeltaStrategyResult {
  // Each connection holds its own copy of the previous render. That is the memory cost this
  // architecture pays and the reason a diff cannot be shared.
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

/**
 * The shared strategy: the client names its base, the server recovers it, and the delta is
 * memoized under the transition it encodes. The second client to make a transition pays a store
 * read; so does the ten-thousandth.
 */
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
    // The base comes out of the store rather than out of a per-connection process, which is
    // the whole point: any stateless isolate can serve this client.
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
