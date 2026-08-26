import { defineRoute } from 'weft'
import { SECTIONS } from '../lib/sections.ts'
import { exampleCount } from '../lib/content.ts'
import { errorCodes } from '../lib/errors.ts'
import { surface } from '../lib/surface.ts'
import { PAGES } from '../lib/pages.ts'
import { TERMS } from '../lib/glossary.ts'
import { indexSize } from '../lib/search.ts'
import { allFragments } from 'weft'

/**
 * The landing page, and the only page that says what this site is.
 *
 * Its three figures are counted rather than typed: the exports come from walking the packages, the
 * error codes from walking their `src/`, and the examples from the guide's own registry. A landing
 * page that claimed a number somebody had to remember to update is a landing page that lies within
 * a month.
 */
export default defineRoute({
  head: {
    title: 'weft — documentation',
    description: 'A TypeScript fullstack framework whose bet is on the delivery layer.',
  },
  layoutValues: {
    heading: 'weft',
    lede: 'The wire form of a piece of UI is negotiated per request, over encodings the compiler has proven equivalent.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    body: {
      html: () => {
        const exports_ = surface().reduce((sum, module) => sum + module.entries.length, 0)
        const documented = surface().reduce(
          (sum, module) => sum + module.entries.filter((entry) => entry.doc).length,
          0,
        )
        return `<div class="cards">${SECTIONS.map(
          (section) => `<div class="card">
            <h3><a href="${section.href}">${section.label}</a></h3>
            <p>${section.blurb}</p>
            ${section.derived ? '<p class="hint">Generated from the source.</p>' : ''}
          </div>`,
        ).join('')}</div>
        <h2>What is on this site</h2>
        <div class="scroll"><table><thead><tr><th>Section</th><th>Size</th><th>How it stays true</th></tr></thead><tbody>
          <tr><td><a href="/guide">Guide</a></td><td>${PAGES.length} pages, covering every document in <code>spec/</code></td>
            <td>A page naming a spec that does not exist fails a test — and so does a spec no page introduces.</td></tr>
          <tr><td><a href="/api">API</a></td><td>${exports_} exports across ${surface().length} modules, ${documented} with a doc comment</td>
            <td>Walked out of each package's public entry. A test fails if an export is missing here.</td></tr>
          <tr><td><a href="/errors">Error reference</a></td><td>${errorCodes().length} named refusals</td>
            <td>Extracted from the source that raises them, with the message and the file.</td></tr>
          <tr><td><a href="/examples">Examples</a></td><td>${exampleCount()} live fragments</td>
            <td>Real files this application compiled. A broken one is a build that does not pass.</td></tr>
          <tr><td><a href="/glossary">Glossary</a></td><td>${TERMS.length} words used in a way another framework does not</td>
            <td>Every link out of it is checked against the route table.</td></tr>
          <tr><td><a href="/search">Search</a></td><td>${indexSize()} entries: pages, sections, steps, terms, codes, exports</td>
            <td>Matched per request from those same registries, so a result cannot point at something renamed.</td></tr>
        </tbody></table></div>
        <h2>This site is a weft application</h2>
        <p>Not a documentation generator pointed at a repository, and not a static-site tool with a weft
        plugin. <code>packages/docs</code> is an application in the same sense the demo is: routes from the
        file tree, a plan generated from it, ${Object.keys(allFragments()).length} sealed templates, and one
        command to serve it. That is the strongest claim the framework can make about itself, so it is the
        one this site is built to be able to make.</p>
        <div class="scroll"><table><thead><tr><th>What the site uses</th><th>Where you can see it</th></tr></thead><tbody>
          <tr><td>Nested layouts — the document is a chain</td><td>Guide, Tutorial and API pages all sit under a <code>routes/&lt;section&gt;/layout.tsx</code></td></tr>
          <tr><td>Param routes with a declared set</td><td>One route serves every guide page; another serves every error code</td></tr>
          <tr><td>The L0 tier</td><td><code>weft build</code> writes this whole site as files. The kernel is not invoked to serve them</td></tr>
          <tr><td>Slots as cache units</td><td>The contents column is a region of its own, so it is one entry across a section rather than a copy per page</td></tr>
          <tr><td>Declared refusals</td><td>The playground and search are the two pages that are <em>not</em> files, and both say why</td></tr>
          <tr><td>The compiler's virtual file set</td><td>The playground compiles what you type without writing it anywhere</td></tr>
          <tr><td>A read as a cache axis</td><td><code>/search?q=</code> taints <code>route:q</code>, so every query is its own content-addressed entry</td></tr>
          <tr><td>An intent, with no JavaScript on the page</td><td>The form on <a href="/guide/intents">intents</a> posts to a real intent in this application</td></tr>
        </tbody></table></div>
        <h2>Where to start</h2>
        <p>If you have ten minutes, <a href="/quick-start">Quick Start</a>. If you want to understand the
        design before writing any of it, the <a href="/guide">Guide</a> reads in order. If you learn by
        building, the <a href="/tutorial">Tutorial</a> puts one page together a step at a time. If you
        already know what you are looking for, the box in the header searches all of it.</p>`
      },
    },
  },
})
