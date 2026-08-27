import { defineRoute } from '@weftjs/core'
import { read } from '../intents/counter.ts'

export default defineRoute({
  head: { title: 'Counter', description: 'An intent, over a channel and over a form post.' },
  // Tagged `counter`, which is the tag the intent declares it writes. That single agreement is
  // what makes push invalidation work: nothing here registers a listener.
  cache: { class: 'public', ttl: '1m', tags: ['counter'] },
  stream: true,
  // Refreshable over the channel. The framework registers this slot with the hub and re-runs the
  // loader below when a delta is asked for, so the delta describes the same render the page did.
  live: true,
  load: () => {
    const count = read()
    return { count, parity: count % 2 === 0 ? 'even' : 'odd' }
  },
})
