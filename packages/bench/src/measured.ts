import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { environment, type Environment } from './env.ts'

/**
 * The measurements that are not axes, written down: `slots`, `deltas`, `l0`, `nav`, `decode` each
 * answer one current fact rather than a comparison, keyed by command in one file, the shape
 * `budgets.json` already has. Each section carries the environment it was measured in, so a reader
 * comparing two sections can tell whether the same machine produced both.
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

/** One section replaced, the rest of the file untouched — a machine missing hardware for one command should not erase the others. */
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
