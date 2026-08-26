import { renderExample } from './example.ts'
import { example, note, prose } from './markup.ts'
import { PAGES } from './pages.ts'

/**
 * Every live example on the site, in one place.
 *
 * The gallery is derived from the guide's registry rather than being a second list, so an example
 * added to a page appears here and an example removed disappears. What it adds over the guide pages
 * is the ability to read them all at once — which is the thing somebody comparing two shapes wants
 * and the sequential guide cannot give.
 */
export function galleryBody(): string {
  const pages = PAGES.filter((page) => page.examples.length)
  const total = pages.reduce((sum, page) => sum + page.examples.length, 0)
  return (
    prose(
      `<strong>${total}</strong> examples, each a fragment under <code>app/fragments/examples/</code> in this ` +
        'application. Every one is compiled by the build that served you this page, rendered by the same ' +
        'renderer the rest of the site uses, and shown beside the bytes on disk that produced it.',
    ) +
    note(
      'why',
      'What "live" is doing here',
      'An example that cannot compile is a build that does not pass, so a broken example cannot ship. An ' +
        'example whose output disagreed with its source would need two compilations to disagree, and there ' +
        'is only one. That is the whole mechanism, and it is why this page can promise something a code ' +
        'block cannot.',
    ) +
    pages
      .map(
        (page) =>
          `<h2 id="${page.slug}"><a class="anchor" href="#${page.slug}">${page.title}</a></h2>` +
          `<p class="hint"><a href="/guide/${page.slug}">Read the page this is from →</a></p>` +
          page.examples.map((ex) => example(renderExample(ex))).join(''),
      )
      .join('')
  )
}

/**
 * The right column: what the gallery is derived from.
 *
 * The counts are computed from the same registry the body walks, so a page that gains an example
 * cannot leave this column disagreeing with the one beside it.
 */
export function galleryOutline(): string {
  const pages = PAGES.filter((page) => page.examples.length)
  const total = pages.reduce((sum, page) => sum + page.examples.length, 0)
  return (
    `<h2 class="hint">This page</h2><dl class="prov">` +
    `<dt>Examples</dt><dd>${total}</dd>` +
    `<dt>From</dt><dd>${pages.length} guide page${pages.length === 1 ? '' : 's'}</dd>` +
    `<dt>Source</dt><dd><code>app/fragments/examples/</code></dd>` +
    `</dl><p class="hint"><a href="/guide">The guide these are from</a></p>`
  )
}
