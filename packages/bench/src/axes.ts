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
    caveat: 'Single-threaded, one process, no I/O. It measures the render path only, which is the part the compiler owns.',
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
    sota: 'Every framework ships one form. htmx and Datastar always send markup; a client-rendered app always sends data and pays a JavaScript DOM-construction path for it.',
    gap: 'If a form is negotiable, the cheaper one can be chosen per request — but only if it is actually cheaper, which is what this axis decides.',
    expectation: 'unknown',
    caveat:
      'Measured as the whole job: bytes turned into DOM in the document, parse included, because every form has to end with the region on screen. It does not model the cost of holding a template resident, which is where the repeat-visit axis belongs.',
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
      'A desktop engine is a proxy for a webview, not a substitute. Where the host app supplies the document itself the response is buffered, so run this axis with --transport buffered as well.',
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
      'This axis assumes the resident set survives between visits. Generic WKWebView gates service workers behind app-bound domains and in-app browsers often suppress caching entirely, so the resident-template story needs an IndexedDB or HTTP-cache path and the number must be read per storage tier.',
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
