import { defineRoute } from '@weftjs/core'
import { GENERATED, shell } from '../../lib/shell.ts'
import { errorByCode } from '../../lib/errors.ts'
import { codeIds, errorBody } from '../../lib/errors-page.ts'
import { errorsOutline } from '../../lib/outlines.ts'
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
  layoutValues: (params) =>
    shell({
      ...GENERATED,
      kickerNote: errorByCode(params.code ?? '')?.package ?? 'unknown package',
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
    body: { fragment: 'docs/page', load: (_ctx, params) => ({ blocks: errorBody(params.code ?? '') }) },
    outline: { fragment: 'docs/prov', load: (_ctx, params) => errorsOutline(params.code) },
  },
})
