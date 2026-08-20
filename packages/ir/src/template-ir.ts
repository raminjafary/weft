import { clientOwned, resolveDerived, type DerivedDecl } from './derived.ts'
import { PAYLOAD_SPEC, PAYLOAD_VERSION, TEMPLATE_IR_SPEC, TEMPLATE_IR_VERSION } from './version.ts'

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export type WireForm = 'html' | 'bundle' | 'split' | 'patch' | 'delta' | 'remote'

export const ALL_FORMS: readonly WireForm[] = ['html', 'bundle', 'split', 'patch', 'delta', 'remote']

/**
 * `escape` is applied at render time; `proven-safe` is the escape-elision class the
 * compiler assigns when a value's type makes escaping a no-op. `trusted-raw` must
 * name its provenance, so an audit can ask who vouched for it.
 */
export type EscapeClass = 'escape' | 'proven-safe' | 'trusted-raw'

export type HoleKind =
  'text' | 'attr' | 'attr-bool' | 'attr-presence' | 'node' | 'list' | 'slot' | 'component'

export type BindingId = string

export interface Hole {
  index: number
  kind: HoleKind
  escape: EscapeClass
  binding: BindingId
  path: number[]
  attr?: string
  provenance?: string
  /**
   * For a `list` hole: the template version each item's values are projected through.
   * For a `component` hole: the template version the instance is rendered through.
   */
  nested?: string
  /**
   * For a `component` hole: child prop name to the parent binding that supplies it. An
   * instance is a projection of the parent's values, never a value of its own, which is
   * what keeps a component transparent to a delta — a change to the parent binding is a
   * change to the child's hole, with no path syntax to invent.
   */
  props?: Record<string, BindingId>
  /**
   * For a `component` hole: the instance is its own cache unit and the parent does not
   * render it. Set when the child is private and the parent is not — containment, so that
   * one private fragment does not make a whole shared route private. The parent leaves a
   * boundary the kernel fills, exactly as it does for a `slot`.
   */
  isolated?: boolean
  /**
   * For a `text` hole: the ordinal of the marker comment its value follows, counted in
   * document order within the fragment and skipping list-hole subtrees. Absent means the
   * value is the only text child of the element at `path`.
   *
   * This is on the hole, not only on the wiring entry, because every value has to be
   * locatable — a delta writes server-owned values, not only signal-owned ones.
   */
  anchor?: number
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
  /**
   * Values computed from other bindings. A decl whose expression reads a signal is
   * reactive on the client; one that reads only props is resolved once, at render.
   */
  derived: DerivedDecl[]
  forms: WireForm[]
  effects: EffectSet
  meta?: Record<string, Json>
}

export type Values = Record<BindingId, Json>

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
  derived?: DerivedDecl[]
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
    derived: t.derived ?? [],
    forms: t.forms ?? derivableForms(t.holes),
    effects: t.effects ?? EMPTY_EFFECTS,
    ...(t.meta ? { meta: t.meta } : {}),
  }
}

/**
 * Which wire forms this template can serve, derived rather than declared.
 * `html` is unconditional — it is the floor that needs nothing resident on the client.
 * `delta` requires every hole to be value-projectable through a template the client
 * already holds, which a structural `slot` hole is not.
 */
export function derivableForms(holes: Hole[]): WireForm[] {
  const forms: WireForm[] = ['html', 'bundle', 'split', 'patch']
  // An isolated instance is structurally a hole this render does not fill, which is what
  // a slot is. Neither can be projected from values the parent holds.
  const projectable = holes.every((h) => h.kind !== 'slot' && !h.isolated)
  if (projectable) forms.push('delta')
  return forms
}

/**
 * The values a component instance is rendered with: its props, read out of the parent's
 * value set. A prop the parent does not supply is null rather than absent, so the child
 * renders a hole rather than the string "undefined".
 */
export function componentValues(hole: Hole, values: Values): Values {
  const out: Values = {}
  for (const [prop, binding] of Object.entries(hole.props ?? {})) out[prop] = values[binding] ?? null
  return out
}

export function deltaPayload(
  ir: TemplateIR,
  base: string,
  prev: Values,
  next: Values,
  resolve?: (version: string) => TemplateIR | undefined,
): DeltaPayload {
  return {
    spec: PAYLOAD_SPEC,
    irVersion: PAYLOAD_VERSION,
    form: 'delta',
    tpl: ir.version,
    base,
    changed: changesFor(ir, prev, next, resolve, '', new Set()),
  }
}

function changesFor(
  ir: TemplateIR,
  prev: Values,
  next: Values,
  resolve: ((version: string) => TemplateIR | undefined) | undefined,
  prefix: string,
  /**
   * Props a caller fed from a signal. The child declared them as ordinary props and has
   * no way to know, so ownership has to be carried across the boundary rather than
   * rediscovered on the other side.
   */
  fromSignal: Set<BindingId>,
): Values {
  const before = resolveDerived(ir.derived, prev)
  const after = resolveDerived(ir.derived, next)
  const changed = diffValues(before, after)
  const addressable = new Set(ir.holes.map((h) => h.binding))
  const sources = [...ir.signals, ...[...fromSignal].map((id) => ({ id }))]
  const owned = clientOwned(ir.derived, sources)
  for (const key of Object.keys(changed)) {
    const root = (key.split('.')[0] as string).replace(/\[\d+\]$/, '')
    // Two things never travel: a value with no hole, which the client could not write
    // anywhere, and a derived value the client recomputes for itself.
    if (!addressable.has(root) || owned.has(root)) delete changed[key]
  }

  const out: Values = {}
  for (const [key, value] of Object.entries(changed)) out[prefix ? `${prefix}.${key}` : key] = value

  // An instance is addressed by name, the way a row is addressed by index, so a value
  // computed inside a component is reachable without the parent knowing what it is.
  for (const hole of ir.holes) {
    if (hole.kind !== 'component') continue
    const child = hole.nested ? resolve?.(hole.nested) : undefined
    if (!child) {
      throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.nested ?? '?'}`)
    }
    const inherited = new Set<BindingId>()
    for (const [prop, binding] of Object.entries(hole.props ?? {})) {
      if (owned.has(binding) || fromSignal.has(binding) || ir.signals.some((sig) => sig.id === binding)) {
        inherited.add(prop)
      }
    }
    Object.assign(
      out,
      changesFor(
        child,
        componentValues(hole, before),
        componentValues(hole, after),
        resolve,
        prefix ? `${prefix}.${hole.binding}` : hole.binding,
        inherited,
      ),
    )
  }
  return out
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
