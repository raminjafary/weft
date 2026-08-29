/**
 * What the checker is asked, and what is done with the answer — with no checker in it. Split from
 * `types.ts` because TypeScript is an optional peer of this package. See `spec/compiler/supported-subset.md`.
 */

/** What the checker said a hole holds. `number` and `boolean` are what make escaping a no-op. */
export type ValueKind = 'number' | 'boolean' | 'string' | 'other'

/** The type checker, asked one question: what kind of value occupies this span. */
export interface TypeOracle {
  /** The kind of the expression occupying exactly this span, if it can be determined. */
  kindAt(file: string, start: number, end: number): ValueKind
  /** Type errors in the compiled files. Reported, never fatal: a template still lowers. */
  diagnostics(): string[]
  /** Shuts down the checker. It runs as a separate process, so this is not optional. */
  dispose(): void
}

/** Values of these kinds cannot contain markup, so escaping them is a no-op. */
export function cannotBeMarkup(kind: ValueKind): boolean {
  return kind === 'number' || kind === 'boolean'
}
