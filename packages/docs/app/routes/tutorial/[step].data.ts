import { defineRoute } from '@weftjs/core'
import { progress, railCard, soFar } from '../../lib/rails.ts'
import { tutorialContents } from '../../lib/contents.ts'
import { shell } from '../../lib/shell.ts'
import { appSoFar, STEP_BY_SLUG, STEPS, stepBody, stepKicker, stepTime } from '../../lib/tutorial.ts'

/** One route for six steps, with the set declared — so each step is a file the build wrote. */
export default defineRoute({
  head: (params) => ({
    title: `${STEP_BY_SLUG[params.step ?? '']?.title ?? 'Not found'} · weft tutorial`,
    description: STEP_BY_SLUG[params.step ?? '']?.lede ?? 'No such step.',
  }),
  layoutValues: (params) =>
    shell({
      // No crumb: the trail it would draw is `Tutorial / Steps / <this page>` — a link to the index
      // the rail already holds, a middle crumb that is not a page, and then the heading again. The
      // position is the kicker's job, and the kicker counts it.
      heading: STEP_BY_SLUG[params.step ?? '']?.title ?? 'Not found',
      lede: STEP_BY_SLUG[params.step ?? '']?.lede ?? 'This step does not exist.',
      kicker: stepKicker(params.step ?? ''),
    }),
  cache: { class: 'public', ttl: '1h' },
  params: { step: STEPS.map((step) => step.slug) },
  slots: {
    contents: {
      fragment: 'docs/contents',
      load: (_ctx, params) => ({ groups: tutorialContents(params.step) }),
    },
    body: { html: (_ctx, params) => stepBody(params.step ?? '') },
    outline: {
      html: (_ctx, params) =>
        progress(
          Math.max(STEPS.findIndex((step) => step.slug === params.step) + 1, 0),
          STEPS.length,
          stepTime(params.step ?? ''),
        ) +
        soFar(appSoFar(params.step ?? '')) +
        railCard(
          'Stuck?',
          `<p>Every refusal in this framework has a name and a sentence.
            <a href="/errors">The error reference</a> lists all of them with the file that raises each one.</p>`,
        ),
    },
  },
})
