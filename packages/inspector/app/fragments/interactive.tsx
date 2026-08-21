import { fragment, signal } from 'weft'
import { setQuantity } from '../intents/cart.ts'

interface InteractiveProps {
  sku: string
  name: string
  unitPrice: number
}

/**
 * The interactive region every client station adopts.
 *
 * `qty` is a signal, so the compiler emits a wiring entry for each node that reads it and the
 * client wires those nodes on adoption — no component code runs, and the cost is the number of
 * bindings rather than the number of components.
 *
 * `qty() * unitPrice` is a derived value. The expression travels on the wire as a tree, not as
 * code, which is what lets the client recompute it without shipping a component. `value={qty()}`
 * on the input is the case that needs a *property* write rather than an attribute write: once a
 * user has typed, the attribute and the live value have stopped agreeing, and only the property is
 * what the user sees.
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
