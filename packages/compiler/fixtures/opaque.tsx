import { fragment } from '@weftjs/core'

/**
 * The escape hatch, and what it costs. `ctx.raw()` leaves effect tracking, so this fragment
 * is private and has no cache key at all — not a wide key, no key. Local to the fragment
 * rather than viral, which is the whole point of it being an expression and not a mode.
 */
export default fragment((ctx) => {
  const banner = ctx.raw(() => 'whatever the host decided')
  return <aside class="banner">{banner}</aside>
})
