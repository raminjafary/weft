import type { DbPort, DbQuery, TelemetryPort } from '@weft/kernel'

/**
 * Where a loader's data comes from, named rather than anonymous.
 *
 * The framework never sees a loader: a `.data.ts` is application code the compiler does not read,
 * so every query in it is invisible to the machinery that would otherwise bound it. What that
 * absence costs is specific — a slow page with no name for the slow part, a query that hangs for
 * as long as the driver's default allows, and an invalidation nobody can check against what the
 * render actually read. Running the access through a port gives all three back without inventing
 * a query language: what runs is the caller's own function.
 *
 * The deadline is the part worth insisting on. A slot has a CPU budget and it is enforced where a
 * render can be preempted; a query is not CPU and cannot be killed that way, so its bound is a
 * deadline the caller decides and an `AbortSignal` the caller is expected to honour. A `run` that
 * ignores its signal gets a rejected promise and a query that is still running, which is stated
 * rather than hidden — this port cannot cancel work it did not start.
 */
export interface BoundedDbOptions {
  /** The deadline a query gets when it does not ask for one. Ten seconds, which is generous. */
  timeoutMs?: number
  telemetry?: TelemetryPort
  /** How many accesses to remember for the trace. Zero keeps none. */
  history?: number
  now?(): number
}

export class DbError extends Error {
  code: string
  query: string

  constructor(code: string, query: string, message: string) {
    super(`${code} [${query}] — ${message}`)
    this.name = 'DbError'
    this.code = code
    this.query = query
  }
}

export interface Observed {
  name: string
  ms: number
  tags: readonly string[]
  failed?: boolean
}

export interface BoundedDb extends DbPort {
  observed(): readonly Observed[]
  /** Every tag any query has declared. What an invalidation can be checked against. */
  tags(): readonly string[]
  forget(): void
}

export function boundedDb(options: BoundedDbOptions = {}): BoundedDb {
  const timeoutMs = options.timeoutMs ?? 10_000
  const keep = options.history ?? 64
  const now = options.now ?? ((): number => Date.now())
  const log: Observed[] = []
  const declared = new Set<string>()

  return {
    name: 'bounded',
    observed: () => [...log],
    tags: () => [...declared].sort(),
    forget: () => {
      log.length = 0
    },

    async query<T>(query: DbQuery, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      for (const tag of query.tags ?? []) declared.add(tag)
      const started = now()
      const controller = new AbortController()
      const deadline = query.timeoutMs ?? timeoutMs
      const timer = setTimeout(() => controller.abort(), deadline)

      const record = (failed?: boolean): number => {
        const ms = now() - started
        if (keep > 0) {
          log.push({ name: query.name, ms, tags: [...(query.tags ?? [])], ...(failed ? { failed } : {}) })
          while (log.length > keep) log.shift()
        }
        options.telemetry?.measure('db.query', ms, {
          query: query.name,
          ...(failed ? { failed: 1 } : {}),
        })
        return ms
      }

      try {
        const value = await run(controller.signal)
        record()
        return value
      } catch (error) {
        const ms = record(true)
        // The signal firing and the query failing on its own are different incidents, and a
        // deployment reading this at 3am needs to know which: one is a database that is slow and
        // the other is a database that said no.
        if (controller.signal.aborted) {
          throw new DbError(
            'E_QUERY_TIMEOUT',
            query.name,
            `no answer within ${deadline}ms (gave up after ${Math.round(ms)}ms)`,
          )
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
