import { defineRoute } from 'weft'
import { shell } from '../../lib/shell.ts'
import { bodyOf, guideOutline } from '../../lib/content.ts'
import { guideContents } from '../../lib/contents.ts'
import { BY_SLUG, groupOf, PAGES } from '../../lib/pages.ts'

/**
 * Every guide page: one route, one plan, one sealed template.
 *
 * A file per page would be twelve files that each say the same thing, and the page's identity is its
 * slug rather than its path on disk. Declaring `params` is what matters here: the set of pages is
 * something this application knows, so the build writes each one as a file and serves it without the
 * kernel being invoked at all.
 *
 * Four slots reach the plan — `contents`, `body` and `outline` from `guide/layout.tsx`, and nothing
 * from `app/layout.tsx` except the `body` hole this chain fills. Nothing below says which layer left
 * which hole.
 */
const titleOf = (slug: string): string => BY_SLUG[slug]?.title ?? 'Not found'

export default defineRoute({
  head: (params) => ({
    title: `${titleOf(params.page ?? '')} · weft`,
    description: BY_SLUG[params.page ?? '']?.lede ?? 'No such page.',
  }),
  layoutValues: (params) =>
    shell({
      heading: titleOf(params.page ?? ''),
      lede: BY_SLUG[params.page ?? '']?.lede ?? 'This page does not exist.',
      section: groupOf(params.page ?? ''),
    }),
  cache: { class: 'public', ttl: '1h' },
  params: { page: PAGES.map((page) => page.slug) },
  slots: {
    contents: { fragment: 'docs/contents', load: (_ctx, params) => ({ groups: guideContents(params.page) }) },
    body: {
      html: (_ctx, params) => {
        const slug = params.page ?? ''
        if (!BY_SLUG[slug]) {
          return `<div class="card"><h3>No such page</h3><p><a href="/guide">Back to the guide</a>.</p></div>`
        }
        return bodyOf(slug)
      },
    },
    outline: { html: (_ctx, params) => guideOutline(params.page ?? '') },
  },
})
