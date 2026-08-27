import { render, type Values } from '@weftjs/ir'
import type { RenderJobIR, RenderPort } from '@weftjs/kernel'

/**
 * Who turns a fragment and a value set into bytes.
 *
 * This is the default and it is the same call the plan used to make directly: pre-encoded
 * constant segments written out around escaped holes. Binding it rather than assuming it costs
 * one indirection and buys the seam the design named — `remote` in phase 9 is another
 * implementation of this port, not a second render path beside the first one.
 *
 * A renderer that is asked for a template it cannot serve has nowhere honest to go, so there is
 * no fallback here: the IR renderer refuses a version it does not understand rather than
 * emitting markup that happens to parse.
 */
export function irRenderer(): RenderPort {
  return {
    name: 'ir',
    render: (job: RenderJobIR) => render(job.template, job.values as Values, job.resolve),
  }
}
