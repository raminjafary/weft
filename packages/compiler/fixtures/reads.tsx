import { fragment } from '@weft/core'

/**
 * The shape from the design: take the context, and every read through it taints. Nothing
 * here declares a cache class — it is derived from these three lines.
 */
export default fragment((ctx) => {
  const currency = ctx.cookie('currency') ?? 'IQD'
  const locale = ctx.locale()
  const region = ctx.param('region') ?? 'baghdad'

  return (
    <section class="prices" data-currency={currency}>
      <p>
        Prices in {currency} for {region}
      </p>
      <span class="locale">{locale}</span>
    </section>
  )
})
