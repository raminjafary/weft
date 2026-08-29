import { defineRoute } from '@weftjs/core'
import { shell } from '../../lib/shell.ts'
import { bodyOf, guideOutline } from '../../lib/content.ts'
import { guideContents } from '../../lib/contents.ts'
import { BY_SLUG, groupOf, PAGES } from '../../lib/pages.ts'

/**
 * Every guide page: one route, one plan, one sealed template. Declaring `params` lets `weft build`
 * write each page out as a file, served without the kernel being invoked at all.
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
  // Every guide slug except `intents`, which has its own live route — see `spec/plan/plan.md`.
  // A file would be served before routing and shadow the live page.
  params: { page: PAGES.map((page) => page.slug).filter((slug) => slug !== 'intents') },
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
