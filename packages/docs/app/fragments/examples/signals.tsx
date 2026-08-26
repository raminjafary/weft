import { fragment, signal } from 'weft'
import { quantity } from '../../intents/quantity.ts'

/**
 * A signal, and a value derived from it.
 *
 * `qty` is client-owned: the server renders it at its initial value and the browser owns it from
 * adoption onwards. `qty() * unitPrice` is *derived*, so the expression travels on the wire as a
 * tree the client evaluates — there is no closure to ship and no component to hydrate. What the
 * client wires on adoption is one entry per node that reads the signal, so the cost is the number
 * of bindings rather than the number of components.
 *
 * `value={qty()}` on the input is the case that needs a property write rather than an attribute
 * write: once somebody has typed, the attribute and the live value have stopped agreeing, and only
 * the property is what they see.
 *
 * `onInput` names an intent because that is the only inbound wiring op there is — a signal a reader
 * can change needs one, or the binding the client writes it through does not exist. Without it this
 * example was one-way and typing into it did nothing, on the page about adoption.
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
