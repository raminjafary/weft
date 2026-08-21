import { defineRoute } from 'weft'
import { indexBody } from '../../src/index-page.ts'

/**
 * The index: a station per mechanism and a showcase per shape of page.
 *
 * It is a route like every other one, rendered through the kernel with the same document — a demo
 * whose own chrome came from somewhere else would be a demo that had quietly exempted itself from
 * its own claims.
 */
export default defineRoute({
  head: { title: 'Every capability, running · weft demo' },
  layoutValues: {
    heading: 'Every capability, running',
    shows:
      'A station per mechanism and a showcase per shape of page. If a capability is in the specs it has a station here, and a test fails the build when one is missing.',
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
