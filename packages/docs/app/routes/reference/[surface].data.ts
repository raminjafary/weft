import { defineRoute } from '@weftjs/core'
import { GENERATED, shell } from '../../lib/shell.ts'
import { referenceContents } from '../../lib/contents.ts'
import { referenceBody, referenceOutline, referenceProv } from '../../lib/reference-page.ts'
import { BY_ID, referenceIds } from '../../lib/reference.ts'

/**
 * One route for the whole reference.
 *
 * `params` is the six page ids, so the build writes a file per reference from one sealed template —
 * and every one of them is a page whose content is a pure function of this repository's source,
 * which is exactly the shape the L0 tier exists for.
 */
export default defineRoute({
  head: (params) => ({
    title: `${BY_ID[params.surface ?? '']?.title ?? 'Not found'} · weft reference`,
    description: BY_ID[params.surface ?? '']?.blurb ?? 'No such reference.',
  }),
  layoutValues: (params) =>
    shell({
      ...GENERATED,
      kickerNote: 'read out of the source that implements it',
      heading: BY_ID[params.surface ?? '']?.title ?? 'Not found',
      lede: BY_ID[params.surface ?? '']?.blurb ?? 'This reference does not exist.',
      section: BY_ID[params.surface ?? '']?.label ?? '',
    }),
  cache: { class: 'public', ttl: '1h' },
  params: { surface: referenceIds() },
  slots: {
    contents: {
      fragment: 'docs/contents',
      load: (_ctx, params) => ({ groups: referenceContents(params.surface) }),
    },
    body: {
      fragment: 'docs/page',
      load: (_ctx, params) => ({ blocks: referenceBody(params.surface ?? '') }),
    },
    outline: { html: (_ctx, params) => referenceOutline(params.surface) },
    prov: { fragment: 'docs/prov', load: (_ctx, params) => referenceProv(params.surface) },
  },
})
