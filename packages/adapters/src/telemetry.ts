import type { TelemetryPort } from '@weft/kernel'

/**
 * Every budget outcome is an event class of its own, because the failure mode of graceful
 * degradation is that it hides the problem: a slot silently dropping from a server render
 * to a client one for 4% of requests is a real regression that looks like nothing at all in
 * an aggregate.
 */
export interface Recorded {
  name: string
  ms: number
  attrs?: Record<string, string | number>
}

/** Telemetry that keeps what it was told, so a test can assert on marks rather than on logs. */
export interface CollectingTelemetry extends TelemetryPort {
  readonly marks: { name: string; at: number }[]
  readonly measures: Recorded[]
  breaches(): Recorded[]
  reset(): void
}

/** An in-memory telemetry port. For tests and for the devtools' own timeline. */
export function collectingTelemetry(): CollectingTelemetry {
  const marks: { name: string; at: number }[] = []
  const measures: Recorded[] = []
  return {
    name: 'collecting',
    marks,
    measures,
    mark: (name, at) => {
      marks.push({ name, at })
    },
    measure: (name, ms, attrs) => {
      measures.push({ name, ms, ...(attrs ? { attrs } : {}) })
    },
    breaches: () => measures.filter((m) => m.attrs?.over === 1 || m.attrs?.failed === 1),
    reset: () => {
      marks.length = 0
      measures.length = 0
    },
  }
}
