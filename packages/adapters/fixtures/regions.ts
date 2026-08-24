/**
 * Regions a service can reach by name, which is the other side of a tier boundary.
 *
 * Each one declares the region it serves rather than taking it from the request. That is the
 * property the composite's check rests on: a registry entry pointing one region's name at another
 * region's deployment is refused by the shell, and a service that echoed back whatever it was
 * asked for would make that check unfalsifiable.
 */
import { frame, type Frame } from '@weft/warp'
import type { RegionRequest } from '@weft/kernel'

const utf8 = new TextEncoder()

export const search = {
  region: 'search',
  // The reads are part of the contract because a composite derives a cache class and a `Vary` from
  // them before this region has answered. `route:q` is the query parameter below, in the same
  // vocabulary the compiler uses for a local fragment's reads.
  contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
  render(request: RegionRequest): string {
    const q = request.params?.q ?? ''
    return `<form role=search><input value="${q}"></form>`
  },
}

/** A region that says what a client needs as well as what it looks like. */
export const results = {
  region: 'results',
  render(): Frame[] {
    return [
      frame('HTML', { s: 'results' }, utf8.encode('<ul><li>one</li></ul>'), true),
      frame('TPL', { s: 'results', tpl: 'results-1' }),
      frame('CSS', { href: '/a/results.css' }),
    ]
  },
}

/** The deployment a misconfigured registry entry points at. It serves recommendations, honestly. */
export const recs = {
  region: 'recs',
  render(): string {
    return '<ul class=recs></ul>'
  },
}

/** A region on a version this shell was not built against. */
export const searchAhead = {
  region: 'search',
  contract: { id: 'search', version: '3.0.0' },
  render(): string {
    return '<form role=search data-v=3></form>'
  },
}

/** A region that writes into a hole that is not its own. */
export const nosy = {
  region: 'search',
  render(): Frame[] {
    return [
      frame('HTML', { s: 'search' }, utf8.encode('<form></form>'), true),
      frame('DELTA', { s: 'cart' }, utf8.encode('{"changed":{"total":0}}'), true),
    ]
  },
}

export const broken = {
  region: 'search',
  render(): string {
    throw new Error('the index is rebuilding')
  },
}

export const notARegion = { render: () => '<p>no name</p>' }
