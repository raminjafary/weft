import {
  bindingExecutor,
  createComposer,
  manifestRegistry,
  probeRegions,
  regionGraph,
  regionService,
  type ComposeOptions,
  type RegionRenderer,
  type RegionRequest,
} from '@weftjs/core'

/** The other side of the boundary: a region, as a module — `{ region, contract, render }`, no gateway, no adapter. See `spec/kernel/composition.md`. */
const CATALOGUE = ['sumac', 'barhi dates', 'ceylon tea', 'pomegranate molasses', 'freekeh']

/** What this deployment composes: `search` is a region above it and a composite to `ranking` below it, same mechanism either way. */
const rankingTier = bindingExecutor({
  binding: regionService({ root: new URL('./', import.meta.url).href, revision: 'ranking-7' }),
  name: 'binding:ranking',
  timeoutMs: 300,
})

const ports: ComposeOptions['ports'] = {
  executors: { 'binding:ranking': rankingTier },
  registry: manifestRegistry([], {
    regions: [
      {
        region: 'ranking',
        executor: 'binding:ranking',
        address: { module: './ranking-region.ts', export: 'ranking' },
        contract: { id: 'ranking', version: '1.0.0', reads: ['route:q'] },
        revision: 'ranking-7',
      },
    ],
  }),
}

export const search: RegionRenderer = {
  region: 'search',
  contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
  /** What this region composes, asked rather than rendered — the recursive half of `weft verify --probe`. See `spec/kernel/composition.md`. */
  probe: (depth) => probeRegions(ports, ['ranking'], depth),

  async render(request: RegionRequest) {
    // `reads`, not the query string: the composite already resolved `route:q` to derive the document's cache key.
    const q = request.reads?.['route:q'] ?? ''
    // A shell value handed over, not reached for — this region cannot read the shell's variables or any global.
    const currency = request.exposed?.currency ?? ''
    const inCart = request.exposed?.cartCount ?? '0'
    const found = q ? CATALOGUE.filter((item) => item.includes(q.toLowerCase())) : CATALOGUE

    // A composer per render, not one shared: `composed` and `hops` are a page's, not a number this file could hold across requests.
    const composer = createComposer({ ports })
    const ranked = await composer.compose(
      { region: 'ranking', onExceed: 'placeholder' },
      q ? { reads: { 'route:q': q } } : {},
    )

    return {
      html:
        `<form role="search" data-region="search"><input name="q" value="${escape_(q)}"></form>` +
        `<ul class="results">${found.map((item) => `<li>${escape_(item)}</li>`).join('')}</ul>` +
        new TextDecoder().decode(ranked.bytes) +
        `<p class="hint" data-currency="${escape_(currency)}">rendered by the search deployment in ${escape_(currency)}, ${found.length} of ${CATALOGUE.length}, ${escape_(inCart)} in the cart</p>`,
      // Measured rather than declared: a degraded ranking tier reports the boundary it did not cross.
      composed: regionGraph(composer.composed),
    }
  },
}

/** The same region, one minor ahead of what the shell was built against — so the arrival check is demonstrable, not just described. */
export const searchAhead: RegionRenderer = {
  region: 'search',
  contract: { id: 'search', version: '2.2.0', reads: ['route:q'] },
  render: (request) => search.render(request),
  ...(search.probe ? { probe: search.probe.bind(search) } : {}),
}

function escape_(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
