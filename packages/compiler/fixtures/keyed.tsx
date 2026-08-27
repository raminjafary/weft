import { fragment } from '@weft/core'
import { newCart } from './flags.ts'

/**
 * Every read in the surface that a cache key can be derived from, in one fragment, so the
 * runtime resolver has something real to resolve rather than a hand-written effect set.
 *
 * Identity and `ctx.raw()` are deliberately absent: each changes the answer rather than
 * adding to it, so each has its own fixture.
 */
export default fragment(async (ctx) => {
  const layout = await ctx.flag(newCart)
  const variant = layout ? 'v2' : 'v1'
  const currency = ctx.cookie('currency') ?? 'IQD'
  const tier = ctx.header('x-tier') ?? 'standard'
  const region = ctx.param('region') ?? 'baghdad'
  const sort = ctx.query('sort') ?? 'price'
  const locale = ctx.locale()
  const device = ctx.device()
  const asOf = ctx.now()

  return (
    <section class="keyed" data-layout={variant} data-device={device}>
      <p>
        {currency} · {region} · {sort} · {tier}
      </p>
      <span class="locale">{locale}</span>
      <time>{asOf}</time>
    </section>
  )
})
