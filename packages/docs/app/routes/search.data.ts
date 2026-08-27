import { defineRoute } from 'weft'
import { shell } from '../lib/shell.ts'
import { indexSize, searchBody } from '../lib/search.ts'

/**
 * Search, as a GET.
 *
 * The same shape as the playground and for the same reasons: the query is a parameter, so a result
 * page has a URL, and reading it taints `route:q` — which makes each query its own cache entry,
 * content-addressed by construction. There is no index to build and nothing to download.
 *
 * Like the playground, it cannot be a file. The build's probes do not invent a query, so they would
 * prove this page invariant and freeze the empty state — which is the one state it is not for.
 */
export default defineRoute({
  head: {
    title: 'Search · weft',
    description: 'Search the guide, the tutorial, the glossary, every error code and every export.',
  },
  layoutValues: shell({
    heading: 'Search',
    lede: `Everything on this site, matched against what you type. ${indexSize()} entries, and no index to download.`,
  }),
  static: false,
  notStaticBecause:
    'its body is a function of `?q`, and neither build probe invents that key — so the page would render identically twice and be frozen showing the empty state',
  slots: {
    body: {
      html: (ctx) => searchBody(ctx.query('q') ?? ''),
    },
  },
})
