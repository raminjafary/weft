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

/**
 * The other side of the boundary: a region, as a module.
 *
 * This is the design's claim about tier boundaries with nothing between it and the reader. There is
 * no gateway here, no adapter, no translation layer — a region is `{ region, contract, render }`,
 * and what `render` returns is either markup or the same frames a local render already produces.
 * Both ends of the boundary run this framework, which is why serving a region is an export rather
 * than a service somebody writes.
 *
 * `region` is stated here and not taken from the request, and that is the whole security property.
 * The composite checks the name a region announces against the name it asked for, so a registry
 * entry pointing `search` at somebody else's deployment is refused rather than rendered into the
 * wrong hole. A service that echoed back whatever it was asked would make that check unfalsifiable.
 *
 * The contract carries `reads`, which is the field that decides a *header* on the composite: the
 * shell runs these through the same `cacheClassOf` and `varyOn` a local fragment's reads go through,
 * so a region that read a cookie without saying so would make a private page look shareable.
 */
const CATALOGUE = ['sumac', 'barhi dates', 'ceylon tea', 'pomegranate molasses', 'freekeh']

/**
 * What this deployment composes, which is the half of composition a demo usually leaves out.
 *
 * `search` is a region to the page above it and a *composite* to the region below it, and nothing
 * here is a second mechanism for that: the same composer, the same registry port, the same binding
 * executor the shell used to reach this file. That is the claim being demonstrated — a tier is a
 * tier, and the third one is not a special case of the second.
 *
 * These ports are this deployment's own. It has its own store, its own registry and its own
 * executor, because it *is* another deployment: the fact that this demo runs it in one process is
 * the binding executor's business and nobody else's.
 */
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
  /**
   * What this region composes, asked rather than rendered.
   *
   * The recursive half of `weft verify --probe`: the page above asks `search` what it is serving,
   * and `search` cannot answer for the tier under it without asking. The depth it was given is spent
   * here, which is what stops two deployments composing each other from asking forever.
   */
  probe: (depth) => probeRegions(ports, ['ranking'], depth),

  async render(request: RegionRequest) {
    /**
     * `reads` and not the query string, and the difference is the point.
     *
     * The composite resolved `route:q` before it rendered anything, because it needed that value to
     * derive the document's cache key. Taking the same value from `reads` is what makes this
     * region's answer a function of what the key describes. Reaching for the request itself — even
     * if a region could — would produce a page whose key did not describe what rendered it.
     */
    const q = request.reads?.['route:q'] ?? ''
    /**
     * A shell value, handed over rather than reached for.
     *
     * This region has no way to read the shell's variables — they are in another deployment's module
     * graph — and deliberately no way to read a global. What it declared it consumes is what arrives
     * here, and a name it did not declare is not in this object at all.
     */
    const currency = request.exposed?.currency ?? ''
    const inCart = request.exposed?.cartCount ?? '0'
    const found = q ? CATALOGUE.filter((item) => item.includes(q.toLowerCase())) : CATALOGUE

    /**
     * The tier below, composed the way the tier above composed this one.
     *
     * A composer per render and not one shared: `composed` and `hops` are a *page's*, and one
     * instance held across requests would report a number belonging to whoever asked last. The
     * ranking region's markup goes in this region's markup, and what it cost goes back with it —
     * which is how the hop count above stops being a number this file declared.
     */
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
      // Measured rather than declared, which is the whole difference: a run where the ranking tier
      // degraded reports the boundary it did not cross, because this is what happened and not what
      // the topology says usually happens.
      composed: regionGraph(composer.composed),
    }
  },
}

/**
 * The same region, one minor ahead of what the shell was built against.
 *
 * Here so the arrival check is something the demo can produce rather than describe: point the
 * registry at this export and the page degrades to its declared fallback with the contract named,
 * which is the window a contract test in CI cannot close.
 */
export const searchAhead: RegionRenderer = {
  region: 'search',
  contract: { id: 'search', version: '2.2.0', reads: ['route:q'] },
  render: (request) => search.render(request),
  ...(search.probe ? { probe: search.probe.bind(search) } : {}),
}

function escape_(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
