import { fragment, type Ctx } from '@weftjs/core'

/**
 * One identity read, and the region can never be a shared cache entry.
 *
 * Because it is a *slot* rather than part of the document, the document stays shared and only this
 * region is per-user. That containment is the whole reason a page with a signed-in corner is not a
 * page that has to be private.
 */
export default fragment(async (ctx: Ctx) => {
  const user = await ctx.user()
  return <p class="private">Signed in as {user}</p>
})
