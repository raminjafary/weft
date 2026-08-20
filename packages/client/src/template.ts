export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export type HoleKind = 'text' | 'attr' | 'attr-bool' | 'attr-presence' | 'node' | 'list' | 'slot'

/** The client's view of a hole: everything but the bytes, which it already holds. */
export interface ClientHole {
  index: number
  kind: HoleKind
  binding: string
  path: number[]
  attr?: string
  anchor?: number
  nested?: string
}

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

export interface ClientDerived {
  id: string
  expr: ClientExpr
}

export interface ClientTemplate {
  version: string
  holes: ClientHole[]
  wiring: ClientWiring[]
  derived?: ClientDerived[]
}

/** Templates the client holds, by version. A TPL frame adds to this. */
export type Resident = Record<string, ClientTemplate>
