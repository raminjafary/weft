import {
  baseRenderId,
  deltaPayload,
  render,
  renderHole,
  resolveDerived,
  type TemplateIR,
  type Values,
} from '@weft/ir'
import type { Candidate, ServeHandle, ServeOptions, UpdatePayloads } from '../candidate.ts'
import { compileScenario, compiledFor, withRows, type Compiled } from '../compiled.ts'
import { sleep } from '../workloads/index.ts'
import { createServer } from 'node:http'

const utf8 = new TextEncoder()

/**
 * The first byte a client can be sent: everything up to the first hole whose content
 * has to be produced. For a precomputed shell that is a lookup, not a render.
 */
function flushBoundary(root: TemplateIR, supplied: Values): number {
  const listIndex = root.holes.findIndex((h) => h.kind === 'list')
  if (listIndex < 0) return Number.MAX_SAFE_INTEGER
  const values = resolveDerived(root.derived, supplied)
  let length = 0
  for (let i = 0; i <= listIndex; i++) length += (root.segments[i] as Uint8Array).length
  for (let i = 0; i < listIndex; i++) {
    const hole = root.holes[i]
    if (hole) length += renderHole(hole, values[hole.binding]).length
  }
  return length
}

export const segmentsCandidate: Candidate = {
  id: 'segments',
  label: 'Weft pre-encoded segments',
  mechanism:
    'The compiler emits constant Uint8Array segments plus holes. Rendering copies the segments and encodes hole values straight into the destination buffer, escaping only where the compiler could not elide it. The same function projects the data form on the client.',

  render(scenario, values, rows) {
    const compiled = compiledFor(scenario)
    return render(compiled.root, withRows(compiled, values, rows), compiled.resolve)
  },

  updateForms(scenario, values, prev, next): UpdatePayloads {
    const compiled = compiledFor(scenario)
    const nextValues = withRows(compiled, values, next)
    const prevValues = withRows(compiled, values, prev)
    const out: UpdatePayloads = { html: render(compiled.root, nextValues, compiled.resolve) }

    if (compiled.root.forms.includes('delta')) {
      const base = baseRenderId(compiled.root, prevValues)
      out.delta = utf8.encode(
        JSON.stringify(deltaPayload(compiled.root, base, prevValues, nextValues, compiled.resolve)),
      )
    }
    return out
  },

  async serve(scenario, options?: ServeOptions): Promise<ServeHandle> {
    const compiled: Compiled = await compileScenario(scenario)
    const values = withRows(compiled, scenario.values(), scenario.rows())
    const buffer = Buffer.from(render(compiled.root, values, compiled.resolve))
    const etag = `"${compiled.root.version.slice(0, 16)}"`
    const stream = (options?.transport ?? 'stream') === 'stream'
    const boundary = stream ? flushBoundary(compiled.root, values) : buffer.length
    const head = buffer.subarray(0, boundary)
    const tail = buffer.subarray(boundary)

    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(buffer.length),
        etag,
      })
      if (tail.length === 0) {
        res.end(head)
        return
      }
      res.write(head)
      if (!scenario.slowMs) {
        res.end(tail)
        return
      }
      // The shell's bytes are already travelling while the query is still running,
      // which is the whole point of the shell not depending on the query.
      void sleep(scenario.slowMs).then(() => {
        const rows = scenario.rows()
        const fresh = render(compiled.root, withRows(compiled, scenario.values(), rows), compiled.resolve)
        res.end(Buffer.from(fresh.subarray(boundary)))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')
    return {
      url: `http://127.0.0.1:${address.port}${scenario.route}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  },
}
