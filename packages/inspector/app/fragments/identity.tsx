import { fragment, type Ctx } from '@weftjs/core'

/** The smallest fragment that changes a page's cache class: one identity read. The contagion station is this file inside a shell that reads nothing. */
export default fragment(async (ctx: Ctx) => {
  const user = await ctx.user()
  const tier = ctx.header('x-tier') ?? 'standard'

  return (
    <p class="greeting" data-tier={tier}>
      Signed in as <strong>{user}</strong> · {tier} tier
    </p>
  )
})
