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

  /** A fragment is a slot: it has a cache key, a wire form, an executor, and a budget. */
  export function fragment<P>(render: (props: P) => unknown): (props: P) => unknown

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
