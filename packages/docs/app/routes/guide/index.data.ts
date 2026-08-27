import { defineRoute } from 'weft'
import { shell } from '../../lib/shell.ts'
import { guideContents } from '../../lib/contents.ts'
import { railCard } from '../../lib/rails.ts'
import { GROUPS, PAGES } from '../../lib/pages.ts'
import { escapeHtml } from '../../lib/escape.ts'

/**
 * The guide's own index: five groups, in the order the framework is easiest to learn in.
 *
 * The numbering is positional rather than stored, so inserting a page renumbers the ones after it
 * and nothing has to be renumbered by hand. Under the guide layout, so it has the same holes a
 * page does — and no breadcrumb, because an index is not inside anything.
 */
export default defineRoute({
  head: { title: 'Guide · weft', description: 'How weft works, in order.' },
  layoutValues: shell({
    heading: 'The Guide',
    lede:
      `${PAGES.length} pages, in the order the framework is easiest to learn in. Every page links the ` +
      'reference documents it introduces, so you can drop from the introduction straight into the exact ' +
      'rules whenever you want them.',
  }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: guideContents() }) },
    body: {
      html: () =>
        `<div class="guide-groups">${GROUPS.map((group) => {
          const pages = PAGES.filter((page) => page.group === group.id)
          if (!pages.length) return ''
          return `<section class="guide-group">
            <div class="group-head">
              <span class="kicker">${escapeHtml(group.label)}</span>
              <span class="hint">${escapeHtml(group.says)}</span>
              <span class="group-count">${pages.length} page${pages.length === 1 ? '' : 's'}</span>
            </div>
            <div class="cards">${pages
              .map(
                (page) => `<a class="card" href="/guide/${page.slug}">
                  <h3><span class="card-n">${String(PAGES.indexOf(page) + 1).padStart(2, '0')}</span>${escapeHtml(
                    page.title,
                  )}</h3>
                  <p>${escapeHtml(page.lede)}</p>
                  ${
                    page.examples.length
                      ? `<p class="hint">${page.examples.length} live example${page.examples.length === 1 ? '' : 's'}</p>`
                      : ''
                  }
                </a>`,
              )
              .join('')}</div>
          </section>`
        }).join('')}</div>`,
    },
    outline: {
      html: () =>
        railCard(
          'Three things, three jobs',
          `<p>This site is the introduction, in order, with examples that run.</p>
           <p><a href="https://github.com/raminjafary/weft/tree/main/spec"><code>spec/</code></a> is the
            reference: the mechanism, its refusals, and what it deliberately does not do.</p>
           <p><code>pnpm inspect</code> is the live version — a station per mechanism, with a control.</p>`,
        ),
    },
  },
})
