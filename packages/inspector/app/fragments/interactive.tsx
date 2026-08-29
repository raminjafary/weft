import { fragment, signal } from '@weftjs/core'
import { setQuantity } from '../intents/cart.ts'

interface InteractiveProps {
  sku: string
  name: string
  unitPrice: number
}

/**
 * The interactive region every client station adopts. `qty` is a signal; `qty() * unitPrice` is a
 * derived value, travelling as a tree rather than code. See `spec/ir/template-ir-2.md`.
 * `value={qty()}` needs a property write, not an attribute one — see `spec/compiler/supported-subset.md`: Controls.
 */
export default fragment(({ sku, name, unitPrice }: InteractiveProps) => {
  const qty = signal(1)
  return (
    <form class="interactive" data-sku={sku}>
      <p class="name">{name}</p>
      <label>
        quantity
        <input type="number" name="qty" min="0" value={qty()} onInput={setQuantity} />
      </label>
      <p class="line">
        <span class="unit">{unitPrice}</span> ×<output class="qty">{qty()}</output> =
        <output class="total">{qty() * unitPrice}</output>
      </p>
      <p class="over" data-over={qty() > 9}>
        over nine
      </p>
    </form>
  )
})
