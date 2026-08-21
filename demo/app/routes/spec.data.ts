import { defineRoute } from 'weft'
import { coverageBody } from '../../src/index-page.ts'

/** Every spec document, and the station that claims to be its live version. A gate as a table. */
export default defineRoute({
  head: { title: 'Coverage · weft demo' },
  layoutValues: {
    heading: 'Spec coverage',
    shows: 'Every spec document, and the stations that claim to be its live version.',
    control: 'None. This page is a gate rendered as a table.',
    status: 'live',
  },
  cache: { class: 'public', ttl: '1h' },
  slots: {
    panel: { fragment: 'markup', stream: false, html: '' },
    body: { fragment: 'markup', stream: false, html: () => coverageBody() },
    readout: { fragment: 'markup', stream: false, html: '' },
  },
})
