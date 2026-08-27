import { fragment } from '@weft/core'

/** One identity read is enough to make a fragment private, whatever else it does. */
export default fragment(async (ctx) => {
  const user = await ctx.user()
  const currency = ctx.cookie('currency') ?? 'IQD'
  return (
    <p class="greeting">
      Welcome back, {user} — prices in {currency}
    </p>
  )
})
