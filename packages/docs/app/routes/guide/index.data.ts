import { defineRoute } from 'weft'
import { guideContents } from '../../lib/contents.ts'
import { GROUPS, PAGES } from '../../lib/pages.ts'
import { prose } from '../../lib/markup.ts'

/** The guide's own index. Under the guide layout, so it has the same three holes as a page. */
export default defineRoute({
  head: { title: 'Guide · weft', description: 'How weft works, in order.' },
  layoutValues: {
    heading: 'Guide',
    lede: 'How it works, in order. Every example on these pages is a fragment this application compiled.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: guideContents() }) },
    body: {
      html: () =>
        prose(
          'The guide reads in order and each page assumes the ones before it. If you would rather see a ' +
            'mechanism than read about it, <code>pnpm inspect</code> opens the inspector — a page per ' +
            'capability, each with a control.',
        ) +
        GROUPS.map((group) => {
          const pages = PAGES.filter((page) => page.group === group.id)
          if (!pages.length) return ''
          return `<h2>${group.label}</h2><div class="cards">${pages
            .map(
              (page) => `<div class="card">
                <h3><a href="/guide/${page.slug}">${page.title}</a></h3>
                <p>${page.lede}</p>
                ${page.examples.length ? `<p class="hint">${page.examples.length} live example${page.examples.length === 1 ? '' : 's'}</p>` : ''}
              </div>`,
            )
            .join('')}</div>`
        }).join(''),
    },
    outline: {
      html: `<h2 class="hint">Three things, three jobs</h2>
        <p class="hint">This site is the introduction.
        <a href="https://github.com/raminjafary/weft/tree/main/spec"><code>spec/</code></a> is the reference,
        with every refusal and what each mechanism deliberately does not do. The inspector is the live
        version, with a control per capability.</p>`,
    },
  },
})
