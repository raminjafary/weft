import { fragment } from 'weft'

/**
 * What the reader gets when the search deployment cannot answer, or answers with a contract this
 * page was not built against.
 *
 * A declared degradation rather than an empty hole, and the difference matters: `optional()` means
 * failure is invisible and nobody is paged, which is right for recommendations and wrong for the
 * search box. This says the page is still here and one part of it is not.
 */
export default fragment(() => (
  <div class="card" data-degraded>
    <h3>Search is unavailable</h3>
    <p>The rest of this page is unaffected, which is what a tier boundary buys.</p>
  </div>
))
