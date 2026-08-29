import { fragment, signal } from '@weftjs/core'
import { quantity } from '../../intents/quantity.ts'

/**
 * A signal, and a value derived from it. `qty() * unitPrice` travels as a tree the client
 * evaluates, no closure or hydration needed. See `spec/ir/template-ir-2.md`.
 *
 * `value={qty()}` needs a property write, not an attribute write, once somebody has typed. See
 * `spec/compiler/supported-subset.md`: Controls. `onInput` names an intent — the only inbound
 * wiring op — or typing into this would do nothing. See `spec/ir/template-ir-2.md`: Wiring table.
 */
export default fragment(({ unitPrice }: { unitPrice: number }) => {
  const qty = signal(1)
  return (
    <form class="signals">
      <label>
        quantity
        <input type="number" name="qty" min="0" value={qty()} onInput={quantity} />
      </label>
      <p class="line">
        <span class="unit">{unitPrice}</span> × <output class="qty">{qty()}</output> ={' '}
        <output class="total">{qty() * unitPrice}</output>
      </p>
      <p class="over" data-over={qty() > 9}>
        over nine
      </p>
    </form>
  )
})
