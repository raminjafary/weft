import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { environment, type Environment } from './env.ts'

/**
 * The measurements that are not axes, written down.
 *
 * `run` produces a report per invocation because its rows are a comparison: a candidate against a
 * control, on an axis, and the interesting thing is the ratio. The other five commands are not
 * that. `slots` answers what a browser does with two regions that arrive out of order; `deltas`
 * answers what a thousand clients cost; `l0`, `nav` and `decode` each answer one question about
 * one path. Each is a single current fact, and a fact has a place rather than a history.
 *
 * So this is one file, keyed by command, overwritten in place — the shape `budgets.json` already
 * has, for the same reason it has it. Until now these five printed to a terminal and stopped
 * there, which is why nine documents quoted their figures from memory: there was nothing to read.
 * A number that only reaches a terminal reaches nobody, and a number nobody can read is a number
 * that drifts.
 *
 * Each section carries the environment it was measured in, because they are measured by separate
 * commands and a reader comparing two of them is entitled to know whether the same machine
 * produced both.
 */

export const MEASURED_RUNS = fileURLToPath(new URL('../measured.json', import.meta.url))

export interface MeasuredSection<T> {
  environment: Environment
  measured: T
}

export type MeasuredRuns = Record<string, MeasuredSection<unknown>>

export function readMeasured(): MeasuredRuns {
  try {
    return JSON.parse(readFileSync(MEASURED_RUNS, 'utf8')) as MeasuredRuns
  } catch {
    return {}
  }
}

/**
 * One section replaced, the rest of the file untouched.
 *
 * Merged rather than rewritten because the commands run separately and some of them need hardware
 * the others do not — `nav` wants a browser, `deltas` does not — so a machine that can only answer
 * four of the five questions should record four answers rather than erase the fifth.
 */
export function recordMeasured(key: string, measured: unknown): void {
  const all = readMeasured()
  all[key] = { environment: environment(), measured }
  const ordered = Object.fromEntries(
    Object.keys(all)
      .toSorted()
      .map((name) => [name, all[name]]),
  )
  writeFileSync(MEASURED_RUNS, `${JSON.stringify(ordered, null, 2)}\n`)
}
