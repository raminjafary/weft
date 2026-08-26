import { defineRoute } from 'weft'
import { apiIndexBody, moduleList } from '../../lib/api-page.ts'

export default defineRoute({
  head: { title: 'API · weft', description: 'Every export of every package, read out of the source.' },
  layoutValues: {
    heading: 'API',
    lede: 'Every export of every package, walked out of the source so it cannot drift.',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { html: () => moduleList() },
    body: { html: () => apiIndexBody() },
    outline: {
      html: `<h2 class="hint">How this page is made</h2>
        <p class="hint">Each module's public entry is parsed, its re-exports followed, and every exported
        declaration collected with the doc comment above it. Adding an export adds a row. A test walks the
        same tree and fails if a row is missing.</p>`,
    },
  },
})
