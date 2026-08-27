import { defineRoute } from '@weft/core'
import { shell } from '../../lib/shell.ts'
import { guideContents } from '../../lib/contents.ts'
import { GROUPS, PAGES } from '../../lib/pages.ts'
import { escapeHtml } from '../../lib/escape.ts'
import { architecture } from '../../lib/architecture.ts'
import { staticPages } from '../../lib/counts.ts'

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
        `${architecture({ files: staticPages(), pages: PAGES.length })}
        <div class="guide-groups" id="directory">${GROUPS.map((group) => {
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
    // The index has no outline column — the shell collapses it when the page draws the
    // architecture — because what would have gone in it is the section's own closing block, where
    // the three things belong: beside the diagrams they are the alternative readings of.
    outline: { html: () => '' },
  },
})
