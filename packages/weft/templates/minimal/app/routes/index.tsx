import { fragment } from '@weftjs/core'

/**
 * The smallest weft application there is. One file, no data file, no layout, no config.
 *
 * The framework's own document wraps it, its stylesheet is linked, and the plan that placed this
 * on the page was generated from the fact that this file exists.
 *
 * `weft-center` is the framework's, which is why this stays one file: a page with a heading and a
 * sentence on it looks stranded against the left edge of a wide window, and the alternative to a
 * class that already exists would have been a stylesheet this template is trying not to need.
 */
export default fragment(() => (
  <section class="weft-center">
    <h1>__NAME__</h1>
    <p class="weft-lede">
      Edit <code>app/routes/index.tsx</code>. Add <code>app/routes/about.tsx</code> and it is
      <code>/about</code> — there is no table to register it in.
    </p>
  </section>
))
