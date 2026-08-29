import type { TelemetryPort } from '@weftjs/kernel'

/** Every budget outcome is an event class of its own. See `spec/kernel/locus.md`. */
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
