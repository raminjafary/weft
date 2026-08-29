import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The published run, read out of `results/` rather than transcribed onto the page — a benchmark
 * quoted by hand is a benchmark nobody can check. Chosen run is the most recent measuring an
 * external candidate; runs without one are this framework against itself.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const RESULTS = join(ROOT, 'results')

/** The prefix that marks a candidate as somebody else's framework rather than one of ours. */
const EXTERNAL = 'rr7'

interface RawRow {
  axis: string
  scenario: string
  candidate: string
  engine?: string
  unit: string
  status: string
  summary?: { p50: number; n: number }
  extra?: { ttlbP50?: number; bytes?: number; rtt?: number; queryMs?: number; brotli?: number; gzip?: number }
}

interface RawRun {
  environment: { when: string; node: string; cpu: string; commit: string }
  methodology: { iterations: number; latencyMs: number }
  rows: RawRow[]
}

export interface BenchRow {
  candidate: string
  /** Shell time to first byte, ms — the median of the run. */
  ttfb: number
  /** Time to last byte, ms: when the slow region has landed. */
  ttlb: number
  /** Served bytes, identity encoding. */
  bytes: number
}

export interface Run {
  rows: BenchRow[]
  iterations: number
  /** Injected round trip, ms. */
  rtt: number
  /** How long the query behind the slot was made to take, ms. */
  queryMs: number
  cpu: string
  /** `v24.18.0` as `24.18`, which is what the environment line wants. */
  node: string
  commit: string
}

export interface Measured {
  /** The median of the run, in the row's own unit. */
  p50: number
  /** How many samples it is the median of. */
  n: number
  unit: string
  /** The engine it was recorded in, where the axis is a client one. */
  engine?: string
  brotli?: number
  gzip?: number
  /** The file it came from, so a figure on a page can be traced to a run. */
  from: string
}

let everything: Map<string, Measured> | undefined

/**
 * Every measured row of every run, newest wins, keyed by axis/candidate/engine. `run()` reads only
 * one axis; five more were recorded and read by nothing, each also typed by hand elsewhere on the
 * page — three had drifted. Newest wins per key, not per file, since a run may measure one axis and
 * not another.
 */
function measurements(): Map<string, Measured> {
  if (everything) return everything
  everything = new Map()
  for (const name of readdirSync(RESULTS)
    .filter((file) => file.endsWith('.json'))
    .sort()) {
    let raw: RawRun
    try {
      raw = JSON.parse(readFileSync(join(RESULTS, name), 'utf8')) as RawRun
    } catch {
      continue
    }
    for (const row of raw.rows) {
      if (row.status !== 'measured' || !row.summary) continue
      everything.set(key(row.axis, row.candidate, row.engine, row.scenario), {
        p50: row.summary.p50,
        n: row.summary.n,
        unit: row.unit,
        ...(row.engine ? { engine: row.engine } : {}),
        ...(row.extra?.brotli === undefined ? {} : { brotli: row.extra.brotli }),
        ...(row.extra?.gzip === undefined ? {} : { gzip: row.extra.gzip }),
        from: name,
      })
    }
  }
  return everything
}

/**
 * The scenario is part of the key, because the same candidate is measured on several of them. It
 * once wasn't: adding a scenario to the harness's default set silently changed every figure on the
 * site, since the last written row won and nothing failed — a smaller number just looked like a
 * faster runtime.
 */
function key(axis: string, name: string, engine?: string, scenario = ''): string {
  return `${axis}\u0000${name}\u0000${engine ?? ''}\u0000${scenario}`
}

/** One measured figure, or nothing rather than a throw — an unrefreshed `results/` should render a page saying "unmeasured", not fail to render. */
export function measured(
  axis: string,
  name: string,
  engine?: string,
  scenario?: string,
): Measured | undefined {
  const all = measurements()
  if (scenario) return all.get(key(axis, name, engine, scenario))
  // No scenario asked for: answer only if exactly one was measured, so an ambiguous lookup is a stated absence, not whichever row the listing ended on.
  const prefix = key(axis, name, engine, '')
  const found = [...all].filter(([at]) => at.startsWith(prefix))
  return found.length === 1 ? found[0]?.[1] : undefined
}

/** A measured figure rounded the way a page wants to print it, or the honest absence. */
export function figure(
  axis: string,
  name: string,
  options: { engine?: string; digits?: number; unit?: string; scenario?: string } = {},
): string {
  const found = measured(axis, name, options.engine, options.scenario)
  if (!found) return 'not measured'
  const digits = options.digits ?? (found.p50 < 0.01 ? 4 : found.p50 < 1 ? 3 : found.p50 < 10 ? 2 : 1)
  const value = found.p50.toLocaleString('en-US', { maximumFractionDigits: digits })
  return `${value} ${options.unit ?? found.unit}`
}

let cached: Run | undefined

/** The newest run holding an external candidate. Reads the directory rather than naming a file, so adding a run publishes it with nothing else to update. */
export function run(): Run {
  if (cached) return cached
  const files = readdirSync(RESULTS)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .toReversed()
  for (const name of files) {
    const raw = JSON.parse(readFileSync(join(RESULTS, name), 'utf8')) as RawRun
    const rows = raw.rows.filter((row) => row.axis === 'shell-ttfb' && row.status === 'measured')
    if (!rows.some((row) => row.candidate.startsWith(EXTERNAL))) continue
    const first = rows[0]?.extra
    cached = {
      rows: rows.map((row) => ({
        candidate: row.candidate,
        ttfb: row.summary?.p50 ?? 0,
        ttlb: row.extra?.ttlbP50 ?? 0,
        bytes: row.extra?.bytes ?? 0,
      })),
      iterations: raw.methodology.iterations,
      rtt: first?.rtt ?? raw.methodology.latencyMs,
      queryMs: first?.queryMs ?? 0,
      cpu: raw.environment.cpu,
      node: raw.environment.node.replace(/^v/, '').split('.').slice(0, 2).join('.'),
      commit: raw.environment.commit,
    }
    return cached
  }
  throw new Error('E_DOCS_NO_EXTERNAL_RUN: no results file measures an external candidate')
}

/** One candidate's row, by the id the harness gave it. */
export function candidate(id: string): BenchRow {
  const found = run().rows.find((row) => row.candidate === id)
  if (!found) throw new Error(`E_DOCS_NO_CANDIDATE: ${id} is not in the published run`)
  return found
}
