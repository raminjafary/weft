import { fragment, raw } from '@weftjs/core'

/** The one deliberate escape hatch in this demo: a fragment whose single hole is `trusted-raw`, its provenance named in one file. */
export default fragment(({ html }: { html: string }) => <div class="raw">{raw(html)}</div>)
