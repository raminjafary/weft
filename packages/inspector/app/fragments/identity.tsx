import { fragment, type Ctx } from '@weft/core'

/**
 * The smallest fragment that changes a page's cache class. One identity read and this region can
 * never be a shared entry — and because it is a slot rather than part of the shell, the shell
 * stays shared and only this fragment is per-user.
 *
 * The contagion station is this file inside a shell that reads nothing.
 */
export default fragment(async (ctx: Ctx) => {
  const user = await ctx.user()
  const tier = ctx.header('x-tier') ?? 'standard'

  return (
    <p class="greeting" data-tier={tier}>
      Signed in as <strong>{user}</strong> · {tier} tier
    </p>
  )
})
