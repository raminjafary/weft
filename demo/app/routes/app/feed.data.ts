import { defineRoute } from '@weftjs/core'
import { feedItems, at } from '../../lib/data.ts'
import { field, panel, press, slider } from '../../lib/controls.ts'
import { LOG } from '../../lib/showcase.ts'
import { fragmentIR, listHole } from '@weftjs/core'

/**
 * A content-heavy feed, authored the way the design says an application is authored — except that
 * the plan is now generated from this file rather than written beside it.
 *
 * There is no `.tsx` here. The body is `app/fragments/feed.tsx`, which the stations also read, so
 * the fragment has one home and the route names it.
 */
/** A function of the request, so the slider renders at the value that is actually in the URL. */
const PANEL = (ctx: { query(key: string): string | undefined }): string =>
  panel(
    [
      field('rows', slider('feed-rows', 20, 400, Number(ctx.query('rows') ?? 120), 20)),
      press('feed-go', 'render with these'),
      `<button type="button" id="feed-tick" data-weft-intent="feed.tick">tick once</button>`,
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
    panel: { fragment: 'markup', stream: false, html: (ctx) => PANEL(ctx) },
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
      /**
       * The rows, fetched through the data port rather than called directly.
       *
       * There is no database here — `feedItems` is a generator — and that is the point of showing
       * it on the page that has none: what the port adds is a *name* for the access, a deadline
       * somebody chose, and the tags this render depended on recorded where an invalidation can
       * be checked against them. All three are missing from a plain function call, and all three
       * are what you want at 3am. `feed` is the same tag `feed.tick` declares it writes.
       */
      load: async (ctx) => {
        const rows = Number(ctx.query('rows') ?? 120)
        const items = await ctx.data({ name: 'feed.rows', tags: ['feed'], timeoutMs: 250 }, async () =>
          feedItems(rows, at()),
        )
        return {
          heading: 'Markets',
          count: rows,
          generated: ctx.now(),
          [listHole(fragmentIR('fragment:feed'))]: items,
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
