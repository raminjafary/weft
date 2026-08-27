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
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: galleryContents() }) },
    body: { html: () => galleryBody() },
    outline: { fragment: 'docs/prov', load: () => galleryOutline() },
  },
})
