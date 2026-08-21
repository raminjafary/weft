import { explain } from '@weft/ir'
import { criticalPath, type DagNode, type ResolvedKey, schedule } from '@weft/kernel'
import type { Plan } from './dsl.ts'
import { validatePlan, type SlotFacts } from './validate.ts'

/**
 * `weft why` — the critical path as a first-class concept rather than something you
 * reconstruct from a flame graph.
 *
 * Two rules apply to what this prints. A timing that was not measured is labelled as an
 * estimate, because a report that quietly mixes the two is worse than one that has no
 * numbers at all. And every budget breach and every degradation is listed: the point of a
 * budget is not only to contain damage, it is to tell you the damage happened.
 */
export interface WhyInput {
  plan: Plan
  facts: Record<string, SlotFacts>
  /** Measured milliseconds per slot. Absent slots are reported as unmeasured. */
  timings?: Record<string, number>
  /** Keys resolved for one concrete request, when this is being asked at runtime. */
  resolved?: Record<string, ResolvedKey>
}

export interface WhyReport {
  text: string
  waves: string[][]
  criticalPath: string[]
  criticalMs: number
  sequentialMs: number
  measured: boolean
}

export function why(input: WhyInput): WhyReport {
  const { plan, facts, timings } = input
  const nodes: DagNode[] = plan.slots.map((s) => ({
    name: s.name,
    needs: s.needs,
    prio: s.prio,
    executor: s.executor,
    ...(timings?.[s.name] !== undefined ? { ms: timings[s.name] as number } : {}),
  }))

  const { waves, width } = schedule(nodes)
  const path = criticalPath(nodes)
  const measured = plan.slots.every((s) => timings?.[s.name] !== undefined)

  const lines: string[] = []
  lines.push(
    `fragment DAG   ${plan.slots.length} slots | ${waves.length} waves | widest ${width} | ceiling ${plan.maxConcurrency}`,
  )
  if (!measured) lines.push('               timings are unmeasured; run under the harness for real numbers')
  lines.push('')

  waves.forEach((wave, index) => {
    wave.forEach((name, i) => {
      const spec = plan.slots.find((s) => s.name === name)
      const fact = facts[spec?.fragment ?? name]
      const ms = timings?.[name]
      const head = i === 0 ? `wave ${index}`.padEnd(9) : ' '.repeat(9)
      const cost = ms === undefined ? '     ?  ' : `${ms.toFixed(1)}ms`.padStart(8)
      const note = fact ? explain(fact.effects) : 'no compiled fragment'
      const where = spec && spec.executor !== 'inline' ? `  ${spec.executor}` : ''
      lines.push(`${head}${name.padEnd(18)}${cost}   ${note}${where}`)
    })
  })

  lines.push('')
  if (path.path.length) {
    lines.push(`critical path   ${path.path.join(' -> ')}   =  ${path.ms.toFixed(1)}ms`)
    lines.push('                this, not the sum, is the floor for a complete page.')
    lines.push(
      `                a sequential root-to-leaf walk would have been ${path.sequentialMs.toFixed(1)}ms.`,
    )
  }

  if (input.resolved) {
    lines.push('')
    lines.push('keys')
    for (const name of Object.keys(input.resolved).sort()) {
      const key = input.resolved[name] as ResolvedKey
      lines.push(`  ${name.padEnd(18)}${key.key ?? 'uncacheable'}   ${key.reason}`)
    }
  }

  const diagnostics = validatePlan(plan, { facts })
  if (diagnostics.errors.length || diagnostics.warnings.length) {
    lines.push('')
    for (const issue of [...diagnostics.errors, ...diagnostics.warnings]) {
      lines.push(`  ${issue.code}${issue.slot ? ` [${issue.slot}]` : ''}: ${issue.message}`)
    }
  }

  const hoistable = suggest(plan, path.path)
  if (hoistable) {
    lines.push('')
    lines.push(`suggestion      ${hoistable}`)
  }

  return {
    text: lines.join('\n'),
    waves,
    criticalPath: path.path,
    criticalMs: path.ms,
    sequentialMs: path.sequentialMs,
    measured,
  }
}

/**
 * The only suggestion made here is the one that can be derived without guessing: a slot on
 * the critical path that needs exactly one upstream result is a candidate for hoisting that
 * read, and the report says so rather than inventing an estimate for the improvement.
 */
function suggest(plan: Plan, path: readonly string[]): string | undefined {
  for (const name of path.slice(1)) {
    const spec = plan.slots.find((s) => s.name === name)
    if (spec && spec.needs.length === 1) {
      return `${name} is on the critical path and needs only ${spec.needs[0]}; hoisting that read into wave 0 would shorten it`
    }
  }
  return undefined
}
