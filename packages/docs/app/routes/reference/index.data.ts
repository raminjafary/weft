import { defineRoute } from '@weftjs/core'
import { GENERATED, shell } from '../../lib/shell.ts'
import { referenceContents } from '../../lib/contents.ts'
import { referenceIndexBody, referenceOutline, referenceProv } from '../../lib/reference-page.ts'

export default defineRoute({
  head: {
    title: 'Reference · weft',
    description:
      'Every field of every declaration — weft.config.ts, .data.ts, intents, renderables, the folder convention and the ports — read out of the source.',
  },
  layoutValues: () =>
    shell({
      ...GENERATED,
      kickerNote: 'read out of the interfaces that implement them',
      heading: 'Reference',
      lede:
        'Every field of every declaration, with the type it accepts and the default it gets by being left ' +
        'out. Six pages, one per thing you write, and not a sentence on them that the source did not say ' +
        'first.',
    }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: referenceContents() }) },
    body: { fragment: 'docs/page', load: () => ({ blocks: referenceIndexBody() }) },
    outline: { html: () => referenceOutline() },
    prov: { fragment: 'docs/prov', load: () => referenceProv() },
  },
})
