import { fragment } from '@weftjs/core'

interface Hit {
  sku: string
  name: string
}

/**
 * A region: a fragment that happens to render on another deployment.
 *
 * There is nothing in this file about being remote, and there is nothing to add. What crosses the
 * boundary is a warp frame — the same protocol every render already produces — so the composite
 * embedding it does not learn a second runtime, and a failure over there degrades this one hole
 * rather than the page.
 */
export default fragment(({ query, hits }: { query: string; hits: Hit[] }) => (
  <section class="region" data-region="search">
    <p class="meta">
      Results for <strong>{query}</strong>, from the search deployment
    </p>
    <ul class="hits">
      {hits.map((hit) => (
        <li data-sku={hit.sku}>{hit.name}</li>
      ))}
    </ul>
  </section>
))
