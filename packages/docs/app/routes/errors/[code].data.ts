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
      kickerNote: 'extracted from the source that raises it',
      heading: params.code ?? 'Unknown',
      lede: lede(params.code ?? ''),
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

/**
 * What the page says before the refusal itself.
 *
 * Not the message: the message is the panel's, and printing it twice made the top of every one of
 * these pages a sentence and then the same sentence in a quotation box. This says which of the
 * three states the code is in, which is the thing the panel below is about to demonstrate.
 */
function lede(code: string): string {
  const entry = errorByCode(code)
  if (!entry) return 'This code is not raised anywhere in the framework.'
  const places = entry.sites.length === 1 ? 'one place' : `${entry.sites.length} places`
  if (entry.detail === 'prose') {
    return `A named refusal, raised in ${places} in ${entry.package}. What it refused, the sentence it prints, and the argument for it.`
  }
  if (entry.detail === 'wrapped') {
    return `A refusal that forwards the failure underneath it, raised in ${places} in ${entry.package}. What it says at runtime is the cause's sentence rather than one written in the source.`
  }
  return `A refusal raised in ${places} in ${entry.package} with nothing but its own name.`
}
