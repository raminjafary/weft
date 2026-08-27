import { fragment, raw } from '@weftjs/core'

/**
 * The one deliberate escape hatch in this demo: a fragment whose single hole is `trusted-raw`.
 *
 * It exists because the plan layer binds a slot to a *fragment*, and a control panel is markup
 * rather than content — so rather than teach the plan layer about strings, the markup goes through
 * a fragment that says out loud that it is not escaping. The compiler records the provenance of a
 * `raw()` hole, which is the point: the unsafe thing is named, in one file, instead of being a
 * flag on every hole.
 */
export default fragment(({ html }: { html: string }) => <div class="raw">{raw(html)}</div>)
