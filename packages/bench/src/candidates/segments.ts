import {
  type Resolver,
  renderHole,
  type TemplateIR,
  type Values,
  assertValidTemplate,
  baseRenderId,
  dataPayload,
  deltaPayload,
  draftTemplate,
  render,
  seal,
} from '../../../ir/src/index.ts'
import type { Candidate, ServeHandle, ServeOptions, UpdatePayloads } from '../candidate.ts'
import type { Authored, Scenario } from '../workloads/index.ts'
import { createServer } from 'node:http'

const utf8 = new TextEncoder()

export interface Compiled {
  root: TemplateIR
  row?: TemplateIR
  resolve: Resolver
}

const cache = new Map<string, Compiled>()

async function sealAuthored(a: Authored): Promise<TemplateIR> {
  const ir = draftTemplate({
    id: a.id,
    segments: a.parts,
    holes: a.holes,
    ...(a.wiring ? { wiring: a.wiring } : {}),
    ...(a.signals ? { signals: a.signals } : {}),
  })
  return assertValidTemplate(await seal(ir))
}

/** Compiles the scenario once. The row template is sealed first so the root can name its version. */
export async function prepareSegments(scenario: Scenario): Promise<Compiled> {
  const hit = cache.get(scenario.id)
  if (hit) return hit

  const row = scenario.row ? await sealAuthored(scenario.row.authored) : undefined
  let root = scenario.root
  if (row && scenario.row) {
    const binding = scenario.row.binding
    root = {
      ...scenario.root,
      holes: scenario.root.holes.map((h) => (h.binding === binding && h.kind === 'list' ? { ...h, nested: row.version } : h)),
    }
  }
  const compiled: Compiled = {
    root: await sealAuthored(root),
    ...(row ? { row } : {}),
    resolve: (version) => (row && version === row.version ? row : undefined),
  }
  cache.set(scenario.id, compiled)
  return compiled
}

function compiledFor(scenario: Scenario): Compiled {
  const compiled = cache.get(scenario.id)
  if (!compiled) throw new Error(`E_NOT_PREPARED: call prepareSegments(${scenario.id}) first`)
  return compiled
}

function valuesWithRows(scenario: Scenario, values: Values, rows: Values[]): Values {
  if (!scenario.row) return values
  return { ...values, [scenario.row.binding]: rows as unknown as Values[string] }
}

/**
 * The first byte a client can be sent: everything up to the first hole whose content
 * has to be produced. For a precomputed shell that is a lookup, not a render.
 */
function flushBoundary(root: TemplateIR, values: Values): number {
  const listIndex = root.holes.findIndex((h) => h.kind === 'list')
  if (listIndex < 0) return Number.MAX_SAFE_INTEGER
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
    'Templates compile to a versioned IR of constant Uint8Array segments plus holes. Rendering is memcpy with escaping only where the compiler could not elide it, and the same render function projects the data form on the client.',

  render(scenario, values, rows) {
    const compiled = compiledFor(scenario)
    return render(compiled.root, valuesWithRows(scenario, values, rows), compiled.resolve)
  },

  updateForms(scenario, values, prev, next): UpdatePayloads {
    const compiled = compiledFor(scenario)
    const nextValues = valuesWithRows(scenario, values, next)
    const prevValues = valuesWithRows(scenario, values, prev)
    const out: UpdatePayloads = { html: render(compiled.root, nextValues, compiled.resolve) }

    if (compiled.root.forms.includes('data')) {
      out.data = utf8.encode(JSON.stringify(dataPayload(compiled.root, nextValues)))
    }
    if (compiled.root.forms.includes('delta')) {
      const base = baseRenderId(compiled.root, prevValues)
      out.delta = utf8.encode(JSON.stringify(deltaPayload(compiled.root, base, prevValues, nextValues)))
    }
    return out
  },

  async serve(scenario, options?: ServeOptions): Promise<ServeHandle> {
    const compiled = await prepareSegments(scenario)
    const values = valuesWithRows(scenario, scenario.values(), scenario.rows())
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
      res.end(tail)
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
