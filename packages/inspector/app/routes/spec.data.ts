import { defineRoute } from '@weftjs/core'
import { coverageBody } from '../lib/index-page.ts'

/** Every spec document, and the station that claims to be its live version — a gate rendered as a table. */
export default defineRoute({
  head: { title: 'Coverage · weft' },
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
