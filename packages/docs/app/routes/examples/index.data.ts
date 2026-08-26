import { defineRoute } from 'weft'
import { galleryBody, galleryOutline } from '../../lib/gallery.ts'
import { galleryContents } from '../../lib/contents.ts'

export default defineRoute({
  head: { title: 'Examples · weft', description: 'Every live example on the site, with its source.' },
  layoutValues: {
    heading: 'Examples',
    lede: 'Every live example on this site, with the file that produced it and what the compiler knows about it.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: galleryContents() }) },
    body: { html: () => galleryBody() },
    outline: { html: () => galleryOutline() },
  },
})
