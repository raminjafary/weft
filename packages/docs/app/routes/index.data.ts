import { allFragments, defineRoute } from 'weft'
import { shell } from '../lib/shell.ts'
import { landingBody } from '../lib/landing.ts'
import { exampleCount } from '../lib/content.ts'
import { errorCodes } from '../lib/errors.ts'
import { surface } from '../lib/surface.ts'
import { PAGES } from '../lib/pages.ts'
import { TERMS } from '../lib/glossary.ts'
import { indexSize } from '../lib/search.ts'

/**
 * The landing page, and the only page that says what this site is.
 *
 * Every number on it is counted rather than typed: the exports come from walking the packages, the
 * error codes from walking their `src/`, the examples from the guide's own registry, and the
 * template count from the fragments this build sealed. A landing page that claimed a figure somebody
 * had to remember to update is a landing page that lies within a month.
 *
 * It is the one page with no rail on either side, so it fills the shell itself and brings its own
 * stylesheet — `index.css`, which the framework links here and on no other page.
 */
export default defineRoute({
  head: {
    title: 'weft — a framework that negotiates how UI reaches the browser',
    description:
      'A TypeScript fullstack framework whose bet is on the delivery layer: the wire form of a piece of UI is chosen per request from encodings the compiler has proven equivalent.',
  },
  layoutValues: shell({
    heading: 'weft',
    lede: 'The wire form of a piece of UI is negotiated per request, over encodings the compiler has proven equivalent.',
  }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    body: {
      html: () =>
        landingBody({
          exports: surface().reduce((sum, module) => sum + module.entries.length, 0),
          modules: surface().length,
          codes: errorCodes().length,
          examples: exampleCount(),
          terms: TERMS.length,
          index: indexSize(),
          templates: Object.keys(allFragments()).length,
          pages: PAGES.length,
        }),
    },
  },
})
