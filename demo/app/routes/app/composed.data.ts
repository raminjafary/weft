import { defineRoute } from '@weftjs/core'
import { cartOf } from '../../lib/data.ts'

/** A page whose search box is another deployment's — `search` is a slot with a `region` on it. See `spec/kernel/composition.md`. */
export default defineRoute({
  layout: 'composed',
  head: {
    title: 'A page another deployment helps render · weft demo',
    description: 'One hole in this document is filled by a region on a different deployment.',
  },
  /** A function, not an object: `cartCount` is derived from state an intent writes, so it has to be read per render. */
  layoutValues: () => ({
    heading: 'A page another deployment helps render',
    shows:
      'The search box and its results come from a deployment this process reaches through the registry. The markup that lands in the hole is byte-identical to the monolith version of the same region.',
    // Exposed below, deliberately not a hole in the layout: neither value is rendered into the document itself.
    currency: 'IQD',
    // The design's own example of an exposed signal: cart.add writes the tag this is derived from. See `spec/kernel/composition.md`.
    cartCount: String([...cartOf('demo-shared').values()].reduce((sum, n) => sum + n, 0)),
  }),
  /** `?q=` is what the region reads, per its contract. A page composed out of an undescribed region cannot be public. */
  document: { class: 'public', ttl: '5m' },
  /** The one channel between this shell and the regions inside it. See `spec/kernel/composition.md`. */
  exposes: ['currency', 'cartCount'],
  slots: {
    panel: {
      fragment: 'markup',
      stream: false,
      html: `<div class="card"><h3>What is on the other side</h3>
        <p>The region is <code>demo/app/lib/search-region.ts</code>, reached through the executor
        <code>weft.config.ts</code> binds. Run <code>weft verify --probe</code> to ask it what
        contract it is serving right now, and <code>weft why /app/composed</code> to see the hop
        count and the locus this plan was built on.</p>
        <form class="controls" method="get"><input name="q" placeholder="tea"><button>search</button></form></div>`,
    },
    /** The region. `remote` crosses a boundary; the fallback is what the reader gets when the contract disagrees. See `spec/kernel/composition.md`. */
    search: {
      stream: false,
      region: {
        remote: { id: 'search', version: '2.1.0', reads: ['route:q'] },
        fallback: 'degraded',
        /** Checked against `exposes` above at build time, and against the page's own set at run time. */
        consumes: ['currency', 'cartCount'],
      },
      budget: { cpu: '250ms' },
    },
    body: {
      fragment: 'markup',
      stream: false,
      html: `<div class="card"><h3>Why this is one mechanism and not two</h3>
        <p>A region fills a hole in the shell, is dispatched in a wave, may be cached, may be
        refreshed, and degrades on a policy. Every one of those is a slot's behaviour — so a region
        <em>is</em> a slot, and the only thing it adds is where its code lives and what happens when
        the other end is having a bad afternoon.</p>
        <p>A region bound to <code>inline</code> goes through the same executor every other slot on
        this page goes through. That is what keeps the collapsed single-process shape the
        best-tested path rather than the one nobody runs.</p></div>`,
    },
  },
})
