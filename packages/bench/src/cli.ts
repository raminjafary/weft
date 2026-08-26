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
import { fillerSize } from '@weft/kernel'
import { DELAYS, measureSlots, probeIncrementalDsd } from './measure/slots.ts'
import { checkAll } from './equivalence.ts'
import { measureClientRuntime } from './measure/client-runtime.ts'
import { fileURLToPath } from 'node:url'
import { measureChannel } from './measure/channel.ts'
import { formatSharedDelta, measureSharedDelta } from './measure/shared-delta.ts'
import { formatL0, measureL0 } from './measure/l0.ts'
import { formatDecode, measureDecode } from './measure/decode.ts'
import { formatNavigation, measureNavigation } from './measure/navigation.ts'
import { compileScenario } from './compiled.ts'
import { renderMarkdown, comparison } from './report.ts'
import { run } from './runner.ts'
import { SCENARIOS, scenario as scenarioById } from './workloads/index.ts'
import { stringify } from '@weft/ir'
import { DEVICE_ENGINES, ENGINES_UNAVAILABLE, LOCAL_ENGINES, type EngineName } from './measure/browser.ts'
import { laneFor, lanes, loadDevices, probeDevice, registerDevices } from './measure/device.ts'

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

/**
 * Engine names, with the ones this harness cannot reach refused by name.
 *
 * `spec/baseline/devices.md` says no claim about iOS is honest until it runs on a device, and until
 * now that was a paragraph. Asking for `--engines ios` fell through to Playwright and failed with a
 * message about a browser type — which reads like a missing dependency rather than a missing device.
 * It refuses here instead, saying what is actually absent.
 *
 * `--devices` is what makes the refusal answerable rather than final: a device named there is
 * registered before this runs, so `ios` stops being a name with nothing behind it. Without one the
 * refusal is unchanged, which is the point — the gate is the hardware, not the vocabulary.
 */
function enginesFrom(value: string | undefined, fallback: EngineName[]): EngineName[] {
  const asked = csv(value) ?? fallback
  for (const engine of asked) {
    if (laneFor(engine as EngineName)) continue
    const missing = ENGINES_UNAVAILABLE[engine]
    if (missing) {
      throw new Error(
        `E_NO_DEVICE_ENGINE: '${engine}' needs ${missing}. Point --devices at one and run ` +
          `'weft-bench devices' to check it answers, or run --engines ${LOCAL_ENGINES.join(',')} and ` +
          `read the proxy table in the report: a webkit number is never an iOS number`,
      )
    }
    if (!LOCAL_ENGINES.includes(engine as EngineName)) {
      throw new Error(
        `E_UNKNOWN_ENGINE: ${engine}. known: ${[...LOCAL_ENGINES, ...DEVICE_ENGINES].join(', ')}`,
      )
    }
  }
  return asked as EngineName[]
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
  channel   which binding a real browser opens, and what it does when the upgrade is refused
  budget    bundle each entry and measure it against its byte budget
  slots     stream a route in both orders, and probe incremental shadow DOM
  deltas    shared vs per-connection delta computation, the phase 6 claim
  l0        a document served from the build against the same document rendered
  nav       a staged click against the same click handed back to the browser
  decode    frames decoded on the main thread against the same frames decoded in a worker
  devices   list the devices --devices names, and whether each driver answers
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
  --bandwidth N     injected link rate in kbps each way; required for any bytes-on-the-wire claim
                    1600 is a slow 3G downlink, 400 a bad one, 0 an infinitely fast link
  --loss N          injected per-packet loss as a percentage; a hole stalls everything behind it
  --batches N       in-process timing batches (default 25)
  --ops N           renders per batch (default 200)
  --clients N       clients in the deltas comparison (default 1000)
  --app DIR         the application l0 and nav measure (default demo)
  --route PATTERN   which document l0 measures (default the largest one)
  --from PATH       the page nav starts every click from (default /)
  --to PATHS        which links nav clicks (default every internal link on --from)
  --engines         chromium,firefox,webkit (browser axes; requires playwright)
                    webkit is the closest proxy for an iOS webview and is never an iOS number.
                    ios and android are refused unless --devices names one: the missing thing
                    is hardware, and the lane that drives it is config
  --devices FILE    JSON array of device descriptors, or $WEFT_BENCH_DEVICES. android goes over
                    cdp (adb forward to the WebView devtools socket); ios over webdriver
                    (Appium and XCUITest). Run the 'devices' command to check one answers
  --out DIR         where to write the report (default results/)
  --no-strict       measure even if the wire forms disagree
`

async function main(): Promise<number> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2))
  registerDevices(loadDevices(flags.devices))

  if (command === 'help' || flags.help) {
    process.stdout.write(HELP)
    return 0
  }

  if (command === 'devices') {
    const configured = lanes()
    if (!configured.length) {
      process.stdout.write(
        'no devices configured.\n\n' +
          '  --devices FILE, or $WEFT_BENCH_DEVICES, is a JSON array like:\n\n' +
          '  [{ "id": "pixel-6a", "label": "Pixel 6a, WebView 121", "engine": "android",\n' +
          '     "transport": "cdp", "endpoint": "http://127.0.0.1:9222" },\n' +
          '   { "id": "iphone-se-3", "label": "iPhone SE 3, iOS 17.4", "engine": "ios",\n' +
          '     "transport": "webdriver", "endpoint": "http://127.0.0.1:4723",\n' +
          '     "context": "WEBVIEW_1", "capabilities": { "platformName": "iOS" } }]\n\n' +
          '  Android: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>, and\n' +
          '  adb reverse tcp:<port> tcp:<port> so the device can reach a server on this machine.\n' +
          '  iOS: appium with the XCUITest driver, and a tunnel for the same reason.\n',
      )
      return 0
    }
    let failed = false
    for (const lane of configured) {
      const probe = await probeDevice(lane.device)
      if (!probe.ok) failed = true
      const can = Object.entries(lane.supports)
        .filter(([, yes]) => yes)
        .map(([name]) => name)
      const cannot = Object.entries(lane.supports)
        .filter(([, yes]) => !yes)
        .map(([name]) => name)
      process.stdout.write(
        `${probe.ok ? 'up  ' : 'DOWN'}  ${lane.device.engine.padEnd(8)} ${lane.device.id.padEnd(18)} ` +
          `${lane.device.transport.padEnd(10)} ${lane.device.endpoint}\n` +
          `      ${lane.device.label}\n` +
          `      ${probe.detail}\n` +
          `      carries ${can.join(', ') || 'nothing'}${cannot.length ? `; cannot ${cannot.join(', ')}` : ''}\n` +
          `      reached at ${lane.device.reachHost ?? '127.0.0.1 (assumes a reverse tunnel)'}\n`,
      )
    }
    return failed ? 1 : 0
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
    const engines = enginesFrom(flags.engines, ['chromium', 'firefox', 'webkit'])
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

  if (command === 'deltas') {
    const clients = Number(flags.clients ?? 1_000)
    const scenarios = (csv(flags.scenarios) ?? ['cart', 'feed']).map(scenarioById)
    for (const s of scenarios) {
      const report = await measureSharedDelta(s, clients)
      process.stdout.write(`${formatSharedDelta(report)}\n`)
    }
    process.stdout.write(
      '\nPhoenix is not running here. The per-connection figure is a real per-connection differ\n' +
        'over the same templates and the same transition, so what is measured is the architectural\n' +
        'difference and not any constant factor of a LiveView deployment.\n',
    )
    return 0
  }

  if (command === 'l0') {
    const report = await measureL0({
      root: flags.app ?? positional[0] ?? 'demo',
      iterations: Number(flags.iterations ?? 200),
      warmup: Number(flags.warmup ?? 30),
      ...(flags.route ? { path: flags.route } : {}),
    })
    process.stdout.write(formatL0(report))
    return 0
  }

  if (command === 'nav') {
    const engines = enginesFrom(flags.engines, ['chromium'])
    for (const engine of engines) {
      const report = await measureNavigation({
        root: flags.app ?? positional[0] ?? 'demo',
        engine,
        iterations: Number(flags.iterations ?? 10),
        ...(flags.from ? { from: flags.from } : {}),
        ...(csv(flags.to) ? { to: csv(flags.to) as string[] } : {}),
        ...(flags.latency ? { latencyMs: Number(flags.latency) } : {}),
        ...(flags.bandwidth ? { bandwidthKbps: Number(flags.bandwidth) } : {}),
        ...(flags.loss ? { lossPercent: Number(flags.loss) } : {}),
      })
      process.stdout.write(formatNavigation(report))
    }
    return 0
  }

  if (command === 'decode') {
    const engines = enginesFrom(flags.engines, ['chromium'])
    for (const engine of engines) {
      const measured = await measureDecode(engine, Number(flags.rows ?? 400), Number(flags.iterations ?? 40))
      process.stdout.write(formatDecode(measured))
    }
    return 0
  }

  if (command === 'channel') {
    const engines = enginesFrom(flags.engines, ['chromium', 'firefox', 'webkit'])
    const root = fileURLToPath(new URL('../../../demo/', import.meta.url))
    let failed = false
    for (const engine of engines) {
      const measured = await measureChannel(root, engine)
      for (const check of measured.checks) {
        process.stdout.write(
          `${check.ok ? 'pass' : 'FAIL'}  ${engine.padEnd(9)} ${check.name}${check.detail ? `\n      ${check.detail}` : ''}\n`,
        )
        if (!check.ok) failed = true
      }
    }
    return failed ? 1 : 0
  }

  if (command === 'client') {
    const engines = enginesFrom(flags.engines, ['chromium', 'firefox', 'webkit'])
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
    ...(flags.bandwidth ? { bandwidthKbps: Number(flags.bandwidth) } : {}),
    ...(flags.loss ? { lossPercent: Number(flags.loss) } : {}),
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
    const message = error instanceof Error ? error.message : String(error)
    // A named refusal is the message and nothing else. A stack under `E_NO_DEVICE_ENGINE: … needs a
    // real iOS device` says the harness is broken, when what it is doing is declining to guess.
    process.stderr.write(
      /^E_[A-Z_]+/.test(message) ? `\n  ${message}\n\n` : `${(error as Error).stack ?? message}\n`,
    )
    process.exit(1)
  },
)
