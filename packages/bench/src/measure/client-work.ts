import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { TemplateIR, Values } from '../../../ir/src/index.ts'
import { compileScenario, withRows } from '../compiled.ts'
import { segmentsCandidate } from '../candidates/segments.ts'
import type { Scenario } from '../workloads/index.ts'
import { loadPlaywright, type EngineName } from './browser.ts'

const decoder = new TextDecoder()

function serialize(ir: TemplateIR): { parts: string[]; holes: TemplateIR['holes'] } {
  return { parts: ir.segments.map((s) => decoder.decode(s)), holes: ir.holes }
}

export interface ClientWorkOptions {
  engine: EngineName
  iterations: number
  warmup: number
  /** Payloads applied per timed sample, since one costs less than the clock can resolve. */
  batch: number
}

export interface ClientWorkRun {
  engine: EngineName
  engineVersion: string
  nodes: number
  /** Milliseconds to turn one payload of that form into DOM, per iteration. */
  samples: Record<string, number[]>
}

async function page(scenario: Scenario, options: ClientWorkOptions): Promise<string> {
  const compiled = await compileScenario(scenario)
  const values = scenario.values()
  const rows = scenario.rows()
  const next = scenario.transition(rows)
  const payloads = segmentsCandidate.updateForms!(scenario, values, rows, next)

  const template = {
    root: serialize(compiled.root),
    ...(compiled.row ? { row: serialize(compiled.row) } : {}),
  }
  const base: Values = withRows(compiled, values, rows)

  const config = {
    template,
    html: decoder.decode(payloads.html as Uint8Array),
    data: payloads.data ? decoder.decode(payloads.data) : null,
    delta: payloads.delta ? decoder.decode(payloads.delta) : null,
    base,
    iterations: options.iterations,
    warmup: options.warmup,
    batch: options.batch,
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>client work</title></head><body>
<div id="target"></div>
<script type="module">
import { run } from '/measure.js'
const config = ${JSON.stringify(config)}
window.__bench = run(config)
performance.mark('candidate:interactive')
</script>
</body></html>`
}

/**
 * Serves a page that turns each wire form into DOM, so the question the payload-size
 * axis cannot answer — what the client pays for the form it was sent — is measured
 * rather than argued about.
 */
export async function measureClientWork(scenario: Scenario, options: ClientWorkOptions): Promise<ClientWorkRun> {
  const pw = await loadPlaywright()
  if (!pw) throw new Error('E_NO_PLAYWRIGHT: install playwright to run browser axes')

  const document = await page(scenario, options)
  const modules = new Map<string, string>()
  for (const name of ['project.js', 'measure.js']) {
    modules.set(`/${name}`, await readFile(fileURLToPath(new URL(`../client/${name}`, import.meta.url)), 'utf8'))
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string
    const module = modules.get(path)
    if (module) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(module)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(document)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')
  const url = `http://127.0.0.1:${address.port}/`

  const browser = await pw[options.engine].launch()
  try {
    const context = await browser.newContext()
    const tab = await context.newPage()
    await tab.goto(url, { waitUntil: 'load' })
    const raw = await tab.evaluate<{ nodes: number } & Record<string, unknown>>(
      '(() => window.__bench)()' as unknown as () => { nodes: number } & Record<string, unknown>,
    )
    await tab.close()
    await context.close()

    const samples: Record<string, number[]> = {}
    for (const [form, value] of Object.entries(raw)) {
      if (form !== 'nodes' && Array.isArray(value)) samples[form] = value as number[]
    }
    return { engine: options.engine, engineVersion: browser.version(), nodes: raw.nodes, samples }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
