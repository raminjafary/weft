import { fragment } from 'weft'
import { setQuantity } from './intents.ts'

export default fragment(({ epoch, rows, total }) => (
  <>
    <ul class="lines" data-epoch={epoch}>
      {rows.map((row) => (
        <li data-sku={row.sku} onInput={setQuantity}>
          <span class="name">{row.name}</span>
          <span class="qty">{row.qty}</span>
          <span class="price">{row.price}</span>
        </li>
      ))}
    </ul>
    <p class="total">Total: {total} IQD</p>
  </>
))
