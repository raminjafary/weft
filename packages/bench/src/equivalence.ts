import { type DeltaPayload, type Values, applyDelta, render } from '../../ir/src/index.ts'
import type { Candidate } from './candidate.ts'
import { segmentsCandidate } from './candidates/segments.ts'
import { compileScenario, withRows } from './compiled.ts'
import type { Scenario } from './workloads/index.ts'

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface EquivalenceReport {
  scenario: string
  ok: boolean
  checks: Check[]
}

const decoder = new TextDecoder()

function firstDifference(a: Uint8Array, b: Uint8Array): string {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      const from = Math.max(0, i - 40)
      return `byte ${i} of ${a.length}/${b.length}\n  a: ${JSON.stringify(decoder.decode(a.subarray(from, i + 40)))}\n  b: ${JSON.stringify(decoder.decode(b.subarray(from, i + 40)))}`
    }
  }
  return `identical for ${len} bytes, lengths differ: ${a.length} vs ${b.length}`
}

/**
 * Differential testing is not optional here: negotiated wire forms are only safe if
 * every form of a fragment produces identical bytes. The runner refuses to publish
 * numbers for a scenario whose forms disagree.
 */
export async function checkScenario(scenario: Scenario, candidates: Candidate[]): Promise<EquivalenceReport> {
  const checks: Check[] = []
  const compiled = await compileScenario(scenario)

  const values = scenario.values()
  const rows = scenario.rows()
  const rooted: Values = withRows(compiled, values, rows)

  const reference = segmentsCandidate.render?.(scenario, values, rows)
  if (!reference) throw new Error('E_NO_REFERENCE_RENDER')

  for (const candidate of candidates) {
    if (candidate.id === segmentsCandidate.id || !candidate.render) continue
    const actual = candidate.render(scenario, values, rows)
    const ok = actual.length === reference.length && actual.every((b, i) => b === reference[i])
    checks.push({
      name: `html bytes: segments vs ${candidate.id}`,
      ok,
      ...(ok ? {} : { detail: firstDifference(reference, actual) }),
    })
  }

  if (compiled.root.forms.includes('delta') && compiled.rowBinding) {
    const nextRows = scenario.transition(rows)
    const nextValues: Values = withRows(compiled, values, nextRows)
    const expected = render(compiled.root, nextValues, compiled.resolve)
    const delta = JSON.parse(
      decoder.decode(segmentsCandidate.updateForms?.(scenario, values, rows, nextRows).delta as Uint8Array),
    ) as DeltaPayload
    const reconstructed = render(compiled.root, applyDelta(rooted, delta), compiled.resolve)
    const ok = reconstructed.length === expected.length && reconstructed.every((b, i) => b === expected[i])
    checks.push({
      name: 'delta applied to the base render reproduces the html bytes',
      ok,
      ...(ok ? {} : { detail: firstDifference(expected, reconstructed) }),
    })
    checks.push({
      name: 'delta carries fewer entries than the full value set',
      ok: Object.keys(delta.changed).length < Object.keys(nextValues).length + nextRows.length * 4,
      detail: `${Object.keys(delta.changed).length} changed paths`,
    })
  }

  return { scenario: scenario.id, ok: checks.every((c) => c.ok), checks }
}

/**
 * The measured path is the served one, and a streaming server assembles its response
 * separately from the in-process renderer. Byte equality in memory does not imply byte
 * equality on the wire, so both are checked.
 */
export async function checkServed(scenario: Scenario, candidates: Candidate[]): Promise<Check[]> {
  const checks: Check[] = []
  const servers = candidates.filter((c) => c.serve && !c.thirdParty)
  if (servers.length < 2) return checks

  const handles = await Promise.all(servers.map((c) => c.serve!(scenario)))
  try {
    const bodies = await Promise.all(
      handles.map(async (h) => new Uint8Array(await (await fetch(h.url)).arrayBuffer())),
    )
    const reference = bodies[0] as Uint8Array
    servers.forEach((candidate, i) => {
      if (i === 0) return
      const actual = bodies[i] as Uint8Array
      const ok = actual.length === reference.length && actual.every((b, j) => b === reference[j])
      checks.push({
        name: `served bytes over http: ${servers[0]?.id} vs ${candidate.id}`,
        ok,
        ...(ok ? {} : { detail: firstDifference(reference, actual) }),
      })
    })
  } finally {
    await Promise.all(handles.map((h) => h.close()))
  }
  return checks
}

export async function checkAll(scenarios: Scenario[], candidates: Candidate[]): Promise<EquivalenceReport[]> {
  const reports: EquivalenceReport[] = []
  for (const scenario of scenarios) {
    const report = await checkScenario(scenario, candidates)
    const served = await checkServed(scenario, candidates)
    reports.push({
      ...report,
      checks: [...report.checks, ...served],
      ok: report.ok && served.every((c) => c.ok),
    })
  }
  return reports
}
