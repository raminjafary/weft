/** What a value can be, mirroring the IR's own type — the client holds templates as data. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/** The hole kinds a client has to understand. Fewer than the server's: it never cuts a document. */
export type HoleKind =
  | 'text'
  | 'attr'
  | 'attr-bool'
  | 'attr-presence'
  | 'node'
  | 'list'
  | 'slot'
  | 'component'
  | 'children'
  /**
   * Not an IR hole kind: the shape `locate` uses when a wiring entry's op is `prop`. The
   * server rendered an attribute; the client writes the property behind it.
   */
  | 'prop'

/** The client's view of a hole: everything but the bytes, which it already holds. */
export interface ClientHole {
  index: number
  kind: HoleKind
  binding: string
  path: number[]
  attr?: string
  anchor?: number
  nested?: string
  /** For a `component` hole: child prop name to the parent binding that supplies it. */
  props?: Record<string, string>
  /**
   * For a `component` hole: the template holding the markup the call site wrote between the
   * tags. It stays in the caller's binding namespace, so nothing about it is renamed.
   */
  children?: string
}

/** One binding to attach: where it is, what it writes, and which value feeds it. */
export interface ClientWiring {
  path: number[]
  op: 'text' | 'attr' | 'prop' | 'bool' | 'event' | 'list'
  binding: string
  attr?: string
  event?: string
  intent?: string
  anchor?: number
}

/** The client's mirror of the IR's derived-expression encoding. */
export type ClientExpr =
  | { k: 'ref'; id: string }
  | { k: 'lit'; v: Json }
  | { k: 'un'; op: string; a: ClientExpr }
  | { k: 'bin'; op: string; a: ClientExpr; b: ClientExpr }
  | { k: 'cond'; a: ClientExpr; b: ClientExpr; c: ClientExpr }

/** A derived value as an expression tree, which is what travels instead of code. */
export interface ClientDerived {
  id: string
  expr: ClientExpr
}

/** A sealed template as the client receives it: no effects, no provenance, no build metadata. */
export interface ClientTemplate {
  version: string
  holes: ClientHole[]
  wiring: ClientWiring[]
  derived?: ClientDerived[]
}

/** Templates the client holds, by version. A TPL frame adds to this. */
export type Resident = Record<string, ClientTemplate>
