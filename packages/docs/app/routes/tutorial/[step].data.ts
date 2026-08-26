import { defineRoute } from 'weft'
import { STEP_BY_SLUG, STEPS, stepBody, stepContents } from '../../lib/tutorial.ts'

/** One route for six steps, with the set declared — so each step is a file the build wrote. */
export default defineRoute({
  head: (params) => ({
    title: `${STEP_BY_SLUG[params.step ?? '']?.title ?? 'Not found'} · weft tutorial`,
    description: STEP_BY_SLUG[params.step ?? '']?.lede ?? 'No such step.',
  }),
  layoutValues: (params) => ({
    heading: STEP_BY_SLUG[params.step ?? '']?.title ?? 'Not found',
    lede: STEP_BY_SLUG[params.step ?? '']?.lede ?? 'This step does not exist.',
  }),
  cache: { class: 'public', ttl: '1h' },
  params: { step: STEPS.map((step) => step.slug) },
  slots: {
    contents: { html: (_ctx, params) => stepContents(params.step) },
    body: { html: (_ctx, params) => stepBody(params.step ?? '') },
    outline: {
      html: `<h2 class="hint">Stuck?</h2>
        <p class="hint">Every refusal in this framework has a name and a sentence.
        <a href="/errors">The error reference</a> lists all of them with the file that raises each one.</p>`,
    },
  },
})
