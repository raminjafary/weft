import { fragment } from 'weft'

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
 * An ordinary component. Props in, markup out, no ceremony.
 *
 * It is sealed once. Rendering it three times on a page adds three cards of content and not one
 * byte of template, and it is not re-parsed, re-evaluated or re-mounted per instance — the parent
 * projects the values into the child's holes. Nothing about that requires the page to stream.
 *
 * The button is a form rather than a click handler, and that is the demonstration rather than a
 * shortcut. This page has no channel and no client-side state; the intent it posts to is the same
 * one the cart page dispatches over a socket, reached at the name its author gave it, and the
 * answer is a 303 back to here. It works with JavaScript disabled, which is the property the
 * framework claims for every write and the one nothing else in this demo lets you press.
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
