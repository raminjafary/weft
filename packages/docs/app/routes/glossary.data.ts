import { defineRoute } from 'weft'
import { glossaryBody, slug, TERMS } from '../lib/glossary.ts'

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
    body: {
      html: () =>
        `<nav class="jump"><h2 class="hint">Jump to</h2>${TERMS.map(
          (term) => `<a href="#${slug(term.term)}">${term.term}</a>`,
        ).join('')}</nav>${glossaryBody()}`,
    },
  },
})
