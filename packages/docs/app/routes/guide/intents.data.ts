import { defineRoute } from '@weftjs/core'
import { shell } from '../../lib/shell.ts'
import { bodyOf, guideOutline } from '../../lib/content.ts'
import { guideContents } from '../../lib/contents.ts'
import { BY_SLUG, groupOf } from '../../lib/pages.ts'

/**
 * The one guide page that is not a file: its example is a real intent, and a live count needs a
 * live region (`L0_LIVE`), which would have taken all twenty-two other guide pages out of L0 for
 * one counter. Its own route rather than a flag on the shared one, since slots are declared per
 * route. See `spec/kernel/static.md` (`L0_LIVE`) and `spec/plan/plan.md` (the bug a static cache
 * on this exact page once had).
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
  // Tagged at the route as well as at the slot — see `spec/plan/plan.md`: W_DOCUMENT_OUTLIVES_INVALIDATION.
  cache: { class: 'public', ttl: '1h', tags: ['docs.votes'] },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: guideContents(SLUG) }) },
    body: {
      // Tagged with what the intent declares in `writes`; revalidating it drops this entry.
      cache: { class: 'public', ttl: '1h', tags: ['docs.votes'] },
      live: true,
      // Not `delta`: markup rather than a sealed template, so no projectable values to diff. See `spec/ir/template-ir-2.md`.
      form: { prefer: 'patch', fallback: 'html' },
      html: () => bodyOf(SLUG),
    },
    outline: { html: () => guideOutline(SLUG) },
  },
})
