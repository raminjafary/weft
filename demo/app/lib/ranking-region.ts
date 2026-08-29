import type { RegionRenderer, RegionRequest } from '@weftjs/core'

/** The third tier: a region composed by a region, so `weft verify --probe` has a real tree to draw. See `spec/kernel/composition.md`. */
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
