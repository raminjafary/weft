import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The five measurements that are not benchmark axes, read out of the file that records them.
 *
 * `bench.ts` reads `results/` — the report `weft-bench run` writes, one file per run, which is the
 * right shape for a comparison against a control. Four of the site's most-quoted figures are not
 * that: the streaming race, the thousand-client diff, the staged click and the served document each
 * come from their own command, and each is a single current fact rather than a series.
 *
 * Those four commands used to print to a terminal and write nothing, so every page that quoted them
 * had the figure typed into it — the race in three files, the staged click in three more. They were
 * transcribed once and then stood still while the framework moved. `packages/bench/measured.json`
 * is now written by `--write` on each of those commands, and this reads it, on exactly the rule the
 * rest of this site already follows: a figure a reader is shown is a figure something measured.
 *
 * Every accessor answers `not measured` rather than throwing when a section is absent. A page with
 * an honest gap on it is a page; a build that dies because somebody has not run the harness on this
 * machine is not.
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
  pairs: { to: string; staged: { summary: { p50: number } }; browser: { summary: { p50: number } } }[]
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

/**
 * When the fast region became visible, in one engine, in one of the two document orders.
 *
 * The slow region is first in document order, which is the only arrangement that separates the two
 * — with the fast one first, both orders look identical and the mechanism is invisible.
 */
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

/**
 * What a thousand clients cost, by where the previous state lives and whether they share a base.
 *
 * `staggered` is the block where the shared path loses, and it is here for the same reason it is in
 * the specification: quoting only the win would be advocacy.
 */
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

/**
 * A staged click against the same click handed back to the browser, on the route named.
 *
 * The dashboard by default: it is the one page in the demo whose slots are slow on purpose, so it
 * is the row where the ratio is about the mechanism rather than about how fast loopback is.
 */
export function stagedClick(route = 'dashboard'): { staged: string; browser: string } {
  const pair = section<NavReport[]>('nav')
    ?.find((report) => report.engine === 'chromium')
    ?.pairs.find((p) => p.to.includes(route))
  if (!pair) return { staged: 'not measured', browser: 'not measured' }
  // One decimal, which is what the harness itself prints: ten samples of a millisecond-resolution
  // clock land on halves often enough that rounding them away turns 17.5 into 18 and loses the only
  // digit separating two of these routes.
  return {
    staged: `${pair.staged.summary.p50.toFixed(1)} ms`,
    browser: `${pair.browser.summary.p50.toFixed(1)} ms`,
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
