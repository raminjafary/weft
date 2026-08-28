import { defineRoute } from '@weftjs/core'
import { tutorialContents } from '../../lib/contents.ts'
import { shell } from '../../lib/shell.ts'
import { tutorialIndexBody } from '../../lib/tutorial.ts'

export default defineRoute({
  head: {
    title: 'Tutorial · weft',
    description: 'One application, and every mechanism it can be asked to use.',
  },
  layoutValues: shell({
    kicker: 'Tutorial',
    heading: 'One application, and every mechanism it can be asked to use',
    lede:
      'The guide explains a mechanism. This has you add one and shows what it cost. Six steps build a ' +
      'single shop from an empty folder to a deployment: every step says what changed, what the ' +
      'framework then knew, and which command shows it.',
  }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: tutorialContents() }) },
    body: { html: () => tutorialIndexBody() },
    outline: {
      html: `<h2 class="eyebrow">The habit worth learning</h2>
        <p class="hint">After every step, run <code>weft why &lt;route&gt;</code>. The plan is generated from
        what you wrote, and reading it is how you find out that a declaration you did not make was decided
        for you — and which read decided it.</p>`,
    },
  },
})
