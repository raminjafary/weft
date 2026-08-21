import type { Hole, TemplateIR } from '@weft/ir'
import type { SlotFacts } from './validate.ts'

/**
 * What the plan layer is allowed to know about a fragment, taken from what the compiler
 * emitted rather than restated by hand.
 *
 * Every field here is derived. There is nothing an author could get wrong, which is the point:
 * a plan is checked against a fragment's real identity, real read set and real forms, so a
 * refusal is a fact about the code rather than a fact about a fixture.
 */
export interface CompiledEntry {
  entry: TemplateIR
}

/** A boundary this render does not own: a streaming hole, or an instance the compiler isolated. */
export function fillableHoles(holes: readonly Hole[]): string[] {
  const out: string[] = []
  for (const hole of holes) {
    if (hole.kind === 'slot' || hole.isolated) out.push(hole.binding)
  }
  return out
}

/** Holes a content-addressed segment memo could serve: a nested list row, or a component instance. */
export function nestedHoles(holes: readonly Hole[]): number {
  return holes.filter((hole) => Boolean(hole.nested) && !hole.isolated).length
}

export function factsOf(entry: TemplateIR): SlotFacts {
  return {
    id: entry.id,
    version: entry.version,
    effects: entry.effects,
    forms: entry.forms,
    derivedCount: entry.derived.length,
    nestedCount: nestedHoles(entry.holes),
    fillable: fillableHoles(entry.holes),
  }
}

/**
 * Keyed by the compiler's own id — `module#export` — because that is what a plan names and
 * what a generated plan would emit. A plan referring to a fragment by any other name would be
 * a second naming scheme to keep in sync.
 */
export function factsFrom(
  modules: readonly { fragments: readonly { entry: TemplateIR }[] }[],
): Record<string, SlotFacts> {
  const out: Record<string, SlotFacts> = {}
  for (const module of modules) {
    for (const fragment of module.fragments) out[fragment.entry.id] = factsOf(fragment.entry)
  }
  return out
}
