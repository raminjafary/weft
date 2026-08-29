import { defineRoute } from '@weftjs/core'
import { indexBody } from '../lib/index-page.ts'

/** The inspector's index: a station per mechanism, rendered through the kernel like any other route. */
export default defineRoute({
  head: { title: 'Every capability, running · weft' },
  layoutValues: {
    heading: 'Every capability, running',
    shows:
      'A station per mechanism. If a capability is in the specs it has a station here, and a test fails the build when one is missing.',
    control:
      'Pick anything. Each page states what it is showing, what produced the number, and what the number does not cover.',
    status: 'live',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    panel: { fragment: 'markup', stream: false, html: '' },
    body: { fragment: 'markup', stream: false, html: () => indexBody() },
    readout: { fragment: 'markup', stream: false, html: '' },
  },
})
