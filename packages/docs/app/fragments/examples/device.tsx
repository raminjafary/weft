import { fragment, type Ctx } from 'weft'

/**
 * A read with three possible values, which is what makes it an ahead-of-time permutation.
 *
 * `ctx.device()` taints `device`, and the plan can carry a branch per value rather than a branch
 * taken per request: low cardinality is the property that lets a read become an axis. The fragment
 * does not know which one it will be rendered for, and does not need to.
 */
export default fragment(async (ctx: Ctx) => {
  const tier = ctx.device()
  return (
    <p class="device">
      This deployment thinks you are on a <strong>{tier}</strong> device, so the plan reachable from here is
      the one built for that tier.
    </p>
  )
})
