/**
 * The streaming race's regions.
 *
 * This used to build a whole `KernelRoute` by hand — a template, a shell descriptor, a slot array
 * with hand-written ids and versions, and a `render` per lane. All of that is the plan layer's
 * now: `app/routes/live/race/[order].data.ts` declares three streaming slots and
 * `app/layouts/race.tsx` is the document. What is left is the one thing that was ever specific to
 * this page — a region that waits for real and then says when it was rendered.
 */
export interface RaceLane {
  name: 'slow' | 'fast' | 'medium'
  ms: number
}

export const DEFAULT_LANES: RaceLane[] = [
  { name: 'slow', ms: 900 },
  { name: 'fast', ms: 120 },
  { name: 'medium', ms: 450 },
]

/** The order named by a route param. Anything unrecognised is the interesting one. */
export function laneName(param: string | undefined): 'in-order' | 'out-of-order' {
  return param === 'in-order' ? 'in-order' : 'out-of-order'
}

export interface Controls {
  query(key: string): string | undefined
}

export function lanesFrom(source: Controls | URLSearchParams): RaceLane[] {
  const get = (key: string): string | undefined =>
    source instanceof URLSearchParams ? (source.get(key) ?? undefined) : source.query(key)
  const read = (key: string, fallback: number): number => {
    const value = Number(get(key) ?? fallback)
    return Number.isFinite(value) ? Math.min(3000, Math.max(0, value)) : fallback
  }
  return DEFAULT_LANES.map((entry) => ({ name: entry.name, ms: read(entry.name, entry.ms) }))
}

/**
 * One lane: wait for real, then report two numbers.
 *
 * `rendered` is when the server finished this region. Both orders start every region at once, so
 * it is the same in both — which is the point: in-order does not render later, it *delivers*
 * later. `arrived` is stamped by an inline script as the browser parses this region, and that is
 * the number that moves.
 */
export async function lane(name: RaceLane['name'], lanes: readonly RaceLane[]): Promise<string> {
  const started = Date.now()
  const own = lanes.find((entry) => entry.name === name) ?? { name, ms: 0 }
  const fastest = Math.min(...lanes.map((entry) => entry.ms))
  await new Promise((resolve) => setTimeout(resolve, own.ms))
  const rendered = Date.now() - started
  return (
    `<span class="arrived" data-first="${own.ms === fastest ? 'yes' : 'no'}">arrived at +…</span>` +
    `<script>(function(){var s=document.currentScript,e=s.previousElementSibling;` +
    `e.textContent='arrived at +'+Math.round(performance.now())+' ms';s.remove()})()</script>` +
    `<span class="landed">rendered on the server at +${rendered} ms</span>` +
    `<span class="waiting">its loader took ${own.ms} ms</span>`
  )
}
