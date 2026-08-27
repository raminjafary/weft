import { defineRoute } from '@weftjs/core'
import { toc, topic, TOPICS } from '../../lib/docs.ts'

/**
 * One route, one plan, one sealed template, three topics — and the same nested layout as the index.
 *
 * The topic is a route param, so it becomes a key component without this file mentioning keys. What
 * is worth watching is that the enclosing layout is not re-declared anywhere: it applies because the
 * file is in that directory, which is the same rule that gave the file its URL.
 */
const heading = (slug: string): string => topic(slug)?.title ?? 'No such topic'

export default defineRoute({
  head: (params) => ({
    title: `${heading(params.topic ?? '')} · weft demo`,
    description: topic(params.topic ?? '')?.summary ?? 'Nothing here.',
  }),
  layoutValues: (params) => ({
    heading: heading(params.topic ?? ''),
    shows: topic(params.topic ?? '')?.summary ?? 'The route matched and the topic did not exist.',
    control: 'Every page under /docs shares one layout, one contents column and one stylesheet.',
    status: topic(params.topic ?? '') ? 'live' : 'missing',
  }),
  cache: { class: 'public', ttl: '1h' },
  params: { topic: TOPICS.map((entry) => entry.slug) },
  slots: {
    panel: { fragment: 'markup', stream: false, html: '' },
    toc: { fragment: 'markup', stream: false, html: (_ctx, params) => toc(params.topic) },
    body: {
      fragment: 'markup',
      stream: false,
      html: (_ctx, params) => {
        const found = topic(params.topic ?? '')
        if (!found) return '<p>No such topic. The contents beside this list the ones there are.</p>'
        return `<h2>${found.title}</h2>${found.paragraphs.map((line) => `<p>${line}</p>`).join('')}`
      },
    },
    readout: {
      fragment: 'markup',
      stream: false,
      html: `<div class="card"><h3>One route</h3>
        <p>Three topics, one pattern, one plan. The layout above came from the directory, and the
        stylesheet beside it is linked by these pages and by no others.</p></div>`,
    },
  },
})
