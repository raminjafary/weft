import { fragment } from '@weftjs/core'

interface CardProps {
  name: string
  price: number
  unit: string
  badge: string
  available: boolean
}

/**
 * An ordinary component. Props in, markup out, no ceremony.
 *
 * It is sealed once. Rendering it three times on a page adds three cards of content and not one
 * byte of template, and it is not re-parsed, re-evaluated or re-mounted per instance — the parent
 * projects the values into the child's holes. Nothing about that requires the page to stream.
 */
export default fragment(({ name, price, unit, badge, available }: CardProps) => (
  <article class="product">
    <h3>{name}</h3>
    <p class="price">
      {price} <span class="unit">{unit}</span>
    </p>
    <p class="badge">{badge}</p>
    <button type="button" disabled={!available}>
      Add to cart
    </button>
  </article>
))
