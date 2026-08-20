/**
 * The authoring surface the compiler recognises, and the only thing a fragment file
 * imports. It exists as a real declaration rather than an inline string because the type
 * oracle and the editor must agree about what `signal(1)` returns — that agreement is
 * what makes escape elision trustworthy.
 */
declare module 'weft' {
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

  /** A fragment is a slot: it has a cache key, a wire form, an executor, and a budget. */
  export function fragment(render: (ctx: Ctx) => unknown): (ctx: Ctx) => unknown
  export function fragment<P>(render: (props: P) => unknown): (props: P) => unknown
  export function fragment<P>(render: (props: P, ctx: Ctx) => unknown): (props: P) => unknown

  export function signal<T>(initial: T): Signal<T>

  /** Interpolates without escaping. The compiler records the source text as provenance. */
  export function raw(value: unknown): unknown
}

declare namespace JSX {
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
   * lower to holes and which are refused. Narrowing this to real HTML attributes is worth
   * doing once the element set is settled.
   */
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown> & IntrinsicAttributes
  }
}
