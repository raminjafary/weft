import { defineRoute } from 'weft'
import { SECTIONS } from '../lib/sections.ts'
import { exampleCount } from '../lib/content.ts'
import { errorCodes } from '../lib/errors.ts'
import { surface } from '../lib/surface.ts'
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
          <tr><td><a href="/api">API</a></td><td>${exports_} exports across ${surface().length} modules, ${documented} with a doc comment</td>
            <td>Walked out of each package's public entry. A test fails if an export is missing here.</td></tr>
          <tr><td><a href="/errors">Error reference</a></td><td>${errorCodes().length} named refusals</td>
            <td>Extracted from the source that raises them, with the message and the file.</td></tr>
          <tr><td><a href="/examples">Examples</a></td><td>${exampleCount()} live fragments</td>
            <td>Real files this application compiled. A broken one is a build that does not pass.</td></tr>
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
          <tr><td>A declared refusal</td><td>The playground is the one page that is <em>not</em> a file, and it says why</td></tr>
          <tr><td>The compiler's virtual file set</td><td>The playground compiles what you type without writing it anywhere</td></tr>
        </tbody></table></div>
        <h2>Where to start</h2>
        <p>If you have ten minutes, <a href="/quick-start">Quick Start</a>. If you want to understand the
        design before writing any of it, the <a href="/guide">Guide</a> reads in order. If you learn by
        building, the <a href="/tutorial">Tutorial</a> puts one page together a step at a time.</p>`
      },
    },
  },
})
