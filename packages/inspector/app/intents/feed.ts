import { defineIntent } from '@weftjs/core'
import { advance } from '../lib/data.ts'

/** One tick of the feed. `writes: ['feed']` is the whole mechanism — see `spec/kernel/transport.md`. */
export const tick = defineIntent({
  name: 'inspect.feed.tick',
  writes: ['feed'],
  async run(ctx) {
    const at = advance()
    await ctx.revalidate('feed')
    return { refresh: ['body'], data: { tick: at } }
  },
})
