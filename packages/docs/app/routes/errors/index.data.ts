import { defineRoute } from '@weftjs/core'
import { GENERATED, shell } from '../../lib/shell.ts'
import { errorCodes } from '../../lib/errors.ts'
import { errorsIndexBody } from '../../lib/errors-page.ts'
import { errorsOutline } from '../../lib/outlines.ts'
import { errorsContents } from '../../lib/contents.ts'

export default defineRoute({
  head: {
    title: 'Error reference · weft',
    description: 'Every named refusal in the framework, with the message it raises.',
  },
  layoutValues: () =>
    shell({
      ...GENERATED,
      kickerNote: 'extracted from the source that raises them',
      heading: 'Error reference',
      lede: `${errorCodes().length} named refusals, each with the message it raises and the file that raises it.`,
    }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    contents: { fragment: 'docs/contents', load: () => ({ groups: errorsContents() }) },
    body: { fragment: 'docs/page', load: () => ({ blocks: errorsIndexBody() }) },
    outline: { fragment: 'docs/prov', load: () => errorsOutline() },
  },
})
