#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AXES } from './axes.ts'
import type { Candidate } from './candidate.ts'
import { externalCandidate, type ExternalConfig } from './candidates/external.ts'
import { segmentsCandidate } from './candidates/segments.ts'
import { stringSsrCandidate } from './candidates/string-ssr.ts'
import { blockingSsrCandidate } from './candidates/blocking-ssr.ts'
import { measureBudgets } from './budget.ts'
import { fillerSize } from '../../kernel/src/index.ts'
import { DELAYS, measureSlots, probeIncrementalDsd } from './measure/slots.ts'
import { checkAll } from './equivalence.ts'
import { measureClientRuntime } from './measure/client-runtime.ts'
import { compileScenario } from './compiled.ts'
import { renderMarkdown, comparison } from './report.ts'
import { run } from './runner.ts'
import { SCENARIOS, scenario as scenarioById } from './workloads/index.ts'
import { stringify } from '../../ir/src/index.ts'
import type { EngineName } from './measure/browser.ts'

const BUILT_IN: Candidate[] = [segmentsCandidate, stringSsrCandidate, blockingSsrCandidate]

function parseArgs(argv: string[]): { command: string; flags: Record<string, string>; positional: string[] } {
  const [command = 'help', ...rest] = argv
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq > 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1)
      } else {
        const next = rest[i + 1]
        if (next && !next.startsWith('--')) {
          flags[token.slice(2)] = next
          i++
        } else {
          flags[token.slice(2)] = 'true'
        }
      }
    } else {
      positional.push(token)
    }
  }
  return { command, flags, positional }
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? NaN
}

function csv(value: string | undefined): string[] | undefined {
  return value
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
}

function candidatesFrom(flags: Record<string, string>): Candidate[] {
  const chosen = csv(flags.candidates)
  let list = BUILT_IN
  if (chosen) {
    list = chosen.map((id) => {
      const found = BUILT_IN.find((c) => c.id === id)
      if (!found)
        throw new Error(`E_UNKNOWN_CANDIDATE: ${id}. known: ${BUILT_IN.map((c) => c.id).join(', ')}`)
      return found
    })
  }
  if (flags.external) {
    const configs = JSON.parse(readFileSync(flags.external, 'utf8')) as ExternalConfig[]
    list = [...list, ...configs.map(externalCandidate)]
  }
  return list
}

const HELP = `weft-bench — phase-zero benchmark harness

  run       measure the axes and write a report
  verify    check that every wire form of a fragment produces identical bytes
  client    run the client runtime's own conformance checks in every engine
  budget    bundle each entry and measure it against its byte budget
  slots     stream a route in both orders, and probe incremental shadow DOM
  list      list axes, scenarios, and candidates
  ir        print the sealed, versioned IR for a scenario

run flags
  --axes            ${AXES.map((a) => a.id).join(',')}
  --scenarios       ${SCENARIOS.map((s) => s.id).join(',')}
  --candidates      ${BUILT_IN.map((c) => c.id).join(',')}
  --external FILE   JSON array of third-party candidates to spawn and measure
  --iterations N    HTTP samples per candidate (default 200)
  --warmup N        HTTP warmup requests (default 30)
  --connection      warm | cold (default warm)
  --transport       stream | buffered (default stream; buffered is the intercepted-webview path)
  --latency N       injected round-trip time in ms; required for any shell-TTFB claim
  --batches N       in-process timing batches (default 25)
  --ops N           renders per batch (default 200)
  --engines         chromium,firefox,webkit (browser axes; requires playwright)
                    webkit is the closest proxy for an iOS webview and is never an iOS number
  --out DIR         where to write the report (default results/)
  --no-strict       measure even if the wire forms disagree
`

async function main(): Promise<number> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2))

  if (command === 'help' || flags.help) {
    process.stdout.write(HELP)
    return 0
  }

  if (command === 'list') {
    process.stdout.write('axes\n')
    for (const a of AXES) {
      process.stdout.write(
        `  ${a.id.padEnd(22)} ${a.unit.padEnd(13)} needs ${a.needs.padEnd(11)} expect ${a.expectation}\n`,
      )
    }
    process.stdout.write('\nscenarios\n')
    for (const s of SCENARIOS) process.stdout.write(`  ${s.id.padEnd(22)} ${s.label} (${s.route})\n`)
    process.stdout.write('\ncandidates\n')
    for (const c of BUILT_IN) process.stdout.write(`  ${c.id.padEnd(22)} ${c.label}\n`)
    return 0
  }

  if (command === 'ir') {
    const target = positional[0] ?? 'cart'
    const compiled = await compileScenario(scenarioById(target))
    if (compiled.row) process.stdout.write(`${stringify(compiled.row)}\n`)
    process.stdout.write(`${stringify(compiled.root)}\n`)
    return 0
  }

  if (command === 'slots') {
    const engines = (csv(flags.engines) ?? ['chromium', 'firefox', 'webkit']) as EngineName[]
    let failed = false

    process.stdout.write(
      `the slow region is first in document order, ${DELAYS.feed}ms against ${DELAYS.recs}ms\n\n`,
    )
    for (const engine of engines) {
      const measured = await measureSlots(engine, Number(flags.iterations ?? 5))
      if (!measured.sameDom) {
        failed = true
        process.stdout.write(
          `FAIL  ${engine}: the two orders end at different DOM\n      ${measured.domDetail}\n`,
        )
      }
      process.stdout.write(
        `${engine.padEnd(9)} in-order      slow ${p50(measured.inOrder.map((t) => t.feed))
          .toFixed(0)
          .padStart(4)}ms  fast ${p50(measured.inOrder.map((t) => t.recs))
          .toFixed(0)
          .padStart(4)}ms\n`,
      )
      process.stdout.write(
        `${''.padEnd(9)} out-of-order  slow ${p50(measured.outOfOrder.map((t) => t.feed))
          .toFixed(0)
          .padStart(4)}ms  fast ${p50(measured.outOfOrder.map((t) => t.recs))
          .toFixed(0)
          .padStart(4)}ms  (+${fillerSize()} B inline)\n`,
      )
    }

    process.stdout.write('\nincremental declarative shadow DOM, host closes at 60ms\n\n')
    for (const engine of engines) {
      const probe = await probeIncrementalDsd(engine)
      const incremental = probe.shadowRootMs !== null && probe.shadowRootMs < 55
      process.stdout.write(
        `${engine.padEnd(9)} shadow root at ${probe.shadowRootMs === null ? 'never' : `${probe.shadowRootMs.toFixed(0)}ms`}  slotted at ${probe.slottedMs === null ? 'never' : `${probe.slottedMs.toFixed(0)}ms`}  rendered ${probe.renderedBeforeClose}  ${incremental ? 'incremental' : 'NOT INCREMENTAL'}\n`,
      )
    }
    return failed ? 1 : 0
  }

  if (command === 'budget') {
    const sizes = await measureBudgets()
    let over = false
    for (const size of sizes) {
      if (!size.within) over = true
      process.stdout.write(
        `${size.within ? 'within' : 'OVER  '}  ${size.id.padEnd(14)} ${String(size.brotli).padStart(6)} B brotli  (${String(size.gzip).padStart(6)} gzip, ${String(size.raw).padStart(6)} raw)  limit ${size.limit}  ${size.limitNote}\n`,
      )
    }
    return over ? 1 : 0
  }

  if (command === 'client') {
    const engines = (csv(flags.engines) ?? ['chromium', 'firefox', 'webkit']) as EngineName[]
    // `derived` is in the default set because the client-owned half of a derived value
    // is only observable in a real engine.
    const scenarios = (csv(flags.scenarios) ?? ['cart', 'feed', 'derived', 'composed']).map(scenarioById)
    let failed = false
    for (const engine of engines) {
      for (const s of scenarios) {
        const measured = await measureClientRuntime(s, engine)
        for (const check of measured.checks) {
          process.stdout.write(
            `${check.ok ? 'pass' : 'FAIL'}  ${engine.padEnd(9)} ${s.id.padEnd(6)} ${check.name}${check.ok || !check.detail ? '' : `\n      ${check.detail}`}\n`,
          )
          if (!check.ok) failed = true
        }
      }
    }
    return failed ? 1 : 0
  }

  if (command === 'verify') {
    const candidates = candidatesFrom(flags)
    const scenarios = (csv(flags.scenarios) ?? SCENARIOS.map((s) => s.id)).map(scenarioById)
    for (const s of scenarios) await compileScenario(s)
    const reports = await checkAll(scenarios, candidates)
    let failed = false
    for (const report of reports) {
      for (const check of report.checks) {
        process.stdout.write(`${check.ok ? 'pass' : 'FAIL'}  ${report.scenario.padEnd(8)} ${check.name}\n`)
        if (!check.ok) {
          failed = true
          if (check.detail) process.stdout.write(`      ${check.detail.replace(/\n/g, '\n      ')}\n`)
        }
      }
    }
    return failed ? 1 : 0
  }

  if (command !== 'run') {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`)
    return 2
  }

  const result = await run({
    candidates: candidatesFrom(flags),
    ...(csv(flags.axes) ? { axes: csv(flags.axes) as string[] } : {}),
    ...(csv(flags.scenarios) ? { scenarios: csv(flags.scenarios) as string[] } : {}),
    ...(flags.iterations ? { iterations: Number(flags.iterations) } : {}),
    ...(flags.warmup ? { warmup: Number(flags.warmup) } : {}),
    ...(flags.connection ? { connection: flags.connection as 'warm' | 'cold' } : {}),
    ...(flags.transport ? { transport: flags.transport as 'stream' | 'buffered' } : {}),
    ...(flags.latency ? { latencyMs: Number(flags.latency) } : {}),
    ...(flags.batches ? { batches: Number(flags.batches) } : {}),
    ...(flags.ops ? { opsPerBatch: Number(flags.ops) } : {}),
    ...(flags.engines ? { engines: csv(flags.engines) as EngineName[] } : {}),
    strict: flags['no-strict'] !== 'true',
  })

  const markdown = renderMarkdown(result)
  process.stdout.write(`${markdown}\n`)

  for (const axis of new Set(result.rows.map((r) => r.axis))) {
    const inAxis = result.rows.filter((r) => r.axis === axis)
    for (const scenario of new Set(inAxis.map((r) => r.scenario))) {
      for (const engine of new Set(inAxis.map((r) => r.engine ?? ''))) {
        const line = comparison(result, axis, scenario, engine)
        if (line) process.stdout.write(`${line}\n`)
      }
    }
  }

  const outDir = flags.out ?? 'results'
  await mkdir(outDir, { recursive: true })
  const stamp = result.environment.when.replace(/[:.]/g, '-')
  await writeFile(join(outDir, `${stamp}.json`), `${JSON.stringify(result, null, 2)}\n`)
  await writeFile(join(outDir, `${stamp}.md`), markdown)
  process.stdout.write(`\nwrote ${join(outDir, `${stamp}.md`)}\n`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  },
)
