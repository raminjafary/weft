import { defineRoute } from 'weft'
import { prose } from '../../lib/markup.ts'
import { STEPS, stepContents } from '../../lib/tutorial.ts'

export default defineRoute({
  head: { title: 'Tutorial · weft', description: 'Build one page from nothing, one step at a time.' },
  layoutValues: {
    heading: 'Tutorial',
    lede: 'Build one real page from nothing, and watch what each step costs.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { html: () => stepContents() },
    body: {
      html: () =>
        prose(
          'The guide explains a mechanism. This shows you what one costs by having you add it: every step ' +
            'says what changed, what the framework then knew, and which command shows it.',
          'You need Node 22 or later and nothing else. There is no scaffolding step you cannot read.',
        ) +
        `<div class="cards">${STEPS.map(
          (step) => `<div class="card">
            <h3><a href="/tutorial/${step.slug}">${step.title}</a></h3>
            <p>${step.lede}</p>
          </div>`,
        ).join('')}</div>`,
    },
    outline: {
      html: `<h2 class="hint">The habit worth learning</h2>
        <p class="hint">After every step, run <code>weft why &lt;route&gt;</code>. The plan is generated from
        what you wrote, and reading it is how you find out that a declaration you did not make was decided
        for you — and which read decided it.</p>`,
    },
  },
})
