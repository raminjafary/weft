import { fragment, type Ctx } from '@weft/core'
import { setQuantity } from '../intents/cart.ts'

interface Line {
  sku: string
  name: string
  qty: number
  price: number
  total: number
}

interface CartProps {
  lines: Line[]
  subtotal: number
  shipping: number
  total: number
}

/**
 * The hard case: a signed-in region. This fragment reads identity, so its class is `private` and
 * it can never be a shared entry — and because it is a slot in a shared shell, the shell stays
 * shared and only this region is per-user. That is contagion working rather than a page becoming
 * uncacheable because one line of it is personal.
 *
 * The quantity boxes name an intent. There is no signal here and there should not be: a cart total
 * is not something a client should guess at. Typing sends the row's `sku` and the new quantity,
 * the server recomputes the line, the subtotal and the total, and what comes back is a delta —
 * one DOM write per value that actually changed.
 */
export default fragment(async ({ lines, subtotal, shipping, total }: CartProps, ctx: Ctx) => {
  // These two reads are the whole reason this region is a slot rather than part of the shell.
  // `identity` forces the class to private; the cookie adds Cookie to Vary and a component to
  // the key. Neither is declared anywhere: they are inferred from these two lines.
  const user = await ctx.user()
  const currency = ctx.cookie('currency') ?? 'IQD'

  return (
    <section class="cart">
      <h2>Welcome back, {user}</h2>
      <table>
        <tbody>
          {lines.map((line) => (
            <tr data-sku={line.sku}>
              <td class="name">{line.name}</td>
              <td class="qty">
                <input type="number" name="qty" value={line.qty} min="0" onInput={setQuantity} />
              </td>
              <td class="price">{line.price}</td>
              <td class="line-total">{line.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl class="totals">
        <dt>Subtotal</dt>
        <dd class="subtotal">{subtotal}</dd>
        <dt>Shipping</dt>
        <dd class="shipping">{shipping}</dd>
        <dt>Total</dt>
        <dd class="total">
          {total} {currency}
        </dd>
      </dl>
    </section>
  )
})
