import { fragment } from 'weft'
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
 * The ordinary case, which most pages are.
 *
 * No streaming, no channel, no deltas, no epochs. One route, one component imported from another
 * module and rendered three times, props passed down, and a page that arrives in one piece. Every
 * region here buffers, so the plan lowers to `in-order` and the ~1 KB out-of-order filler is not
 * on the wire at all — the streaming machinery is opt-in per slot rather than the price of using
 * the framework.
 *
 * The three instances are written out rather than mapped because a component inside a list row is
 * `E_COMPONENT_IN_LIST` today. That is a real limitation and it is on the roadmap; writing them out
 * is also what makes the “one sealed template, three instances” count checkable.
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
