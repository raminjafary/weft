import { fileURLToPath } from 'node:url'
import { compileFile } from '../../compiler/src/index.ts'
import type { Resolver, TemplateIR, Values } from '../../ir/src/index.ts'
import type { Scenario } from './workloads/index.ts'

export interface Compiled {
  root: TemplateIR
  row?: TemplateIR
  /** The binding the row template fills, taken from the list hole rather than declared. */
  rowBinding?: string
  resolve: Resolver
}

const cache = new Map<string, Compiled>()

/** Ids are stated relative to the repository, so a version does not depend on a checkout path. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Compiles a scenario's fixture. The benchmark measures emitted IR, never a hand-written one. */
export async function compileScenario(scenario: Scenario): Promise<Compiled> {
  const hit = cache.get(scenario.id)
  if (hit) return hit

  const module = await compileFile(scenario.fixture, { root: ROOT })
  const fragment = module.fragments[0]
  if (!fragment) throw new Error(`E_NO_FRAGMENT: ${scenario.fixture} has no fragment() export`)

  const root = fragment.entry
  const listHole = root.holes.find((h) => h.kind === 'list')
  const row = listHole?.nested ? fragment.templates.find((t) => t.version === listHole.nested) : undefined
  if (listHole && !row) throw new Error(`E_ROW_MISSING: ${root.id} names a nested template that was not emitted`)

  const compiled: Compiled = {
    root,
    ...(row ? { row } : {}),
    ...(listHole ? { rowBinding: listHole.binding } : {}),
    resolve: (version) => (row && version === row.version ? row : undefined),
  }
  cache.set(scenario.id, compiled)
  return compiled
}

export function compiledFor(scenario: Scenario): Compiled {
  const compiled = cache.get(scenario.id)
  if (!compiled) throw new Error(`E_NOT_COMPILED: call compileScenario(${scenario.id}) first`)
  return compiled
}

export function withRows(compiled: Compiled, values: Values, rows: Values[]): Values {
  if (!compiled.rowBinding) return values
  return { ...values, [compiled.rowBinding]: rows as unknown as Values[string] }
}
