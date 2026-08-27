import { fragment } from '@weftjs/core'
import { setQuantity } from './intents.ts'

interface Row {
  sku: number
  name: string
  qty: number
  price: number
}

interface LinesProps {
  epoch: string
  rows: Row[]
  total: number
}

export default fragment(({ epoch, rows, total }: LinesProps) => (
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
