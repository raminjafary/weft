import { defineRoute } from 'weft'
import { ARTICLE } from '../../lib/data.ts'
import { panel } from '../../lib/controls.ts'
import { fragmentIR, listHole } from 'weft'

/**
 * An article: the case where almost nothing should ship.
 *
 * The fragment reads nothing, so its class is static and its key is the content address. No ttl is
 * needed because there is no clock read to expire, and the page links one stylesheet and loads a
 * client that finds no adoptable region and does nothing.
 */
export default defineRoute({
  head: { title: 'An article · weft demo' },
  layoutValues: {
    heading: 'An article',
    shows: 'The case where almost nothing should ship. This fragment reads nothing, so its class is static.',
    control: 'Disable JavaScript and reload. Nothing changes, because nothing on this page needed it.',
    status: 'live',
  },
  slots: {
    panel: {
      fragment: 'markup',
      stream: false,
      html: panel('', 'No controls. That is the demonstration: there is nothing on this page to drive.'),
    },
    body: {
      fragment: 'article',
      stream: false,
      cache: { class: 'public', ttl: '1h' },
      load: async () => {
        return {
          title: ARTICLE.title,
          standfirst: ARTICLE.standfirst,
          byline: ARTICLE.byline,
          [listHole(fragmentIR('fragment:article'))]: ARTICLE.blocks,
        }
      },
    },
    readout: { fragment: 'markup', stream: false, html: '' },
  },
})
