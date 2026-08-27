import { fragment } from '@weft/core'

/**
 * A slot the layout leaves, filled on every route that does not fill it itself.
 *
 * The layout's `<slot name="footer">` is what makes this a boundary the kernel can send bytes
 * before, rather than a component the page has to wait for.
 */
export default fragment(() => (
  <footer class="weft-foot">
    <p>
      Built with <a href="https://github.com/raminjafary/weft">weft</a>. This footer is
      <code>app/slots/footer.tsx</code>, and nothing registered it.
    </p>
  </footer>
))
