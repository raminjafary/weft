import { render, type Values } from '@weftjs/ir'
import type { RenderJobIR, RenderPort } from '@weftjs/kernel'

/** Who turns a fragment and a value set into bytes. See `spec/kernel/ports.md`. */
export function irRenderer(): RenderPort {
  return {
    name: 'ir',
    render: (job: RenderJobIR) => render(job.template, job.values as Values, job.resolve),
  }
}
