/**
 * What the checker is asked, and what is done with the answer — with no checker in it.
 *
 * Split from `types.ts` because that module imports `typescript/unstable/*` at the top level and
 * TypeScript is an *optional* peer of this package. Anything that reaches these three names
 * statically pulls the checker into its module graph, and in an install that has no checker the
 * import fails at load — before any `catch` that meant to fall back can run.
 *
 * That is not hypothetical: `lower.ts` needed one predicate and the barrel re-exported the module,
 * so `npm create weft <name>` died on `Cannot find package 'typescript'` inside a scaffolder that
 * never wanted a checker. A shape, a predicate over it, and the interface the implementation
 * satisfies have no business depending on the implementation, so they live here.
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
