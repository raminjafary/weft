import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Five measurements that aren't benchmark axes — `bench.ts` reads `results/`, one file per run, but
 * the streaming race, thousand-client diff, staged click, and served document are each a single
 * current fact from their own command. Those four used to print to a terminal and write nothing,
 * so every page quoting them had the figure hand-typed and frozen. `--write` on each now writes
 * `packages/bench/measured.json`, read here. Every accessor answers `not measured` rather than
 * throwing when absent.
 */

const FILE = fileURLToPath(new URL('../../../bench/measured.json', import.meta.url))

interface Section<T> {
  environment: { when: string; commit: string | null; cpu: string }
  measured: T
}

interface RegionTimes {
  /** The slow region, first in document order. */
  feed: number
  /** The fast one behind it, which is the whole question. */
  recs: number
}

interface SlotsSection {
  delays: { feed: number; recs: number }
  filler: number
  runs: { engine: string; inOrder: RegionTimes[]; outOfOrder: RegionTimes[] }[]
}

interface DeltaResult {
  strategy: 'per-connection' | 'shared'
  arrival: 'aligned' | 'staggered'
  computations: number
  ms: number
}

interface DeltaReport {
  scenario: string
  clients: number
  results: DeltaResult[]
}

interface NavReport {
  engine: string
  /** The injected round trip. Zero is loopback, and the two are separate rows of the same table. */
  latencyMs: number
  pairs: { to: string; staged: { summary: { p50: number } }; browser: { summary: { p50: number } } }[]
}

interface DownloadReport {
  served: { modules: number; raw: number; brotli: number }
  built: { modules: number; raw: number; brotli: number }
  driftPercent: number
}

interface L0Report {
  path: string
  bytes: number
  l0: { ttlb: { p50: number } }
  kernel: { ttlb: { p50: number } }
}

let cache: Record<string, Section<unknown>> | undefined

function all(): Record<string, Section<unknown>> {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Section<unknown>>
  } catch {
    cache = {}
  }
  return cache
}

function section<T>(key: string): T | undefined {
  return (all()[key] as Section<T> | undefined)?.measured
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? NaN
}

/** When the fast region became visible. The slow region is first in document order — reversed, both orders look identical and the mechanism is invisible. */
export function raceFigure(engine: string, order: 'in-order' | 'out-of-order'): string {
  const run = section<SlotsSection>('slots')?.runs.find((r) => r.engine === engine)
  if (!run) return 'not measured'
  const samples = order === 'in-order' ? run.inOrder : run.outOfOrder
  return `${p50(samples.map((times) => times.recs)).toFixed(0)} ms`
}

/** How much earlier, as the ratio of the two, in the engine named. */
export function raceRatio(engine = 'chromium'): string {
  const run = section<SlotsSection>('slots')?.runs.find((r) => r.engine === engine)
  if (!run) return 'not measured'
  const before = p50(run.inOrder.map((times) => times.recs))
  const after = p50(run.outOfOrder.map((times) => times.recs))
  return `${(before / after).toFixed(1)}×`
}

/** The inline script a route with slots pays for the fill, in bytes. */
export function fillerBytes(): number | undefined {
  return section<SlotsSection>('slots')?.filler
}

/** The two delays the race is run at, which the figures label. */
export function raceDelays(): { slow: number; fast: number } | undefined {
  const delays = section<SlotsSection>('slots')?.delays
  return delays ? { slow: delays.feed, fast: delays.recs } : undefined
}

/** What a thousand clients cost. `staggered` is where the shared path loses — kept, same as in the spec, because quoting only the win would be advocacy. */
export function deltaCost(
  strategy: DeltaResult['strategy'],
  arrival: DeltaResult['arrival'],
  scenario = 'feed',
): string {
  const report = section<DeltaReport[]>('deltas')?.find((r) => r.scenario === scenario)
  const found = report?.results.find((r) => r.strategy === strategy && r.arrival === arrival)
  return found ? `${found.ms.toFixed(1)} ms` : 'not measured'
}

/** How many diffs each strategy computes, which is the architectural claim rather than the timing. */
export function deltaComputations(
  strategy: DeltaResult['strategy'],
  arrival: DeltaResult['arrival'],
  scenario = 'feed',
): string {
  const report = section<DeltaReport[]>('deltas')?.find((r) => r.scenario === scenario)
  const found = report?.results.find((r) => r.strategy === strategy && r.arrival === arrival)
  return found ? found.computations.toLocaleString('en-US') : 'not measured'
}

/** How many clients the comparison was run with. */
export function deltaClients(scenario = 'feed'): string {
  const report = section<DeltaReport[]>('deltas')?.find((r) => r.scenario === scenario)
  return report ? report.clients.toLocaleString('en-US') : 'not measured'
}

/** A staged click against the same click handed to the browser. Defaults to the dashboard — the one demo page whose slots are slow on purpose. */
export function stagedClick(
  route = 'dashboard',
  latencyMs = 0,
): { staged: string; browser: string; ratio: string } {
  const pair = section<NavReport[]>('nav')
    ?.find((report) => report.engine === 'chromium' && report.latencyMs === latencyMs)
    ?.pairs.find((p) => p.to.includes(route))
  if (!pair) return { staged: 'not measured', browser: 'not measured', ratio: 'not measured' }
  // One decimal, matching the harness: rounding away halves once turned 17.5 into 18, losing the only digit separating two routes.
  return {
    staged: `${pair.staged.summary.p50.toFixed(1)} ms`,
    browser: `${pair.browser.summary.p50.toFixed(1)} ms`,
    ratio: `${(pair.browser.summary.p50 / pair.staged.summary.p50).toFixed(2)}×`,
  }
}

/** A document served from the build against the same document rendered, by last byte. */
export function l0Rows(): { path: string; bytes: string; l0: string; kernel: string; ratio: string }[] {
  return (section<L0Report[]>('l0') ?? []).map((report) => ({
    path: report.path,
    bytes: report.bytes.toLocaleString('en-US'),
    l0: `${report.l0.ttlb.p50.toFixed(3)} ms`,
    kernel: `${report.kernel.ttlb.p50.toFixed(3)} ms`,
    ratio: `${(report.kernel.ttlb.p50 / report.l0.ttlb.p50).toFixed(2)}×`,
  }))
}

/** What a page downloads, and how closely the build's own walk agrees with the wire — two independent walks of one graph, whose agreement is what makes either publishable. */
export function download(): { served: string; built: string; drift: string; modules: string } {
  const report = section<DownloadReport>('download')
  if (!report) return { served: 'not measured', built: 'not measured', drift: 'not measured', modules: '?' }
  return {
    served: report.served.brotli.toLocaleString('en-US'),
    built: report.built.brotli.toLocaleString('en-US'),
    drift: `${report.driftPercent.toFixed(2)}%`,
    modules: String(report.served.modules),
  }
}
