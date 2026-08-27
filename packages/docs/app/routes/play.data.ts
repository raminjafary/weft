import { defineRoute } from '@weft/core'
import { shell } from '../lib/shell.ts'
import { compilePlayground, playBody, STARTER, type Outcome } from '../lib/play.ts'

/**
 * The playground, as a GET.
 *
 * A form with `method="get"` and no JavaScript at all: the source is a query parameter, so a
 * compiled result has a URL somebody can share and the page works with the runtime switched off.
 * Reading the parameter taints `route:src`, which means each submission is its own cache entry —
 * content-addressed by construction, which is the right behaviour for a pure compile.
 *
 * It is the one page on this site that needs the compiler's virtual file set. Everything in the
 * guide is a real file; source that arrives with a request has no directory behind it.
 */
export default defineRoute({
  head: { title: 'Playground · weft', description: 'Type a fragment and see what it compiles to.' },
  layoutValues: shell({
    heading: 'Playground',
    lede:
      'Type a fragment and see what it compiles to. Nothing is written anywhere — the compiler runs ' +
      'over a virtual file set, which is why this page is one of the two on this site that is not a file.',
  }),
  // The build's two probes cannot invent the key this page reads, so they would prove it invariant
  // and freeze it into a file that ignores `?src` — which is the whole page. Declared, with the
  // reason, rather than discovered by somebody wondering why the playground stopped compiling.
  static: false,
  notStaticBecause:
    'its body compiles whatever `?src` carries, and neither build probe invents that key — so the page would render identically twice and be frozen ignoring the parameter it exists to read',
  slots: {
    body: {
      html: async (ctx) => {
        const submitted = ctx.query('src')
        const source = submitted ?? STARTER
        const outcome: Outcome | null = submitted ? await compilePlayground(submitted) : null
        return playBody(source, outcome)
      },
    },
  },
})
