import type { Values } from '../../ir/src/index.ts'
import type { Scenario } from './workloads/index.ts'

/**
 * `buffered` reproduces the webview case: the host app supplies the document bytes
 * through WKURLSchemeHandler or Android's shouldInterceptRequest, both of which
 * buffer, so nothing can be flushed early.
 */
export interface ServeOptions {
  transport: 'stream' | 'buffered'
}

export interface ServeHandle {
  url: string
  close(): Promise<void>
}

export interface UpdatePayloads {
  /** Keyed by wire form: html, data, delta. Absent forms are not measured, never zeroed. */
  [form: string]: Uint8Array
}

export interface Candidate {
  id: string
  label: string
  /** How this candidate produces bytes, stated so a reader can judge the comparison. */
  mechanism: string
  render?(scenario: Scenario, values: Values, rows: Values[]): Uint8Array
  updateForms?(scenario: Scenario, values: Values, prev: Values[], next: Values[]): UpdatePayloads
  serve?(scenario: Scenario, options?: ServeOptions): Promise<ServeHandle>
  /** Set when a candidate cannot support an axis, so the report says why instead of omitting it. */
  unsupported?: Partial<Record<string, string>>
}

export function supports(candidate: Candidate, needs: 'in-process' | 'http' | 'browser'): boolean {
  if (needs === 'in-process') return typeof candidate.render === 'function'
  return typeof candidate.serve === 'function'
}
