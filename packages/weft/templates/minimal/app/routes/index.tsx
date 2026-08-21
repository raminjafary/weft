import { fragment } from 'weft'

/**
 * The smallest weft application there is. One file, no data file, no layout, no config.
 *
 * The framework's own document wraps it, its stylesheet is linked, and the plan that placed this
 * on the page was generated from the fact that this file exists.
 */
export default fragment(() => (
  <>
    <h1>__NAME__</h1>
    <p class="weft-lede">
      Edit <code>app/routes/index.tsx</code>. Add <code>app/routes/about.tsx</code> and it is
      <code>/about</code> — there is no table to register it in.
    </p>
  </>
))
