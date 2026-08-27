import { fragment, raw } from '@weft/core'

/**
 * The framework's one deliberately-unescaped fragment, and the reason a slot can be markup.
 *
 * The plan layer binds a slot to a fragment, never to a string — so a control panel, a readout
 * or anything else that is markup rather than content goes through here. The compiler records
 * the provenance of a `raw()` hole, which is the point: the unsafe thing is named once, in one
 * file, instead of becoming a flag on every hole.
 */
export default fragment(({ html }: { html: string }) => <div class="weft-slot-markup">{raw(html)}</div>)
