import { defineRoute } from 'weft'
import { coverageBody } from '../lib/index-page.ts'

/**
 * Every spec document, and the station that claims to be its live version.
 *
 * A gate rendered as a table, and it only means anything inside this repository: it walks `spec/`
 * relative to the working directory. Run from somewhere with no specs and it says so rather than
 * showing an empty table that looks like full coverage.
 */
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
