import { defineRoute } from '@weftjs/core'
import { shell } from '../lib/shell.ts'
import { compilePlayground, playBody, STARTER, type Outcome } from '../lib/play.ts'

/**
 * The playground, as a GET. A form with `method="get"` and no JavaScript: the source is a query
 * parameter, so a compiled result has a shareable URL and works with the runtime off. The one page
 * on this site that needs the compiler's virtual file set — source with no directory behind it.
 */
export default defineRoute({
  head: { title: 'Playground · weft', description: 'Type a fragment and see what it compiles to.' },
  layoutValues: shell({
    heading: 'Playground',
    lede:
      'Type a fragment and see what it compiles to. Nothing is written anywhere — the compiler runs ' +
      'over a virtual file set, which is why this page is one of the two on this site that is not a file.',
  }),
  // See `spec/kernel/static.md`: notStaticBecause.
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
