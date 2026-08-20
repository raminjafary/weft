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

export interface ClientTemplate {
  version: string
  holes: ClientHole[]
  wiring: ClientWiring[]
}

/** Templates the client holds, by version. A TPL frame adds to this. */
export type Resident = Record<string, ClientTemplate>
