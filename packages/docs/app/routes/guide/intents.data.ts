import { defineRoute } from '@weftjs/core'
import { shell } from '../../lib/shell.ts'
import { bodyOf, guideOutline } from '../../lib/content.ts'
import { guideContents } from '../../lib/contents.ts'
import { BY_SLUG, groupOf } from '../../lib/pages.ts'

/**
 * The one guide page that is not a file, and the only page that has a reason not to be.
 *
 * Every other guide page is `[page].data.ts`: one route, one plan, twenty-odd slugs, each written
 * out by `weft build` and served from the edge without the kernel being invoked. This page is
 * separated from that set for a single reason — its example is a real intent, and a real intent
 * that changes nothing anybody can see is a poor demonstration of the one thing the page is about.
 *
 * A file cannot show a number that moves. The count was rendered at build time and stayed there, so
 * pressing the button incremented a tally in memory and left a `0` on the screen. Making the body a
 * live region is the framework's answer: `L0_LIVE` is the build refusing to call a region that
 * refreshes over the channel a file, which is correct, and it is a refusal worth accepting **here**
 * and nowhere else in the guide.
 *
 * Its own route rather than a flag on the shared one, because slots are declared per route: making
 * `[page]` live would have taken all twenty-two pages out of L0 to animate a counter on one of them.
 * The document is still cached — `documents.shared` puts it on the CDN for a year — so what this
 * actually costs is one render per deploy, and what it buys is the page about writes being able to
 * show one.
 *
 * A static segment wins over a parameter, so this file answers `/guide/intents` and `[page]` keeps
 * the rest without knowing this exists.
 */
const SLUG = 'intents'

export default defineRoute({
  head: () => ({
    title: `${BY_SLUG[SLUG]?.title ?? 'Intents'} · weft`,
    description: BY_SLUG[SLUG]?.lede ?? '',
  }),
  layoutValues: () =>
    shell({
      heading: BY_SLUG[SLUG]?.title ?? 'Intents',
      lede: BY_SLUG[SLUG]?.lede ?? '',
      section: groupOf(SLUG),
    }),
  /**
   * Tagged at the route as well as at the slot, and the difference is why the count did not move.
   *
   * The slot's entry carries `docs.votes` and is dropped correctly. The *document* is a second
   * cached thing — a whole response, held for an hour, tagged with nothing — so an invalidation
   * emptied the slot cache and the reader was still handed the stored page, whose body had been
   * rendered once and never again. Two caches, one of them reachable by the write.
   */
  cache: { class: 'public', ttl: '1h', tags: ['docs.votes'] },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: guideContents(SLUG) }) },
    body: {
      /**
       * Tagged with what `docs.helpful` declares it writes, which is the whole mechanism.
       *
       * The intent names `docs.votes` in `writes`, calls `ctx.revalidate('docs.votes')`, and this
       * entry is dropped. Every client holding the region is told it is stale and asks; the answer
       * is this body rendered again, with the tally as it now is.
       */
      cache: { class: 'public', ttl: '1h', tags: ['docs.votes'] },
      live: true,
      // Not `delta`: this body is markup rather than a sealed template, so there are no projectable
      // values to diff and the build says so by name. `patch` is the rung below — addressed the way
      // adoption addresses the DOM — and `html` is the floor under that.
      form: { prefer: 'patch', fallback: 'html' },
      html: () => bodyOf(SLUG),
    },
    outline: { html: () => guideOutline(SLUG) },
  },
})
