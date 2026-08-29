import { defineRoute } from '@weftjs/core'
import { GENERATED, shell } from '../../lib/shell.ts'
import { errorByCode } from '../../lib/errors.ts'
import { codeIds, errorBody } from '../../lib/errors-page.ts'
import { errorsOutline } from '../../lib/outlines.ts'
import { errorsContents } from '../../lib/contents.ts'

/** One page per code, and one route for all of them: `params` names every code, so `weft build` writes each as a file (L0). See `spec/kernel/static.md`. */
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

/** What the page says before the refusal itself — which of the three states the code is in, not the message (that's the panel's). */
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
