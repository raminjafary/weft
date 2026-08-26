import { AXES, type Axis, axis as axisById } from './axes.ts'
import type { Candidate } from './candidate.ts'
import { checkAll, type EquivalenceReport } from './equivalence.ts'
import { environment, type Environment } from './env.ts'
import { measureBytes } from './measure/bytes.ts'
import { ENGINE_PROXIES, enginesUnrunnable, type EngineName } from './measure/browser.ts'
import { laneFor } from './measure/device.ts'
import { measureClientRuntime } from './measure/client-runtime.ts'
import { measureRepeatVisit } from './measure/repeat-visit.ts'
import { measureHttp } from './measure/http.ts'
import { describeLink, withLink, type LinkOptions } from './measure/link.ts'
import { measureThroughput, opsPerSecond } from './measure/throughput.ts'
import { compileScenario, compiledFor } from './compiled.ts'
import { summarize, type Summary } from './stats.ts'
import { scenario as scenarioById, type Scenario } from './workloads/index.ts'

export type RowStatus = 'measured' | 'unavailable'

/** The shaped link a run's HTTP axes go through, from the flags that describe it. */
function link(m: Pick<Methodology, 'latencyMs' | 'bandwidthKbps' | 'lossPercent'>): LinkOptions {
  return {
    rttMs: m.latencyMs,
    ...(m.bandwidthKbps ? { kbps: m.bandwidthKbps } : {}),
    ...(m.lossPercent ? { lossPercent: m.lossPercent } : {}),
  }
}

export interface Row {
  axis: string
  scenario: string
  candidate: string
  engine?: string
  unit: string
  status: RowStatus
  reason?: string
  summary?: Summary
  extra?: Record<string, number | string>
}

export interface Methodology {
  iterations: number
  warmup: number
  connection: 'warm' | 'cold'
  transport: 'stream' | 'buffered'
  latencyMs: number
  bandwidthKbps: number
  lossPercent: number
  batches: number
  opsPerBatch: number
  browserIterations: number
  engines: EngineName[]
}

export interface RunResult {
  environment: Environment
  methodology: Methodology
  equivalence: EquivalenceReport[]
  rows: Row[]
  warnings: string[]
}

export interface RunOptions {
  axes?: string[]
  scenarios?: string[]
  candidates: Candidate[]
  iterations?: number
  warmup?: number
  connection?: 'warm' | 'cold'
  transport?: 'stream' | 'buffered'
  latencyMs?: number
  bandwidthKbps?: number
  lossPercent?: number
  batches?: number
  opsPerBatch?: number
  browserIterations?: number
  engines?: EngineName[]
  /** Refuse to report numbers when the forms of a fragment disagree. On by default. */
  strict?: boolean
}

export async function run(options: RunOptions): Promise<RunResult> {
  const methodology: Methodology = {
    iterations: options.iterations ?? 200,
    warmup: options.warmup ?? 30,
    connection: options.connection ?? 'warm',
    transport: options.transport ?? 'stream',
    latencyMs: options.latencyMs ?? 0,
    bandwidthKbps: options.bandwidthKbps ?? 0,
    lossPercent: options.lossPercent ?? 0,
    batches: options.batches ?? 25,
    opsPerBatch: options.opsPerBatch ?? 200,
    browserIterations: options.browserIterations ?? 5,
    engines: options.engines ?? ['chromium', 'firefox', 'webkit'],
  }

  const axes: Axis[] = (options.axes ?? AXES.map((a) => a.id)).map(axisById)
  const scenarios: Scenario[] = (options.scenarios ?? ['shell', 'cart', 'feed']).map(scenarioById)
  const candidates = options.candidates
  const warnings: string[] = []
  const rows: Row[] = []

  for (const scenario of scenarios) await compileScenario(scenario)

  const equivalence = await checkAll(scenarios, candidates)
  const broken = equivalence.filter((r) => !r.ok)
  if (broken.length && (options.strict ?? true)) {
    throw new Error(
      `E_FORMS_DISAGREE: ${broken.map((b) => b.scenario).join(', ')}. Wire forms must produce identical bytes before any number is published.\n` +
        broken
          .flatMap((b) =>
            b.checks.filter((c) => !c.ok).map((c) => `  ${b.scenario}: ${c.name}\n    ${c.detail ?? ''}`),
          )
          .join('\n'),
    )
  }

  const comparable = candidates.filter((c) => c.render || c.serve)
  if (comparable.length < 2) {
    warnings.push('only one candidate ran: absolute numbers only, no comparative claim is supported')
  }
  if (methodology.engines.length < 2) {
    warnings.push(
      `browser axes ran on ${methodology.engines.join(', ') || 'no engine'}: a single-engine result is not a cross-engine claim`,
    )
  }
  for (const engine of methodology.engines) {
    const lane = laneFor(engine)
    if (!lane) continue
    warnings.push(
      `${engine} is a device lane: ${lane.device.label} (${lane.device.id}) over ${lane.device.transport}. ` +
        `This is a number about that device and no other, and it is not a number about ${engine} as a platform`,
    )
  }
  if (methodology.engines.includes('webkit')) {
    warnings.push(
      `webkit stands for ${ENGINE_PROXIES.webkit.standsFor}, but it is not ${ENGINE_PROXIES.webkit.notA}: do not publish a webkit number as an iOS number`,
    )
  }
  if (methodology.latencyMs === 0 && axes.some((a) => a.needs === 'http')) {
    warnings.push(
      'no injected latency: loopback has no network in it, so an early flush cannot be distinguished from a late one. Run --latency 40 or higher for a shell-TTFB claim',
    )
  }
  if (methodology.bandwidthKbps === 0 && axes.some((a) => a.needs === 'http')) {
    warnings.push(
      'no injected bandwidth: the link is infinitely fast, so a byte difference costs nothing here. A bytes-on-the-wire claim needs --bandwidth; 1600 kbps is a slow 3G downlink and 400 kbps is a bad one',
    )
  }
  if (link(methodology).rttMs > 0 || methodology.bandwidthKbps > 0 || methodology.lossPercent > 0) {
    warnings.push(
      `injected link: ${describeLink(link(methodology))}. Serialization, slow start (IW10, doubling once per RTT) and in-order loss recovery are modelled. The TCP handshake, congestion avoidance after the first loss, ack clocking, the receive window and competing flows are not — every one of those omissions makes a real link worse than this one, so a number here understates it`,
    )
  }
  if (scenarios.every((s) => !s.slowMs) && axes.some((a) => a.needs === 'http')) {
    warnings.push(
      'every scenario resolves its data instantly: the precomputed-shell claim is about a route whose data is slow. Include the slow-feed scenario',
    )
  }
  if (methodology.transport === 'buffered') {
    warnings.push(
      'transport is buffered: this run reproduces a host app supplying the document through WKURLSchemeHandler or shouldInterceptRequest, so nothing was flushed early and no HTTP layer is involved on a real device',
    )
  } else {
    warnings.push(
      'transport is stream: these numbers do not cover webviews whose host app intercepts the request. Run --transport buffered as a separate, first-class mode',
    )
  }
  const load = environment().loadAverage[0] ?? 0
  if (load > 2) warnings.push(`machine load average was ${load} at start: treat small differences as noise`)

  for (const axis of axes) {
    for (const scenario of scenarios) {
      if (axis.needs === 'in-process') {
        for (const candidate of candidates) rows.push(...inProcess(axis, scenario, candidate, methodology))
      } else if (axis.needs === 'http') {
        for (const candidate of candidates)
          rows.push(...(await overHttp(axis, scenario, candidate, methodology)))
      } else {
        for (const candidate of candidates)
          rows.push(...(await inBrowser(axis, scenario, candidate, methodology)))
      }
    }
  }

  return { environment: environment(), methodology, equivalence, rows, warnings }
}

function unavailable(
  axis: Axis,
  scenario: Scenario,
  candidate: Candidate,
  reason: string,
  engine?: string,
): Row {
  return {
    axis: axis.id,
    scenario: scenario.id,
    candidate: candidate.id,
    unit: axis.unit,
    status: 'unavailable',
    reason,
    ...(engine ? { engine } : {}),
  }
}

function inProcess(axis: Axis, scenario: Scenario, candidate: Candidate, m: Methodology): Row[] {
  if (axis.id === 'server-throughput') {
    if (!candidate.render) {
      return [
        unavailable(axis, scenario, candidate, candidate.unsupported?.[axis.id] ?? 'no in-process render'),
      ]
    }
    const values = scenario.values()
    const rows = scenario.rows()
    const result = measureThroughput(() => candidate.render!(scenario, values, rows), {
      batches: m.batches,
      opsPerBatch: m.opsPerBatch,
      warmupOps: m.opsPerBatch,
    })
    const summary = summarize(result.samples.map(opsPerSecond))
    return [
      {
        axis: axis.id,
        scenario: scenario.id,
        candidate: candidate.id,
        unit: axis.unit,
        status: 'measured',
        summary,
        extra: {
          nsPerRender: Math.round(summarize(result.samples).p50),
          bytesPerRender: result.bytesPerRender,
          renders: result.totalOps,
        },
      },
    ]
  }

  if (axis.id === 'update-bytes') {
    if (!candidate.updateForms) {
      return [
        unavailable(axis, scenario, candidate, candidate.unsupported?.[axis.id] ?? 'no update payloads'),
      ]
    }
    if (!compiledFor(scenario).rowBinding) {
      return [unavailable(axis, scenario, candidate, 'scenario has no updatable region')]
    }
    const values = scenario.values()
    const prev = scenario.rows()
    const next = scenario.transition(prev)
    const payloads = candidate.updateForms(scenario, values, prev, next)
    const sizes = measureBytes(payloads)
    const out: Row[] = sizes.map((s) => ({
      axis: axis.id,
      scenario: scenario.id,
      candidate: `${candidate.id}:${s.form}`,
      unit: axis.unit,
      status: 'measured' as RowStatus,
      summary: summarize([s.raw]),
      extra: { gzip: s.gzip, brotli: s.brotli },
    }))
    for (const form of ['delta']) {
      if (!payloads[form]) {
        out.push(
          unavailable(
            axis,
            scenario,
            { ...candidate, id: `${candidate.id}:${form}` },
            candidate.unsupported?.[`${axis.id}:${form}`] ?? `${form} form not offered for this template`,
          ),
        )
      }
    }
    return out
  }

  return [unavailable(axis, scenario, candidate, `axis ${axis.id} is not an in-process measurement`)]
}

async function overHttp(
  axis: Axis,
  scenario: Scenario,
  candidate: Candidate,
  m: Methodology,
): Promise<Row[]> {
  if (!candidate.serve) {
    return [
      unavailable(
        axis,
        scenario,
        candidate,
        candidate.unsupported?.[axis.id] ?? 'candidate does not serve HTTP',
      ),
    ]
  }
  const handle = await candidate.serve(scenario, { transport: m.transport })
  const shaped = link(m)
  const proxy =
    shaped.rttMs > 0 || (shaped.kbps ?? 0) > 0 || (shaped.lossPercent ?? 0) > 0
      ? await withLink(handle.url, shaped)
      : null
  try {
    const samples = await measureHttp(proxy?.url ?? handle.url, {
      iterations: m.iterations,
      warmup: m.warmup,
      connection: m.connection,
    })
    return [
      {
        axis: axis.id,
        scenario: scenario.id,
        candidate: candidate.id,
        unit: axis.unit,
        status: 'measured',
        summary: summarize(samples.map((s) => s.ttfbBody)),
        extra: {
          headersP50: round(summarize(samples.map((s) => s.ttfbHeaders)).p50),
          ttlbP50: round(summarize(samples.map((s) => s.ttlb)).p50),
          bytes: samples[0]?.bytes ?? 0,
          connection: m.connection,
          transport: m.transport,
          rtt: m.latencyMs,
          ...(m.bandwidthKbps ? { kbps: m.bandwidthKbps } : {}),
          ...(m.lossPercent ? { lossPercent: m.lossPercent } : {}),
          ...(scenario.slowMs ? { queryMs: scenario.slowMs } : {}),
        },
      },
    ]
  } finally {
    await proxy?.close()
    await handle.close()
  }
}

async function inBrowser(
  axis: Axis,
  scenario: Scenario,
  candidate: Candidate,
  m: Methodology,
): Promise<Row[]> {
  if (axis.id === 'repeat-visit-startup') {
    if (candidate.id !== 'segments') {
      return [
        unavailable(
          axis,
          scenario,
          candidate,
          'measured once under the segments candidate; residency is a property of the runtime',
        ),
      ]
    }
    const unrunnable = await enginesUnrunnable(m.engines)
    if (unrunnable) return [unavailable(axis, scenario, candidate, unrunnable)]

    const out: Row[] = []
    for (const engine of m.engines) {
      const measured = await measureRepeatVisit(scenario, engine, Math.max(5, m.browserIterations))
      const stillSending = measured.repeat.some((v) => v.templatesSent > 0)
      if (stillSending) {
        out.push(
          unavailable(
            axis,
            scenario,
            candidate,
            'the repeat visit was still sent templates, so nothing was resident: the claim cannot be measured',
            engine,
          ),
        )
        continue
      }
      for (const [label, visits] of [
        ['first visit', measured.cold],
        ['repeat visit', measured.repeat],
      ] as const) {
        out.push({
          axis: axis.id,
          scenario: scenario.id,
          candidate: label,
          engine,
          unit: axis.unit,
          status: 'measured',
          summary: summarize(visits.map((v) => v.bootMs)),
          extra: {
            engineVersion: measured.engineVersion,
            templatesSent: visits[0]?.templatesSent ?? 0,
            frameBytes: visits[0]?.frameBytes ?? 0,
            storeMs: round(summarize(visits.map((v) => v.putMs)).p50),
            openMs: round(summarize(visits.map((v) => v.openMs)).p50),
            adoptMs: round(summarize(visits.map((v) => v.adoptMs)).p50),
            interactiveMs: round(summarize(visits.map((v) => v.interactive)).p50),
            storage: visits[0]?.durableStorage ? 'indexeddb' : 'memory',
          },
        })
      }
    }
    return out
  }

  if (axis.id === 'client-work' || axis.id === 'tti-server-rendered' || axis.id === 'isolated-dom-update') {
    // These are properties of the IR and its runtime, not of a server candidate, so they
    // are measured once rather than per candidate.
    if (candidate.id !== 'segments') {
      return [
        unavailable(
          axis,
          scenario,
          candidate,
          'measured once under the segments candidate; this axis is a property of the runtime',
        ),
      ]
    }
    const unrunnable = await enginesUnrunnable(m.engines)
    if (unrunnable) return [unavailable(axis, scenario, candidate, unrunnable)]

    const wanted: Record<string, string[]> = {
      'client-work': ['parse', 'delta', 'patch'],
      'tti-server-rendered': ['adopt'],
      'isolated-dom-update': ['write', 'derive'],
    }
    const labels: Record<string, string> = {
      parse: 'html form, parsed',
      delta: 'delta form, applied surgically',
      patch: 'patch form, applied structurally',
      adopt: 'adopt a server-rendered region',
      write: 'one signal write to one node',
      derive: 'one signal write to one node, through a derived value',
    }

    const out: Row[] = []
    for (const engine of m.engines) {
      const measured = await measureClientRuntime(scenario, engine)
      const failed = measured.checks.filter((c) => !c.ok)
      if (failed.length) {
        out.push({
          ...unavailable(
            axis,
            scenario,
            candidate,
            `the client runtime failed its own conformance checks on ${engine}: ${failed.map((c) => c.name).join('; ')}`,
            engine,
          ),
        })
        continue
      }
      for (const key of wanted[axis.id] ?? []) {
        const samples = measured.timings[key]
        if (!samples?.length) continue
        out.push({
          axis: axis.id,
          scenario: scenario.id,
          candidate: labels[key] ?? key,
          engine,
          unit: axis.unit,
          status: 'measured',
          summary: summarize(samples),
          extra: { engineVersion: measured.engineVersion },
        })
      }
    }
    return out
  }

  return [unavailable(axis, scenario, candidate, `axis ${axis.id} has no browser measurement wired`)]
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
