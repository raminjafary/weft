import { defineRoute } from '@weft/core'
import { shell } from '../../lib/shell.ts'
import { startContents } from '../../lib/contents.ts'
import { IS_A_FILE, onThisPage } from '../../lib/rails.ts'
import { renderExample } from '../../lib/example.ts'
import { example, heading, note, prose, table } from '../../lib/markup.ts'
import { streamRace, terminal, tree } from '../../lib/figures.ts'

/**
 * Quick Start: the shortest path from nothing to a page that streams.
 *
 * Deliberately not the first page of the guide. Somebody arriving here wants to know whether this is
 * worth an afternoon, and the answer to that is a command and a working page — not the reason the
 * design is shaped the way it is, which is what the guide is for.
 *
 * Four sections, and the fourth is the one that makes the page worth its length: create it, see the
 * three files, make one region stop blocking the rest, and read what the build says about it.
 */
const SECTIONS = [
  { label: 'Create it', href: '#create', current: true },
  { label: 'Three files', href: '#files' },
  { label: 'Make it stream', href: '#stream' },
  { label: 'Build it', href: '#build' },
]

export default defineRoute({
  head: { title: 'Quick Start · weft', description: 'One command, three files, and a page that streams.' },
  layoutValues: shell({
    heading: 'Quick Start',
    kicker: 'Ten minutes',
    kickerNote: 'one command, three files, and a page that streams',
    lede: 'One command, three files, and a page whose slow half does not hold up its fast half. Nothing here is scaffolding you delete later.',
  }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: startContents('/quick-start') }) },
    outline: { html: () => onThisPage(SECTIONS) + IS_A_FILE },
    body: {
      html: () =>
        heading('Create it', 'create') +
        prose(
          'A folder is an application. There is no config file you must have — <code>weft.config.ts</code> ' +
            'exists to bind ports, and a first application binds none.',
        ) +
        terminal(
          'install',
          [
            {
              label: 'pnpm',
              lines: [
                '$ pnpm create weft my-app',
                '$ cd my-app && weft dev',
                '',
                '  weft dev  → http://localhost:4173',
                '  3 routes · 4 sealed templates · no bundler',
              ],
            },
            {
              label: 'npm',
              lines: [
                '$ npm create weft my-app',
                '$ cd my-app && npx weft dev',
                '',
                '  weft dev  → http://localhost:4173',
                '  3 routes · 4 sealed templates · no bundler',
              ],
            },
            {
              label: 'bun',
              lines: [
                '$ bun create weft my-app',
                '$ cd my-app && bunx weft dev',
                '',
                '  weft dev  → http://localhost:4173',
                '  3 routes · 4 sealed templates · no bundler',
              ],
            },
          ],
          'No bundler ran. Client modules are TypeScript with their types stripped and two bare specifiers rewritten, so what runs in the browser is the file on disk.',
        ) +
        heading('Three files', 'files') +
        prose(
          'The route table is the file tree. A <code>.tsx</code> beside a <code>.data.ts</code> is a page ' +
            'and its declaration: head, cache policy, loader, guard and slots.',
        ) +
        tree(
          [
            'app/',
            'app/layout.tsx',
            'app/routes/',
            'app/routes/index.tsx',
            'app/routes/index.data.ts',
            'app/fragments/',
            'app/fragments/feed.tsx',
          ],
          ['app/routes/index.tsx', 'app/routes/index.data.ts'],
          'tsx',
          `// app/routes/index.tsx
import { fragment } from '@weft/core'

export default fragment(({ user }: { user: User }) => (
  <main>
    <h1>Hello, {user.name}</h1>
    <slot name="feed" />
  </main>
))`,
        ) +
        note(
          'why',
          'You did not write a cache key',
          'Reading <code>user</code> tainted this fragment <code>identity</code>, so its class is private. ' +
            'There is no setter in the kernel, the plan DSL or the plugin surface — that absence is the ' +
            'enforcement.',
        ) +
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
        prose(
          'Everything this framework renders is a fragment, and a fragment compiles to a sealed template: ' +
            'pre-encoded bytes with holes, and a version that is a hash of its own content. Here is one that ' +
            'this page compiled, rendering:',
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
        heading('Make it stream', 'stream') +
        prose(
          'A slot is a hole the shell refuses to wait for. Declare the slow one and the first byte stops ' +
            'depending on it — 329 bytes of inline script buys fastest-first delivery in Chromium, Firefox ' +
            'and WebKit alike.',
        ) +
        streamRace() +
        prose(
          'The header, the nav and everything before that slot are on the wire while the slow query is ' +
            'still running. Nothing about the page had to be restructured to get that — a fragment that ' +
            'reads something slow is a hole by construction.',
        ) +
        heading('Build it', 'build') +
        table(
          ['Command', 'What it does'],
          [
            [
              '<code>weft build</code>',
              'Sealed templates, the generated plan, the manifest, revved assets. Prints which pages became files, and the reason for every page that did not.',
            ],
            [
              '<code>weft start</code>',
              'Serve the build. No compiler runs, and static paths are answered before the kernel is reached.',
            ],
            ['<code>weft why /</code>', 'The plan the framework generated for a route, chain included.'],
            [
              '<code>weft verify --probe</code>',
              'Ask every region what it is serving, and exit non-zero on disagreement.',
            ],
          ],
        ) +
        note(
          'why',
          'Read the build report',
          'It prints which pages were resolved at build time and served without the kernel at all, and for ' +
            'every page that was not, the read that refused it. That list is the performance review of your ' +
            'application, and you get it without asking.',
        ) +
        `<nav class="pager">
          <a class="prev" href="/">← Home</a>
          <a class="next" href="/guide/an-application">Guide: an application is a folder →</a>
        </nav>`,
    },
  },
})
