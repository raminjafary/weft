/**
 * The authoring surface, and the only module an application's own code has to know about.
 *
 * Everything here is either a declaration the compiler reads statically or a typed identity
 * function. Nothing in this file runs during a render: `fragment` is lowered to a sealed
 * template at build time, and calling one at runtime is a bug worth naming rather than a
 * fallback worth having.
 */
export interface Signal<T> {
  (): T
  set(next: T): void
}

/**
 * Every call here taints the fragment, and nothing else does. The taint set becomes the
 * cache key, so the compiler refuses a read it cannot name statically.
 */
export interface Ctx {
  /** Taints `flag:name`. Becomes a plan axis: only the resolved branch is reachable. */
  flag(flag: unknown): Promise<boolean>
  /** Taints `cookie:key`. Shared, keyed by value, and adds to Vary. */
  cookie(key: string): string | undefined
  /** Taints `header:key`. Shared, keyed by value, and adds to Vary. */
  header(key: string): string | undefined
  /** Taints `route:key`. Already part of the route key. */
  param(key: string): string | undefined
  query(key: string): string | undefined
  /** Low cardinality, so ideal for ahead-of-time permutations. */
  locale(): string
  device(): 'low-end' | 'mid' | 'hi'
  /** Taints `identity`. Private: never shared, never a CDN entry. */
  user(): Promise<{ id: string } | null>
  /** Taints `time`, which forces a TTL — a cache policy without one is a build error. */
  now(): number
  /**
   * The escape hatch. Uncacheable, private, reported, and local to this fragment: it does
   * not spread to the route. Use it when a read is genuinely opaque rather than to avoid
   * naming one.
   */
  raw<T>(read: () => T): T
}

function lowered(name: string): never {
  throw new Error(
    `E_NOT_LOWERED: ${name}() is a declaration the compiler reads, not a function that runs. ` +
      `A fragment module is compiled to a sealed template; it is never imported at runtime.`,
  )
}

/**
 * A fragment is a slot: it has a cache key, a wire form, an executor, and a budget. It
 * returns a component so that one fragment can render another — the return type has to be
 * `JSX.Element` for the checker to accept `<Widget/>`, even though the value is never called
 * at runtime and the compiler resolves the tag statically.
 */
export function fragment(render: (ctx: Ctx) => unknown): (ctx: Ctx) => JSX.Element
export function fragment<P>(render: (props: P) => unknown): (props: P) => JSX.Element
export function fragment<P>(render: (props: P, ctx: Ctx) => unknown): (props: P) => JSX.Element
export function fragment(_render: unknown): never {
  return lowered('fragment')
}

export function signal<T>(_initial: T): Signal<T> {
  return lowered('signal')
}

/** Interpolates without escaping. The compiler records the source text as provenance. */
export function raw(_value: unknown): unknown {
  return lowered('raw')
}

declare global {
  namespace JSX {
    interface Element {
      readonly __weft: unique symbol
    }

    interface ElementChildrenAttribute {
      children: Record<string, never>
    }

    interface IntrinsicAttributes {
      key?: string | number
    }

    /**
     * Deliberately permissive: the compiler, not the type system, decides which attributes
     * lower to holes and which are refused.
     */
    interface IntrinsicElements {
      [tag: string]: Record<string, unknown> & IntrinsicAttributes
    }
  }
}

export {
  defineRoute,
  type BudgetDeclaration,
  type BudgetFor,
  type CacheDeclaration,
  type RouteLoad,
  type RouteModule,
  type SlotDeclaration,
} from './route.ts'
export type { ExceedPolicy, PolicyClass, WireForm } from './types.ts'
export { allFragments, allTemplates, asset, fragmentIR } from './current.ts'
export { listHole, slotHoles, type CompiledFragment } from './compile.ts'
export { adoptScript, type AdoptOptions } from './routes.ts'
export { defineConfig, type WeftConfig } from './config.ts'
export { defineIntent } from '@weft/kernel'
export type { Intent, IntentContext, IntentResult, RenderContext, EnvelopeContext } from '@weft/kernel'
export type { Values } from '@weft/ir'
