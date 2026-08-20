import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { baseRenderId, deltaPayload, render, type TemplateIR, type Values } from '../../../ir/src/index.ts'
import { compileScenario, withRows } from '../compiled.ts'
import type { Scenario } from '../workloads/index.ts'
import { loadPlaywright, type EngineName } from './browser.ts'

const decoder = new TextDecoder()

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface ClientRuntimeRun {
  engine: EngineName
  engineVersion: string
  checks: Check[]
  /** Milliseconds per operation: adoption, a surgical delta, and the parse it replaces. */
  timings: Record<string, number[]>
}

/** The client's view of a template: everything except the bytes it already holds. */
function clientTemplate(ir: TemplateIR): Record<string, unknown> {
  return { version: ir.version, holes: ir.holes, wiring: ir.wiring, derived: ir.derived }
}

async function serveModule(path: string): Promise<string> {
  const source = await readFile(path, 'utf8')
  return stripTypeScriptTypes(source, { mode: 'strip' })
}

async function page(scenario: Scenario): Promise<string> {
  const compiled = await compileScenario(scenario)
  const values = scenario.values()
  const rows = scenario.rows()
  const next = scenario.transition(rows)

  const before: Values = withRows(compiled, values, rows)
  const after: Values = withRows(compiled, scenario.transitionValues?.(values) ?? values, next)

  const config = {
    template: clientTemplate(compiled.root),
    // Every template but the root: a client holds the ones it is asked to project
    // through, whether that is a row or a component instance.
    resident: Object.fromEntries(
      Object.values(compiled.templates)
        .filter((t) => t.version !== compiled.root.version)
        .map((t) => [t.version, clientTemplate(t)]),
    ),
    html: decoder.decode(render(compiled.root, before, compiled.resolve)),
    expected: decoder.decode(render(compiled.root, after, compiled.resolve)),
    delta: deltaPayload(compiled.root, baseRenderId(compiled.root, before), before, after, compiled.resolve),
    values: before,
    iterations: 12,
    batch: 20,
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>client runtime</title></head><body>
<script type="application/json" id="config">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>
<script type="module" src="/driver.ts"></script>
</body></html>`
}

export async function measureClientRuntime(
  scenario: Scenario,
  engine: EngineName,
): Promise<ClientRuntimeRun> {
  const pw = await loadPlaywright()
  if (!pw) throw new Error('E_NO_PLAYWRIGHT: install playwright to exercise the client runtime')

  const document = await page(scenario)
  const runtimeDir = fileURLToPath(new URL('../../../client/src/', import.meta.url))
  const driver = fileURLToPath(new URL('../client/driver.ts', import.meta.url))

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string
    const send = (body: string, type: string) => {
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    }
    if (path === '/driver.ts') {
      void serveModule(driver).then((code) => send(code, 'text/javascript; charset=utf-8'))
      return
    }
    if (path.startsWith('/runtime/')) {
      void serveModule(runtimeDir + path.slice('/runtime/'.length))
        .then((code) => send(code, 'text/javascript; charset=utf-8'))
        .catch(() => {
          res.writeHead(404)
          res.end()
        })
      return
    }
    send(document, 'text/html; charset=utf-8')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')
  const url = `http://127.0.0.1:${address.port}/`

  const browser = await pw[engine].launch()
  try {
    const context = await browser.newContext()
    const tab = await context.newPage()
    const failures: string[] = []
    tab.on?.('pageerror', (error: Error) => failures.push(error.message))
    await tab.goto(url, { waitUntil: 'load' })
    const result = await tab.evaluate<{ checks: Check[]; timings: Record<string, number[]> }>(
      '(() => window.__weft)()' as unknown as () => { checks: Check[]; timings: Record<string, number[]> },
    )
    await tab.close()
    await context.close()

    const checks = result?.checks ?? []
    for (const message of failures) checks.push({ name: 'page error', ok: false, detail: message })
    return { engine, engineVersion: browser.version(), checks, timings: result?.timings ?? {} }
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
