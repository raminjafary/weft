import { defineRoute } from 'weft'
import { shell } from '../../lib/shell.ts'
import { glossaryBody } from '../../lib/glossary.ts'
import { glossaryOutline } from '../../lib/outlines.ts'
import { glossaryContents } from '../../lib/contents.ts'

export default defineRoute({
  head: {
    title: 'Glossary · weft',
    description: 'The words this framework uses in a way another framework does not.',
  },
  layoutValues: shell({
    heading: 'Glossary',
    lede: 'The words this framework uses in a way another framework does not — each one linked to the page it is introduced on.',
  }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: glossaryContents() }) },
    body: { html: () => glossaryBody() },
    outline: { fragment: 'docs/prov', load: () => glossaryOutline() },
  },
})
