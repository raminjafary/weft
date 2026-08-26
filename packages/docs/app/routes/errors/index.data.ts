import { defineRoute } from 'weft'
import { errorCodes } from '../../lib/errors.ts'
import { errorsIndexBody } from '../../lib/errors-page.ts'

export default defineRoute({
  head: {
    title: 'Error reference · weft',
    description: 'Every named refusal in the framework, with the message it raises.',
  },
  layoutValues: () => ({
    heading: 'Error reference',
    lede: `${errorCodes().length} named refusals, extracted from the source that raises them.`,
  }),
  cache: { class: 'public', ttl: '1h' },
  slots: {
    body: { html: () => errorsIndexBody() },
  },
})
