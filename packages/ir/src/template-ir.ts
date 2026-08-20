import { PAYLOAD_SPEC, PAYLOAD_VERSION, TEMPLATE_IR_SPEC, TEMPLATE_IR_VERSION } from './version.ts'

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export type WireForm = 'html' | 'bundle' | 'split' | 'patch' | 'data' | 'delta' | 'remote'

export const ALL_FORMS: readonly WireForm[] = ['html', 'bundle', 'split', 'patch', 'data', 'delta', 'remote']

/**
 * `escape` is applied at render time; `proven-safe` is the escape-elision class the
 * compiler assigns when a value's type makes escaping a no-op. `trusted-raw` must
 * name its provenance, so an audit can ask who vouched for it.
 */
export type EscapeClass = 'escape' | 'proven-safe' | 'trusted-raw'

export type HoleKind = 'text' | 'attr' | 'attr-bool' | 'attr-presence' | 'node' | 'list' | 'slot'

export type BindingId = string

export interface Hole {
  index: number
  kind: HoleKind
  escape: EscapeClass
  binding: BindingId
  path: number[]
  attr?: string
  provenance?: string
  /** For a `list` hole: the template version each item's values are projected through. */
  nested?: string
}

export type WiringOp = 'text' | 'attr' | 'prop' | 'bool' | 'event' | 'list'

export interface WiringEntry {
  /**
   * Indices into *element* children, not childNodes. Element positions do not move
   * when a text value renders empty, so an element path is stable across value sets.
   */
  path: number[]
  op: WiringOp
  /** Unused for `event` ops, which name an intent instead. */
  binding: BindingId
  attr?: string
  event?: string
  intent?: string
  /**
   * For a `text` op: the ordinal of the marker comment this binding writes after,
   * counted in document order within the fragment and skipping list-hole subtrees.
   * Absent means the target is the parent element's only text child.
   */
  anchor?: number
}

export interface SignalDecl {
  id: BindingId
  type: 'string' | 'number' | 'boolean' | 'json'
  init?: Json
}

export interface EffectSet {
  reads: string[]
  writes: string[]
  envelope: string[]
  residency: 'server' | 'client' | 'either'
}

export interface TemplateIR {
  spec: typeof TEMPLATE_IR_SPEC
  irVersion: string
  id: string
  version: string
  segments: Uint8Array[]
  holes: Hole[]
  wiring: WiringEntry[]
  signals: SignalDecl[]
  forms: WireForm[]
  effects: EffectSet
  meta?: Record<string, Json>
}

export type Values = Record<BindingId, Json>

export interface DataPayload {
  spec: typeof PAYLOAD_SPEC
  irVersion: string
  form: 'data'
  tpl: string
  values: Values
}

export interface DeltaPayload {
  spec: typeof PAYLOAD_SPEC
  irVersion: string
  form: 'delta'
  tpl: string
  base: string
  changed: Values
}

export const EMPTY_EFFECTS: EffectSet = { reads: [], writes: [], envelope: [], residency: 'server' }

export interface DraftTemplate {
  id: string
  segments: (Uint8Array | string)[]
  holes: Hole[]
  wiring?: WiringEntry[]
  signals?: SignalDecl[]
  forms?: WireForm[]
  effects?: EffectSet
  meta?: Record<string, Json>
}

const utf8 = new TextEncoder()

/** An unsealed template: everything but the content-addressed version. */
export function draftTemplate(t: DraftTemplate): TemplateIR {
  return {
    spec: TEMPLATE_IR_SPEC,
    irVersion: TEMPLATE_IR_VERSION,
    id: t.id,
    version: '',
    segments: t.segments.map((s) => (typeof s === 'string' ? utf8.encode(s) : s)),
    holes: t.holes,
    wiring: t.wiring ?? [],
    signals: t.signals ?? [],
    forms: t.forms ?? derivableForms(t.holes),
    effects: t.effects ?? EMPTY_EFFECTS,
    ...(t.meta ? { meta: t.meta } : {}),
  }
}

/**
 * Which wire forms this template can serve, derived rather than declared.
 * `html` is unconditional — it is the floor that needs nothing resident on the client.
 * `data` and `delta` require every hole to be value-projectable through a template the
 * client already holds, which a structural `slot` hole is not.
 */
export function derivableForms(holes: Hole[]): WireForm[] {
  const forms: WireForm[] = ['html', 'bundle', 'split', 'patch']
  const projectable = holes.every((h) => h.kind !== 'slot')
  if (projectable) forms.push('data', 'delta')
  return forms
}

export function dataPayload(ir: TemplateIR, values: Values): DataPayload {
  return { spec: PAYLOAD_SPEC, irVersion: PAYLOAD_VERSION, form: 'data', tpl: ir.version, values }
}

export function deltaPayload(ir: TemplateIR, base: string, prev: Values, next: Values): DeltaPayload {
  return {
    spec: PAYLOAD_SPEC,
    irVersion: PAYLOAD_VERSION,
    form: 'delta',
    tpl: ir.version,
    base,
    changed: diffValues(prev, next),
  }
}

/**
 * Path-keyed diff (`rows[3].qty`), so a change to one row of a list costs one entry
 * rather than the whole list. A length change is structural and sends the list whole.
 */
export function diffValues(prev: Values, next: Values, prefix = ''): Values {
  const changed: Values = {}
  const at = (key: string) => (prefix ? `${prefix}.${key}` : key)

  for (const [key, value] of Object.entries(next)) {
    const before = prev[key]
    if (Array.isArray(value) && Array.isArray(before)) {
      if (value.length !== before.length) {
        changed[at(key)] = value
        continue
      }
      value.forEach((item, i) => {
        const was = before[i]
        if (isPlainObject(item) && isPlainObject(was)) {
          Object.assign(changed, diffValues(was as Values, item as Values, `${at(key)}[${i}]`))
        } else if (!sameValue(was, item)) {
          changed[`${at(key)}[${i}]`] = item
        }
      })
      continue
    }
    if (isPlainObject(value) && isPlainObject(before)) {
      Object.assign(changed, diffValues(before as Values, value as Values, at(key)))
      continue
    }
    if (!sameValue(before, value)) changed[at(key)] = value
  }

  for (const key of Object.keys(prev)) {
    if (!(key in next)) changed[at(key)] = null
  }
  return changed
}

function isPlainObject(v: Json | undefined): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sameValue(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
