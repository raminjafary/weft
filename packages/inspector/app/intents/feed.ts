import { defineIntent } from 'weft'
import { advance } from '../lib/data.ts'

/**
 * One tick of the feed.
 *
 * It writes `feed`, and that declaration is the whole mechanism: the store drops the keys tagged
 * with it, every connection holding one is told, and each of them asks for a delta. The first to
 * ask pays for it and the rest are handed the memoized one. Nothing here knows how many
 * connections there are.
 */
export const tick = defineIntent({
  name: 'inspect.feed.tick',
  writes: ['feed'],
  async run(ctx) {
    const at = advance()
    await ctx.revalidate('feed')
    return { refresh: ['body'], data: { tick: at } }
  },
})
