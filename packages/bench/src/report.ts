import { AXES, axis as axisById } from './axes.ts'
import { ENGINE_PROXIES } from './measure/browser.ts'
import type { Row, RunResult } from './runner.ts'
import { separable, type Summary } from './stats.ts'

/** Adaptive precision: a surgical write and a render throughput differ by seven orders. */
function fmt(n: number | undefined, digits = 2): string {
  if (n === undefined || Number.isNaN(n)) return '—'
  const magnitude = Math.abs(n)
  if (magnitude >= 10_000) return Math.round(n).toLocaleString('en-US')
  if (magnitude === 0) return '0'
  if (magnitude < 0.001) return n.toExponential(1)
  if (magnitude < 0.1) return n.toFixed(4)
  if (magnitude < 1) return n.toFixed(3)
  return n.toFixed(digits)
}

function budgetVerdict(row: Row, axisId: string): string {
  const axis = axisById(axisId)
  if (!axis.budget || !row.summary) return ''
  const value = row.summary[axis.budget.statistic] as number
  const pass = axis.direction === 'lower-better' ? value <= axis.budget.value : value >= axis.budget.value
  return `${pass ? 'within' : 'over'} ${axis.budget.value} ${axis.unit} ${axis.budget.statistic}`
}

function extras(row: Row): string {
  if (!row.extra) return ''
  return Object.entries(row.extra)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? fmt(v) : v}`)
    .join(', ')
}

export function renderMarkdown(result: RunResult): string {
  const lines: string[] = []
  const env = result.environment
  const m = result.methodology

  lines.push('# Weft phase-zero benchmark')
  lines.push('')
  lines.push(
    'These numbers exist so the central premise can be falsified early. Every axis states the state of the art it is measured against and whether a win is expected, because one of the axes is expected to tie.',
  )
  lines.push('')
  lines.push('## Environment')
  lines.push('')
  lines.push('| Field | Value |')
  lines.push('| --- | --- |')
  lines.push(`| When | ${env.when} |`)
  lines.push(`| Node | ${env.node} (V8 ${env.v8}) |`)
  lines.push(`| Machine | ${env.cpu}, ${env.cores} cores, ${env.memoryGb} GB |`)
  lines.push(`| OS | ${env.platform} ${env.release} ${env.arch} |`)
  lines.push(`| Load average | ${env.loadAverage.join(', ') || 'n/a'} |`)
  lines.push(`| Commit | ${env.commit ?? 'not a git checkout'} |`)
  lines.push('')
  lines.push('## Methodology')
  lines.push('')
  lines.push(
    `HTTP axes: ${m.iterations} iterations after ${m.warmup} warmup requests, ${m.connection} connection, identity encoding. ` +
      `In-process axes: ${m.batches} batches of ${m.opsPerBatch} renders, one warmup batch, output length sunk so the work cannot be eliminated. ` +
      `Browser axes: ${m.browserIterations} iterations on ${m.engines.join(', ')}.`,
  )
  lines.push('')

  if (result.warnings.length) {
    lines.push('## Read this before quoting a number')
    lines.push('')
    for (const w of result.warnings) lines.push(`- ${w}`)
    lines.push('')
  }

  lines.push('## Form equivalence')
  lines.push('')
  lines.push(
    'A negotiated wire form is only safe if every form of a fragment produces identical bytes. These checks run before the measurements, and a failure aborts the run.',
  )
  lines.push('')
  lines.push('| Scenario | Check | Result |')
  lines.push('| --- | --- | --- |')
  for (const report of result.equivalence) {
    for (const check of report.checks) {
      lines.push(`| ${report.scenario} | ${check.name} | ${check.ok ? 'pass' : 'FAIL'}${check.detail ? ` — ${check.detail.split('\n')[0]}` : ''} |`)
    }
  }
  lines.push('')

  for (const axis of AXES) {
    const rows = result.rows.filter((r) => r.axis === axis.id)
    if (!rows.length) continue
    lines.push(`## ${axis.label}`)
    lines.push('')
    lines.push(`- Unit: ${axis.unit} (${axis.direction})`)
    lines.push(`- State of the art: ${axis.sota}`)
    lines.push(`- Available gap: ${axis.gap}`)
    lines.push(
      `- Expectation: ${axis.expectation === 'tie' ? 'tie — this axis is at the floor and is not a differentiator' : axis.expectation}`,
    )
    if (axis.budget) lines.push(`- Budget: ${axis.budget.value} ${axis.unit} ${axis.budget.statistic} (${axis.budget.note})`)
    if (axis.caveat) lines.push(`- Caveat: ${axis.caveat}`)
    lines.push('')

    const engines = [...new Set(rows.map((r) => r.engine ?? ''))]
    for (const engine of engines) {
      const group = rows.filter((r) => (r.engine ?? '') === engine)
      if (engine) {
        lines.push(`### ${engine}`)
        lines.push('')
      }
      lines.push('| Scenario | Candidate | p50 | p95 | n | Budget | Detail |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- |')
      for (const row of group) {
        if (row.status === 'measured' && row.summary) {
          lines.push(
            `| ${row.scenario} | ${row.candidate} | ${fmt(row.summary.p50)} | ${fmt(row.summary.p95)} | ${row.summary.n} | ${budgetVerdict(row, axis.id)} | ${extras(row)} |`,
          )
        } else {
          lines.push(`| ${row.scenario} | ${row.candidate} | not measured | | | | ${row.reason ?? ''}${row.extra ? ` (${extras(row)})` : ''} |`)
        }
      }
      lines.push('')
    }
  }

  lines.push('## Engines, and what they stand for')
  lines.push('')
  lines.push('| Engine | Stands for | Is not |')
  lines.push('| --- | --- | --- |')
  for (const engine of m.engines) {
    const proxy = ENGINE_PROXIES[engine as keyof typeof ENGINE_PROXIES]
    if (proxy) lines.push(`| ${engine} | ${proxy.standsFor} | ${proxy.notA} |`)
  }
  lines.push('')

  lines.push('## Reproducing this')
  lines.push('')
  lines.push('```')
  lines.push(
    `node packages/bench/src/cli.ts run --iterations ${m.iterations} --connection ${m.connection} --transport ${m.transport} --latency ${m.latencyMs} --engines ${m.engines.join(',')}`,
  )
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

function verb(unit: string, direction: 'lower-better' | 'higher-better'): string {
  if (unit === 'bytes') return 'smaller'
  if (direction === 'higher-better') return 'higher'
  return 'faster'
}

/**
 * Comparisons are made within one engine. Ranking a chromium number against a webkit one
 * is the cross-engine aggregation this harness exists to refuse.
 */
export function comparison(
  result: RunResult,
  axisId: string,
  scenarioId: string,
  engine = '',
): string | null {
  const rows = result.rows.filter(
    (r) => r.axis === axisId && r.scenario === scenarioId && r.status === 'measured' && (r.engine ?? '') === engine,
  )
  if (rows.length < 2) return null
  const axis = axisById(axisId)
  const best = rows.reduce((a, b) => {
    const av = (a.summary as Summary).p50
    const bv = (b.summary as Summary).p50
    return axis.direction === 'lower-better' ? (av <= bv ? a : b) : av >= bv ? a : b
  })
  const others = rows.filter((r) => r !== best)
  return others
    .map((r) => {
      const bv = (best.summary as Summary).p50
      const rv = (r.summary as Summary).p50
      if (bv === 0 || rv === 0 || !Number.isFinite(bv) || !Number.isFinite(rv)) {
        return `${axisId}/${scenarioId}${engine ? ` on ${engine}` : ''}: ${best.candidate} measured at or below this engine's clock resolution — no ratio`
      }
      if (!separable(best.summary as Summary, r.summary as Summary)) {
        return `${axisId}/${scenarioId}${engine ? ` on ${engine}` : ''}: ${best.candidate} and ${r.candidate} are not separable at this sample size — no claim`
      }
      const factor = axis.direction === 'lower-better' ? rv / bv : bv / rv
      const where = `${axisId}/${scenarioId}${engine ? ` on ${engine}` : ''}`
      return `${best.candidate} is ${factor.toFixed(2)}x ${verb(axis.unit, axis.direction)} than ${r.candidate}, ${where}`
    })
    .join('\n')
}
