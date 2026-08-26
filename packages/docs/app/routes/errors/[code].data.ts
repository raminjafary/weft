import { defineRoute } from 'weft'
import { errorByCode } from '../../lib/errors.ts'
import { codeIds, errorBody, errorsOutline } from '../../lib/errors-page.ts'
import { errorsContents } from '../../lib/contents.ts'

/**
 * One page per code, and one route for all of them.
 *
 * `params` is every code the source raises, so the build writes a file per refusal — three hundred
 * odd documents from one sealed template, none of which needs the kernel at serve time. That is the
 * case the L0 tier was built for, and it fell out of declaring the set rather than being asked for.
 */
export default defineRoute({
  head: (params) => ({
    title: `${params.code ?? 'Unknown'} · weft errors`,
    description: errorByCode(params.code ?? '')?.message ?? 'No such code.',
  }),
  layoutValues: (params) => ({
    heading: params.code ?? 'Unknown',
    lede: errorByCode(params.code ?? '')?.message ?? 'This code is not raised anywhere in the framework.',
  }),
  cache: { class: 'public', ttl: '1h' },
  params: { code: codeIds() },
  slots: {
    contents: {
      fragment: 'docs/contents',
      load: (_ctx, params) => ({ groups: errorsContents(params.code) }),
    },
    body: { html: (_ctx, params) => errorBody(params.code ?? '') },
    outline: { html: (_ctx, params) => errorsOutline(params.code) },
  },
})
