import { fragment } from 'weft'

/**
 * The bytes a region sends when it degrades: honest, cheap, and visibly incomplete.
 *
 * It has no holes at all, so it is constant — one sealed template whose version never changes and
 * whose render is a buffer copy. That is what makes it usable as a placeholder in a budget: a
 * fallback that had to query something could fail the same way the region it stands in for did.
 */
export default fragment(() => (
  <div class="degraded" data-degraded>
    <p>This part of the page is not here yet. The rest of it is unaffected.</p>
  </div>
))
