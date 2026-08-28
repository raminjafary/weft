import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The published run, read out of `results/` rather than transcribed onto the page.
 *
 * The landing page's three charts are the only place this site prints a competitor's number, which
 * is exactly the place a typed figure would be worst: a benchmark quoted by hand is a benchmark
 * nobody can check. So the run is a file in this repository, the charts are that file, and the
 * environment line under the heading is the environment the harness recorded — not a sentence
 * somebody wrote about it.
 *
 * The run chosen is the most recent one that measured an external candidate. Runs without one are
 * this framework against itself, which cannot carry the comparison the landing page is making.
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
 * Every measured row of every run, newest wins, keyed by axis, candidate and engine.
 *
 * `run()` above answers one question — how does the shell's first byte compare with somebody
 * else's — and it reads a single axis to answer it. Five more axes were being recorded into this
 * directory on every bench run and read by nothing: what an update costs in bytes, what applying
 * one costs on the client, what adopting a region costs, what a repeat visit costs, and what the
 * server renders per second. Every one of those figures was also on a page, typed by hand, and
 * three of them had drifted away from the file sitting beside them.
 *
 * Newest wins per key rather than newest-file-wins, because a run may measure one axis and not
 * another — the harness is usually pointed at the thing being changed — and the alternative is a
 * page that loses a figure whenever somebody benches something narrow.
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
      everything.set(key(row.axis, row.candidate, row.engine), {
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

function key(axis: string, name: string, engine?: string): string {
  return `${axis}\u0000${name}\u0000${engine ?? ''}`
}

/**
 * One measured figure, or nothing.
 *
 * Nothing rather than a throw: a checkout whose `results/` has not been refreshed should render a
 * page that says a figure is unmeasured, not fail to render. Every call site here decides what to
 * say in that case, and none of them may invent the number.
 */
export function measured(axis: string, name: string, engine?: string): Measured | undefined {
  return measurements().get(key(axis, name, engine))
}

/** A measured figure rounded the way a page wants to print it, or the honest absence. */
export function figure(
  axis: string,
  name: string,
  options: { engine?: string; digits?: number; unit?: string } = {},
): string {
  const found = measured(axis, name, options.engine)
  if (!found) return 'not measured'
  const digits = options.digits ?? (found.p50 < 0.01 ? 4 : found.p50 < 1 ? 3 : found.p50 < 10 ? 2 : 1)
  const value = found.p50.toLocaleString('en-US', { maximumFractionDigits: digits })
  return `${value} ${options.unit ?? found.unit}`
}

let cached: Run | undefined

/**
 * The newest run holding an external candidate.
 *
 * Reading the directory rather than naming a file means adding a run publishes it, and there is no
 * second place to remember. Sorting by name is sorting by time, because the harness stamps each
 * file with an ISO instant.
 */
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
