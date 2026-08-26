import { defineRoute } from 'weft'
import { galleryBody, galleryContents, galleryOutline } from '../../lib/gallery.ts'

export default defineRoute({
  head: { title: 'Examples · weft', description: 'Every live example on the site, with its source.' },
  layoutValues: {
    heading: 'Examples',
    lede: 'Every live example on this site, with the file that produced it and what the compiler knows about it.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { html: () => galleryContents() },
    body: { html: () => galleryBody() },
    outline: { html: () => galleryOutline() },
  },
})
