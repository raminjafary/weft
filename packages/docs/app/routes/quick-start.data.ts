import { defineRoute } from 'weft'
import { renderExample } from '../lib/example.ts'
import { example, heading, note, prose, sketch, table } from '../lib/markup.ts'

/**
 * Quick Start: the shortest path from nothing to a page that streams.
 *
 * Deliberately not the first page of the guide. Somebody arriving here wants to know whether this is
 * worth an afternoon, and the answer to that is a command and a working page — not the reason the
 * design is shaped the way it is, which is what the guide is for.
 */
export default defineRoute({
  head: { title: 'Quick Start · weft', description: 'One command, three files, and a page that streams.' },
  layoutValues: {
    heading: 'Quick Start',
    lede: 'One command, three files, and a page whose first byte does not wait for its slowest query.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    body: {
      html: () =>
        prose(
          'A weft application is a folder. There is no configuration you must have, no wiring file, and no ' +
            'bundler — the route table is the file tree, and the plan that places everything on a page is ' +
            'generated from it.',
        ) +
        heading('Create one', 'create') +
        sketch(
          'sh',
          `npm create weft my-app
cd my-app
npm run dev`,
        ) +
        prose('That is a running application at <code>localhost:3000</code>. Three files matter:') +
        table(
          ['File', 'What it is'],
          [
            [
              '<code>app/layout.tsx</code>',
              'The document. Its <code>&lt;slot&gt;</code> holes are what a route fills.',
            ],
            ['<code>app/routes/index.tsx</code>', 'The page at <code>/</code>.'],
            [
              '<code>app/routes/index.data.ts</code>',
              'What that route declares — head, cache policy, loader, slots. Optional.',
            ],
          ],
        ) +
        heading('A fragment', 'fragment') +
        prose(
          'Everything this framework renders is a fragment, and a fragment compiles to a sealed template: ' +
            'pre-encoded bytes with holes, and a version that is a hash of its own content.',
        ) +
        example(
          renderExample({
            id: 'examples/card',
            title: 'A page, and a component inside it',
            shows:
              'Two fragments and two sealed templates. The tag is resolved at build time — nothing is mounted.',
            values: { title: 'Olive oil, 2L', label: 'new' },
          }),
        ) +
        heading('Make one region slow', 'slow') +
        prose(
          'The interesting behaviour costs one declaration. Say a region streams, and the document stops ' +
            'being downstream of it:',
        ) +
        sketch(
          'ts',
          `// app/routes/index.data.ts
import { defineRoute } from 'weft'

export default defineRoute({
  head: { title: 'Home' },
  slots: {
    body: { fragment: 'today', load: async () => ({ items: await db.today() }) },
    aside: {
      fragment: 'recs',
      stream: { prio: 1 },
      placeholder: '<p class="skeleton"></p>',
      load: async () => ({ items: await slowRecommendations() }),
    },
  },
})`,
        ) +
        prose(
          'The header, the nav and everything before that slot are on the wire while the slow query is still ' +
            'running. Nothing about the page had to be restructured to get that — a fragment that reads ' +
            'something slow is a hole by construction.',
        ) +
        heading('Four commands worth knowing', 'commands') +
        sketch(
          'sh',
          `weft routes     # the route table, and each route's slots
weft why /      # the generated plan for one route
weft build      # sealed templates, the plan, revved assets — and which pages became files
weft start      # serve the build. No compiler runs`,
        ) +
        note(
          'why',
          'Read the build report',
          'It prints which pages were resolved at build time and served without the kernel at all, and for ' +
            'every page that was not, the read that refused it. That list is the performance review of your ' +
            'application, and you get it without asking.',
        ) +
        `<nav class="sequence"><a class="next" href="/guide">The Guide, in order →</a></nav>`,
    },
  },
})
