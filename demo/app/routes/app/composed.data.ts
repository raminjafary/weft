import { defineRoute } from '@weft/core'
import { cartOf } from '../../lib/data.ts'

/**
 * A page whose search box is another deployment's.
 *
 * The sixth shape, and the only one where part of the document is rendered somewhere this process
 * cannot see. What makes it worth being a whole page rather than a station is that the composition
 * is invisible from here: `search` is a slot with a `region` on it, and every other line in this file
 * is the same vocabulary the other five pages use — a cache class, a fallback, a budget.
 *
 * Three things this declaration deliberately does not say.
 *
 * **Where the region is.** That is `weft.config.ts`, so rolling the search deployment to a new
 * revision is a write there rather than a rebuild of this page. A shell that named the tier would
 * make the registry pointless.
 *
 * **What the region reads.** The contract says, and the contract comes from the region's own
 * compiler. This shell runs those reads through the same derivation a local fragment's go through —
 * so `reads: ['route:q']` puts `q` in this document's key and its `Vary`, and a region that
 * described nothing would make the whole page private, because unknown is not nothing.
 *
 * **What a cache key is.** Same as everywhere else: there is no setter, and a region cannot bring
 * one across the boundary either.
 */
export default defineRoute({
  layout: 'composed',
  head: {
    title: 'A page another deployment helps render · weft demo',
    description: 'One hole in this document is filled by a region on a different deployment.',
  },
  /**
   * A function, not an object, and that is the difference between an exposed value that moves and one
   * that was baked in when the module was imported. `cartCount` below is derived from state an intent
   * writes, so it has to be read per render.
   */
  layoutValues: () => ({
    heading: 'A page another deployment helps render',
    shows:
      'The search box and its results come from a deployment this process reaches through the registry. The markup that lands in the hole is byte-identical to the monolith version of the same region.',
    /**
     * Exposed below, and deliberately not a hole in the layout.
     *
     * A shell value and a shell *hole* are different things: neither of these is rendered into the
     * document at all, they are only offered to the regions inside it. That is what makes the exposed
     * set a channel rather than a side effect of what the layout happens to display.
     */
    currency: 'IQD',
    /**
     * The design's own example of an exposed signal, and the half that moves.
     *
     * `cart.add` writes the tag this is derived from, so adding a line changes it — and every open
     * page composing a region that consumes it gets a `SIGNAL` naming exactly this value. The region
     * decides for itself what a new number means for its own markup, which is the point: the shell
     * offers a value, not a re-render.
     */
    cartCount: String([...cartOf('demo-shared').values()].reduce((sum, n) => sum + n, 0)),
  }),
  /**
   * `?q=` is what the region reads, and the document says so because the region's contract said so.
   * A page composed out of an undescribed region cannot be public at all, which is the check.
   */
  document: { class: 'public', ttl: '5m' },
  /**
   * The one channel between this shell and the regions inside it.
   *
   * Declared rather than discovered, because the value of a single channel is that it can be
   * checked: a region declaring `consumes: ['currency']` on a page that exposes nothing fails the
   * build with `E_NOT_EXPOSED`, where the alternative is a region reading a global that happens to
   * exist on one page and not on another.
   *
   * Both names are `layoutValues` above, so what the region is handed is what this page actually
   * rendered with — not a second source that could disagree with it.
   */
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
    /**
     * The region. `remote` says a boundary is crossed and the contract says what this shell was
     * built expecting on the far side; the fallback is what the reader gets when the two disagree
     * or the deployment is not there. A budget on a boundary is a deadline on *waiting*, because
     * the other end cannot be killed from here.
     */
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
