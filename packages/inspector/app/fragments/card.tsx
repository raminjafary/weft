import { fragment } from '@weftjs/core'

interface CardProps {
  name: string
  price: number
  unit: string
  badge: string
  available: boolean
}

/** An ordinary component, sealed once: three instances cost three cards of content and not one byte of template. See `spec/ir/template-ir-2.md`. */
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
