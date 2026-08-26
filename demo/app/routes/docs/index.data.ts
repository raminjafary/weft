import { defineRoute } from 'weft'
import { toc, TOPICS } from '../../lib/docs.ts'

/**
 * The subtree's index. Its plan has four slots and names one document.
 *
 * `panel` and `readout` are holes in `app/layout.tsx`; `toc` and `body` are holes in
 * `app/routes/docs/layout.tsx`. Nothing here says which is which, because nothing here has to: the
 * chain came from the directory this file is in.
 */
export default defineRoute({
  head: {
    title: 'Nested layouts · weft demo',
    description: 'A layout scoped to a subtree of the route table.',
  },
  layoutValues: {
    heading: 'A subtree with a layout of its own',
    shows:
      'Two routes share a layout that only exists under /docs. The document is a chain, and the plan cannot tell.',
    control: 'Open a topic. The chrome, the contents column and the stylesheet are the subtree’s.',
    status: 'live',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    panel: { fragment: 'markup', stream: false, html: '' },
    toc: { fragment: 'markup', stream: false, html: () => toc() },
    body: {
      fragment: 'markup',
      stream: false,
      html: () =>
        `<h2>Three things worth knowing</h2>${TOPICS.map(
          (entry) =>
            `<div class="card"><h3><a href="/docs/${entry.slug}">${entry.title}</a></h3><p>${entry.summary}</p></div>`,
        ).join('')}`,
    },
    readout: {
      fragment: 'markup',
      stream: false,
      html: `<div class="card"><h3>Where the chain is</h3>
        <p>The document for this page is <code>app/layout.tsx</code> &rsaquo;
        <code>app/routes/docs/layout.tsx</code> &rsaquo; this declaration. Run
        <code>weft why /docs</code> and the four slots are listed without any of them saying which
        layer left the hole.</p></div>`,
    },
  },
})
