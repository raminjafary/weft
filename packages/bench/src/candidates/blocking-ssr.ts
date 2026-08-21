import type { Candidate, ServeHandle } from '../candidate.ts'
import { compiledFor, compileScenario, withRows } from '../compiled.ts'
import { sleep, type Scenario } from '../workloads/index.ts'
import { render } from '@weft/ir'
import { createServer } from 'node:http'

/**
 * The common case in production: the route awaits its loader, then renders, then
 * responds. Nothing is wrong with the renderer — the shell is simply downstream of the
 * query. This candidate exists so the slow-hole axis measures the architectural
 * difference rather than the rendering mechanism, which the other two already cover.
 */
export const blockingSsrCandidate: Candidate = {
  id: 'blocking-ssr',
  label: 'Await the loader, then render (control)',
  mechanism:
    'Resolves the route data first, renders the whole document, then sends it with a content length. The same compiled templates and the same renderer as the segments candidate — only the ordering differs.',

  unsupported: {
    'server-throughput':
      'identical to the segments candidate; the difference is response ordering, not render cost',
    'update-bytes': 'identical to the segments candidate',
  },

  async serve(scenario: Scenario): Promise<ServeHandle> {
    const compiled = await compileScenario(scenario)

    const server = createServer((_req, res) => {
      const respond = () => {
        const values = withRows(compiledFor(scenario), scenario.values(), scenario.rows())
        const body = Buffer.from(render(compiled.root, values, compiled.resolve))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
        })
        res.end(body)
      }
      if (scenario.slowMs) void sleep(scenario.slowMs).then(respond)
      else respond()
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
