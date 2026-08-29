import { defineRoute } from '@weftjs/core'
import { lane, laneName, lanesFrom, type RaceLane } from '../../../lib/race.ts'

/**
 * The streaming race: the same three regions and latencies, served in both orders. The order is a
 * route param rather than a query string — the old hand-written server smuggled it past the router
 * in a module-level variable instead. Nothing animates: each region reports its own render time.
 */
const NOTE: Record<'in-order' | 'out-of-order', string> = {
  'out-of-order':
    'fastest first: the shell went out with an anchor at each slot, and whichever region resolved first was sent first.',
  'in-order':
    'document order: each region streams where it sits, so the fast one waits behind the slow one above it.',
}

const slot = (name: RaceLane['name']) => ({
  fragment: 'markup' as const,
  stream: true as const,
  placeholder: '<span class="waiting">degraded</span>',
  html: (ctx: { query(key: string): string | undefined }) => lane(name, lanesFrom(ctx)),
})

export default defineRoute({
  layout: 'race',
  order: (params) => laneName(params.order),
  head: (params) => ({ title: `${laneName(params.order)} · weft` }),
  layoutValues: (params) => {
    const here = laneName(params.order)
    return {
      order: here,
      note: NOTE[here],
      // Both orders, always, with this one marked. The page exists to compare them, and it has its
      // own layout so it can be watched in a frame — which is also how it became a page you could
      // arrive at and not leave.
      modes: (['out-of-order', 'in-order'] as const).map((mode) => ({
        href: `/live/race/${mode}`,
        label: mode,
        current: mode === here ? 'yes' : 'no',
      })),
    }
  },
  slots: { slow: slot('slow'), fast: slot('fast'), medium: slot('medium') },
})
