import { fragment } from '@weftjs/core'
import ProductCard from './card.tsx'

interface OrdinaryProps {
  category: string
  intro: string
  firstName: string
  firstPrice: number
  firstUnit: string
  firstBadge: string
  firstAvailable: boolean
  secondName: string
  secondPrice: number
  secondUnit: string
  secondBadge: string
  secondAvailable: boolean
  thirdName: string
  thirdPrice: number
  thirdUnit: string
  thirdBadge: string
  thirdAvailable: boolean
}

/**
 * The ordinary case, which most pages are: one route, one component rendered three times, props
 * passed down, a page that arrives in one piece — no streaming machinery on the wire since every
 * region here buffers. Written out rather than mapped because a component inside a list row is
 * `E_COMPONENT_IN_LIST` today (a real limitation, on the roadmap).
 */
export default fragment(
  ({
    category,
    intro,
    firstName,
    firstPrice,
    firstUnit,
    firstBadge,
    firstAvailable,
    secondName,
    secondPrice,
    secondUnit,
    secondBadge,
    secondAvailable,
    thirdName,
    thirdPrice,
    thirdUnit,
    thirdBadge,
    thirdAvailable,
  }: OrdinaryProps) => (
    <section class="ordinary">
      <h2>{category}</h2>
      <p class="standfirst">{intro}</p>
      <div class="products">
        <ProductCard
          name={firstName}
          price={firstPrice}
          unit={firstUnit}
          badge={firstBadge}
          available={firstAvailable}
        />
        <ProductCard
          name={secondName}
          price={secondPrice}
          unit={secondUnit}
          badge={secondBadge}
          available={secondAvailable}
        />
        <ProductCard
          name={thirdName}
          price={thirdPrice}
          unit={thirdUnit}
          badge={thirdBadge}
          available={thirdAvailable}
        />
      </div>
    </section>
  ),
)
