import { defineRoute } from '@weftjs/core'
import { shell } from '../../lib/shell.ts'
import { STEPS, tutorialIndexBody } from '../../lib/tutorial.ts'

export default defineRoute({
  head: {
    title: 'Tutorial · weft',
    description: 'One application, and every mechanism it can be asked to use.',
  },
  layoutValues: () =>
    shell({
      // No rail: the page below is the whole tutorial, and a column repeating it beside it is the
      // contents of the thing the reader is already looking at.
      shellClass: 'shell one',
      kicker: 'Tutorial',
      heading: 'One application, and every mechanism it can be asked to use',
      // Counted, like every other number on this page. It said "Six steps" for exactly as long as
      // it took to add the seventh.
      lede:
        `The guide explains a mechanism. This has you add one and shows what it cost. ${STEPS.length} ` +
        'steps build a single shop from an empty folder to a deployment: every step says what changed, ' +
        'what the framework then knew, and which command shows it.',
    }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: [] }) },
    body: { html: () => tutorialIndexBody() },
    // Both columns are empty on this page, and the shell it names draws neither. A hole still has
    // to be filled — an unfilled one is `E_SHELL_HOLE_UNFILLED`, and rightly.
    outline: { html: '' },
  },
})
