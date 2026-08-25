import type { RegionRenderer, RegionRequest } from 'weft'

/**
 * The third tier: a region composed by a region.
 *
 * It exists to make one number falsifiable. A page composing `search` used to report the boundaries
 * it could see, and a region that reached a further deployment of its own said so with a hop count
 * nobody could check — a tree in the numbers and not in the resolution. `search` composes this, so
 * `weft verify --probe` has something to draw: two tiers under one route, each resolved by its own
 * registry, spliced into one graph.
 *
 * It is deliberately trivial otherwise. What is being demonstrated is the topology, and a ranking
 * model would be a second thing to explain.
 */
const WEIGHTS: Record<string, number> = {
  sumac: 3,
  'barhi dates': 5,
  'ceylon tea': 4,
  'pomegranate molasses': 2,
  freekeh: 1,
}

export const ranking: RegionRenderer = {
  region: 'ranking',
  contract: { id: 'ranking', version: '1.0.0', reads: ['route:q'] },
  render(request: RegionRequest) {
    const q = request.reads?.['route:q'] ?? ''
    const ordered = Object.entries(WEIGHTS)
      .filter(([item]) => !q || item.includes(q.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
    return (
      `<ol class="ranked" data-region="ranking">` +
      ordered.map(([item, weight]) => `<li>${escape_(item)} <small>${weight}</small></li>`).join('') +
      `</ol>`
    )
  },
}

function escape_(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
