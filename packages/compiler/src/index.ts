export * from './compile.ts'
/**
 * The kinds, not the checker.
 *
 * `types.ts` is the one module in this package that needs `typescript`, which is an optional peer —
 * so re-exporting it from the barrel made every consumer of the barrel need one too, and
 * `npm create weft` died on a checker it never asked for. It is deliberately not re-exported here:
 * `createTypeOracle` is loaded by the one caller that wants it, dynamically, inside the `try` that
 * falls back to escaping. What everything else wants is the shape and the predicate, and they are
 * here with no checker behind them.
 */
export * from './kinds.ts'
export * from './errors.ts'
export { intentId } from './intents.ts'
export type { ImportRef, Lowered, Scope } from './lower.ts'
export * from './comments.ts'
