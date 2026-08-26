import { defineRoute } from 'weft'
import { glossaryBody, glossaryOutline } from '../../lib/glossary.ts'
import { glossaryContents } from '../../lib/contents.ts'

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
    contents: { fragment: 'docs/contents', load: () => ({ groups: glossaryContents() }) },
    body: { html: () => glossaryBody() },
    outline: { html: () => glossaryOutline() },
  },
})
