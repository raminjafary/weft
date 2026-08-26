import { defineRoute } from 'weft'
import { glossaryBody, glossaryContents, glossaryOutline } from '../../lib/glossary.ts'

export default defineRoute({
  head: {
    title: 'Glossary · weft',
    description: 'The words this framework uses in a way another framework does not.',
  },
  layoutValues: {
    heading: 'Glossary',
    lede: 'The words this framework uses in a way another framework does not.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    // The jump list this used to prepend to `body` is now a hole of its own, which is what makes it
    // one cache entry instead of bytes rebuilt alongside the prose on every render.
    contents: { html: () => glossaryContents() },
    body: { html: () => glossaryBody() },
    outline: { html: () => glossaryOutline() },
  },
})
