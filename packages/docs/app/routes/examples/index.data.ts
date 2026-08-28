import { defineRoute } from '@weftjs/core'
import { GENERATED, shell } from '../../lib/shell.ts'
import { galleryBody } from '../../lib/gallery.ts'
import { galleryOutline } from '../../lib/outlines.ts'
import { galleryContents } from '../../lib/contents.ts'

export default defineRoute({
  head: { title: 'Examples · weft', description: 'Every live example on the site, with its source.' },
  layoutValues: shell({
    ...GENERATED,
    kickerNote: "from the guide's own registry",
    heading: 'Examples',
    lede:
      'Every live fragment on this site, with the source that produced it and what the compiler knows ' +
      'about it. The output beside each source is not a screenshot — it is that fragment, rendered by ' +
      'this page.',
  }),
  /**
   * Tagged, because this gallery renders the one example on the site that writes.
   *
   * `/examples` shows every example the documentation has, and one of them is the vote form. A
   * file cannot show a number that moves, so the count here was frozen exactly as it was on the
   * intents page — pressing the button dispatched a real intent and left the page saying what it
   * had said at build time.
   *
   * The tag on the document is the half that is easy to miss: dropping the slot's entry is not
   * enough while the whole response is held for an hour under no tag at all. See
   * `W_DOCUMENT_OUTLIVES_INVALIDATION`, which exists because this took an afternoon to find.
   */
  cache: { class: 'public', ttl: '1h', tags: ['docs.votes'] },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: galleryContents() }) },
    body: {
      cache: { class: 'public', ttl: '1h', tags: ['docs.votes'] },
      live: true,
      // Markup rather than a sealed template, so `patch` is the smallest form available and `html`
      // is the floor under it. `delta` needs projectable values and the build refuses it by name.
      form: { prefer: 'patch', fallback: 'html' },
      html: () => galleryBody(),
    },
    outline: { fragment: 'docs/prov', load: () => galleryOutline() },
  },
})
