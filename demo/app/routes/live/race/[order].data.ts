import { defineRoute } from 'weft'
import { lane, laneName, lanesFrom, type RaceLane } from '../../../../src/race.ts'

/**
 * The streaming race: the same three regions, the same three latencies, served in both orders.
 *
 * The order is a route parameter rather than a query string, and that is the fix for the one place
 * the old hand-written server admitted it was reaching around the framework. A `RouteResolver`
 * receives params, so an order that is a param is something the plan can be resolved for; an order
 * that was a query string was something the server had to smuggle past the router in a
 * module-level variable.
 *
 * Nothing here animates. Each region reports the millisecond it was rendered at, so the arrival
 * order is still legible after the page has finished loading.
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
  layoutValues: (params) => ({
    order: laneName(params.order),
    note: NOTE[laneName(params.order)],
  }),
  slots: { slow: slot('slow'), fast: slot('fast'), medium: slot('medium') },
})
