import { defineRoute } from 'weft'
import { feedItems, at } from '../../../src/data.ts'
import { compileDemo, listBinding } from '../../../src/compile.ts'
import { field, panel, pick, press, slider } from '../../../src/pages.ts'
import { LOG } from '../../../src/showcase.ts'

/**
 * A content-heavy feed, authored the way the design says an application is authored — except that
 * the plan is now generated from this file rather than written beside it.
 *
 * There is no `.tsx` here. The body is `app/fragments/feed.tsx`, which the stations also read, so
 * the fragment has one home and the route names it.
 */
const PANEL =
  panel(
    [
      field('rows', slider('feed-rows', 20, 400, 120, 20)),
      field('binding', pick('feed-binding', ['stream', 'sse', 'socket'])),
      press('feed-tick', 'tick once'),
    ].join(''),
    'Every tick invalidates one key on the server. Each open connection is told, asks for a delta, and the first to ask pays for it.',
  ) + `<div class="card">${LOG}</div>`

export default defineRoute({
  head: { title: 'A content-heavy feed · weft demo' },
  layoutValues: {
    heading: 'A content-heavy feed',
    shows:
      'Hundreds of rows, one sealed row template, nothing that reads identity — so the whole region is one shared cache entry.',
    control: 'Change the row count, open a channel, and tick it. One row in eight moves.',
    status: 'live',
  },
  slots: {
    panel: { fragment: 'markup', stream: false, html: PANEL },
    // Reads the clock, so a policy with no ttl is a build error. That is the compiler
    // contradicting the declaration, and the declaration losing.
    body: {
      fragment: 'feed',
      stream: { prio: 1 },
      cache: { class: 'public', ttl: '30s', swr: '5m', tags: ['feed'] },
      form: { prefer: 'delta', fallback: 'html' },
      incremental: true,
      live: true,
      placeholder: '<p class="skeleton"></p>',
      load: async (ctx) => {
        const compiled = await compileDemo()
        const rows = Number(ctx.query('rows') ?? 120)
        return {
          heading: 'Markets',
          count: rows,
          generated: ctx.now(),
          [listBinding(compiled.feed)]: feedItems(rows, at()),
        }
      },
    },
    readout: {
      fragment: 'markup',
      stream: false,
      html: '<div class="card" id="feed-readout"><h3>Readout</h3><p class="hint">Open the channel to fill this.</p></div>',
    },
  },
})
