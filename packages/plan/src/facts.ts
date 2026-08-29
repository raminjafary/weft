import type { Hole, TemplateIR } from '@weftjs/ir'
import type { SlotFacts } from './validate.ts'

/** What the plan layer is allowed to know about a fragment. Every field is derived from what the compiler emitted. See `spec/plan/plan.md`. */
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

/** One fragment's facts. */
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

/** Keyed by the compiler's own id — `module#export` — because that is what a plan names. */
export function factsFrom(
  modules: readonly { fragments: readonly { entry: TemplateIR }[] }[],
): Record<string, SlotFacts> {
  const out: Record<string, SlotFacts> = {}
  for (const module of modules) {
    for (const fragment of module.fragments) out[fragment.entry.id] = factsOf(fragment.entry)
  }
  return out
}
