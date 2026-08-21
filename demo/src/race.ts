import type { Values } from '../../packages/ir/src/index.ts'
import type { KernelRoute } from '../../packages/kernel/src/index.ts'
import { compileDemo } from './compile.ts'

const utf8 = new TextEncoder()

/**
 * The streaming race: the same three regions, the same three latencies, served in both orders.
 *
 * The point of doing it as a real route rather than an animation is that there is nothing to
 * disbelieve. The server waits for real, the stream is a real stream, and each region reports the
 * millisecond it was rendered at — so the arrival order is still readable after the load finishes,
 * which matters because on loopback the whole thing is over quickly.
 */
export interface RaceLane {
  name: 'slow' | 'fast' | 'medium'
  ms: number
}

/**
 * A route per request, because the order and the latencies are controls. The kernel takes a
 * `RouteResolver`, so this is what a plan would produce — one route, resolved for these params.
 */
export async function race(order: 'in-order' | 'out-of-order', lanes: RaceLane[]): Promise<KernelRoute> {
  const { race: template } = await compileDemo()
  const started = Date.now()

  const region = (lane: RaceLane) => async (): Promise<Uint8Array> => {
    await new Promise((resolve) => setTimeout(resolve, lane.ms))
    const rendered = Date.now() - started
    const fastest = Math.min(...lanes.map((l) => l.ms))
    /**
     * Two numbers, because they are two different facts and only the second one differs between
     * the orders.
     *
     * `rendered` is when the server finished this region. Both orders start every region at once,
     * so this number is the same in both — which is the point: in-order does not render later, it
     * *delivers* later.
     *
     * `arrived` is stamped by an inline script as the browser parses this region. That is the
     * number that moves: in-order, a fast region cannot arrive until every region above it has,
     * so it sits finished on the server waiting for the pipe.
     */
    const stamp =
      `<span class="arrived" data-first="${lane.ms === fastest ? 'yes' : 'no'}">arrived at +…</span>` +
      `<script>(function(){var s=document.currentScript,e=s.previousElementSibling;` +
      `e.textContent='arrived at +'+Math.round(performance.now())+' ms';s.remove()})()</script>`
    return utf8.encode(
      stamp +
        `<span class="landed">rendered on the server at +${rendered} ms</span>` +
        `<span class="waiting">its loader took ${lane.ms} ms</span>`,
    )
  }

  return {
    path: '/live/race',
    template: template.entry,
    values: {
      title: `${order} · weft`,
      css: '/demo.css',
      order,
      note:
        order === 'out-of-order'
          ? 'fastest first: the shell went out with an anchor at each slot, and whichever region resolved first was sent first.'
          : 'document order: each region streams where it sits, so the fast one waits behind the slow one above it.',
    } as unknown as Values,
    resolve: template.resolve,
    shell: {
      id: template.entry.id,
      version: template.entry.version,
      effects: template.entry.effects,
    },
    order,
    slots: lanes.map((lane) => ({
      name: lane.name,
      id: `demo/race#${lane.name}`,
      version: `race-${lane.name}-${lane.ms}`,
      effects: { reads: [], writes: [], envelope: [], residency: 'either' as const },
      placeholder: utf8.encode('<span class="waiting">degraded</span>'),
      render: region(lane),
    })),
  }
}

export const DEFAULT_LANES: RaceLane[] = [
  { name: 'slow', ms: 900 },
  { name: 'fast', ms: 120 },
  { name: 'medium', ms: 450 },
]

export function lanesFrom(query: URLSearchParams): RaceLane[] {
  const read = (key: string, fallback: number): number => {
    const value = Number(query.get(key) ?? fallback)
    return Number.isFinite(value) ? Math.min(3000, Math.max(0, value)) : fallback
  }
  return [
    { name: 'slow', ms: read('slow', 900) },
    { name: 'fast', ms: read('fast', 120) },
    { name: 'medium', ms: read('medium', 450) },
  ]
}
