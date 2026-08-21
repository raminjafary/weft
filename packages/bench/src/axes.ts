export type Expectation = 'beat' | 'tie' | 'unknown'

export type Needs = 'in-process' | 'http' | 'browser'

export interface Budget {
  value: number
  statistic: 'p50' | 'p95' | 'mean'
  note: string
}

export interface Axis {
  id: string
  label: string
  unit: string
  direction: 'lower-better' | 'higher-better'
  needs: Needs
  /** What the field notes say the state of the art is, so a result can be read against it. */
  sota: string
  gap: string
  expectation: Expectation
  budget?: Budget
  /** What this measurement does not cover, printed with every result. */
  caveat?: string
}

export const AXES: Axis[] = [
  {
    id: 'shell-ttfb',
    label: 'Shell TTFB',
    unit: 'ms',
    direction: 'lower-better',
    needs: 'http',
    sota: 'A well-tuned streaming-SSR app reaches 50-65 ms TTFB.',
    gap: 'The shell is a precomputed buffer per route x flag-set x device-class, so TTFB is a lookup rather than a render.',
    expectation: 'beat',
    budget: { value: 15, statistic: 'p50', note: 'warm shell cache' },
    caveat:
      'Without --latency this measures server work only, and loopback has no network in it. A shell-TTFB claim needs injected RTT and a scenario whose data is genuinely slow, because the question is whether the shell is downstream of the query, not how fast the renderer is.',
  },
  {
    id: 'server-throughput',
    label: 'Server render throughput',
    unit: 'renders/sec',
    direction: 'higher-better',
    needs: 'in-process',
    sota: 'String concatenation in the SSR paths of Solid and Svelte; Marko is closest to segment-based.',
    gap: 'Pre-encoded Uint8Array segments with escape elision are a different cost class, not a percentage.',
    expectation: 'beat',
    caveat:
      'Single-threaded, one process, no I/O. It measures the render path only, which is the part the compiler owns.',
  },
  {
    id: 'shared-delta',
    label: 'Delta computations for N clients making one transition',
    unit: 'computations',
    direction: 'lower-better',
    needs: 'in-process',
    sota: 'LiveView keeps the previous render in a process per connection and diffs per connection, so N connections making one transition produce N diffs. That is architectural, not a tuning choice.',
    gap: 'The client names the base render it holds, so a delta is a pure function of two content-addressed states and is memoized by the transition it encodes. One computation serves every client making the same transition.',
    expectation: 'beat',
    caveat:
      'Phoenix is not running: the per-connection figure is a real per-connection differ in this harness, over the same templates and the same transition, so what is measured is the architectural difference and not BEAM scheduling, Phoenix wire encoding, or its tracked comprehensions. Both arrival patterns are reported because only one favours us — clients each holding a different base share nothing, and the shared path then pays a store read and write per client on top of the same diffs.',
  },
  {
    id: 'update-bytes',
    label: 'Bytes per server-driven update',
    unit: 'bytes',
    direction: 'lower-better',
    needs: 'in-process',
    sota: 'Solid, Svelte, and Vapor have no server-update story; LiveView has one and needs a stateful process per connection.',
    gap: 'The delta form sends changed values only, computed once and shared across every client making the same transition.',
    expectation: 'beat',
    caveat:
      'Payload size only. It does not price the server-side base-render recovery a delta needs, which is where LiveView pays with a stateful process per connection.',
  },
  {
    id: 'client-work',
    label: 'Client work per wire form',
    unit: 'ms',
    direction: 'lower-better',
    needs: 'browser',
    sota: 'Every framework ships one form. htmx and Datastar always send markup, so an update is always a parse.',
    gap: 'A delta is written into the DOM the server already rendered, one write per changed value, which is only possible because every hole carries its own addressing.',
    expectation: 'beat',
    caveat:
      'The delta figure assumes the region has already been adopted; adoption is measured separately on the interactivity axis. Comparing a first render against a delta would be comparing two different jobs.',
  },
  {
    id: 'tti-server-rendered',
    label: 'Time to interactive, server-rendered',
    unit: 'ms',
    direction: 'lower-better',
    needs: 'browser',
    sota: 'Solid executes every component once on hydration, O(n) in component count. React executes on hydration and again on interaction.',
    gap: 'A wiring table adopts existing DOM by position, which is O(1) in component count.',
    expectation: 'beat',
    caveat:
      'This measures adoption alone, not a comparison: React Router 7 hydration would need a client build the benchmark app does not have, so the honest reading is adoption against the HTML parse it sits next to. A desktop engine is also a proxy for a webview, not a substitute.',
  },
  {
    id: 'repeat-visit-startup',
    label: 'Repeat-visit startup',
    unit: 'ms',
    direction: 'lower-better',
    needs: 'browser',
    sota: 'Hydration re-runs component code on every page load, every time.',
    gap: 'Wiring tables are content-addressed per template version, so a returning visitor does zero wiring construction.',
    expectation: 'beat',
    caveat:
      'The reported figure is the boot path — decode, read the resident set, store what arrived, adopt — because time to the interactive mark is dominated by fetching an unbundled runtime with caching disabled, which is not a delivery configuration anyone would ship. The storage tier is reported with the result: generic WKWebView gates service workers behind app-bound domains, so residency here is IndexedDB, and an in-app browser that blocks it degrades to every visit being a first visit.',
  },
  {
    id: 'isolated-dom-update',
    label: 'Isolated DOM update',
    unit: 'ms',
    direction: 'lower-better',
    needs: 'browser',
    sota: 'Solid, Svelte 5 runes, and Vue Vapor all compile to direct imperative DOM operations. This is the floor.',
    gap: 'None. Match it, measure it honestly, and do not build the pitch on it.',
    expectation: 'tie',
  },
]

export function axis(id: string): Axis {
  const found = AXES.find((a) => a.id === id)
  if (!found) throw new Error(`E_UNKNOWN_AXIS: ${id}. known: ${AXES.map((a) => a.id).join(', ')}`)
  return found
}
