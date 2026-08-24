import type { RegionRenderer, RegionRequest } from 'weft'

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

export const search: RegionRenderer = {
  region: 'search',
  contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
  render(request: RegionRequest) {
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
    return (
      `<form role="search" data-region="search"><input name="q" value="${escape_(q)}"></form>` +
      `<ul class="results">${found.map((item) => `<li>${escape_(item)}</li>`).join('')}</ul>` +
      `<p class="hint" data-currency="${escape_(currency)}">rendered by the search deployment in ${escape_(currency)}, ${found.length} of ${CATALOGUE.length}, ${escape_(inCart)} in the cart</p>`
    )
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
}

function escape_(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}
