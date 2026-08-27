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
  unit: string
  status: string
  summary?: { p50: number; n: number }
  extra?: { ttlbP50?: number; bytes?: number; rtt?: number; queryMs?: number }
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
