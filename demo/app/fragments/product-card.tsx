import { fragment } from '@weftjs/core'

interface CardProps {
  sku: string
  name: string
  price: number
  unit: string
  badge: string
  available: boolean
  /** What the shared demo cart holds of this line, already worded. Empty when it holds none. */
  cart: string
}

/**
 * An ordinary component, sealed once — three instances cost three cards of content and no extra
 * template. See `spec/ir/template-ir-2.md`. The button is a plain form post, working with
 * JavaScript disabled, to the same intent the cart page dispatches over a socket.
 */
export default fragment(({ sku, name, price, unit, badge, available, cart }: CardProps) => (
  <article class="product">
    <h3>{name}</h3>
    <p class="price">
      {price} <span class="unit">{unit}</span>
    </p>
    <p class="badge">{badge}</p>
    <form method="post" action="/_weft/i/cart.add">
      <input type="hidden" name="sku" value={sku} />
      <input type="hidden" name="qty" value="1" />
      <button type="submit" disabled={!available}>
        Add to cart
      </button>
    </form>
    <p class="in-cart">{cart}</p>
  </article>
))
