import { fragment, type Ctx } from '@weftjs/core'
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

/** The hard case: a signed-in region, `private`, isolated as a slot so the shared shell stays shared. See `spec/compiler/effects.md`. */
export default fragment(async ({ lines, subtotal, shipping, total }: CartProps, ctx: Ctx) => {
  // These two reads are the whole reason this region is a slot rather than part of the shell — both inferred, neither declared.
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
