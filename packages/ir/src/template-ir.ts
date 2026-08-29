import { clientOwned, resolveDerived, type DerivedDecl } from './derived.ts'
import { PAYLOAD_SPEC, PAYLOAD_VERSION, TEMPLATE_IR_SPEC, TEMPLATE_IR_VERSION } from './version.ts'

/** What can be a hole's value. A template is data, so its values have to be data too. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/** How a fragment's update can be encoded. Every form must produce identical bytes. See `spec/ir/template-ir-2.md`. */
export type WireForm = 'html' | 'bundle' | 'split' | 'patch' | 'delta' | 'remote'

/** Every form, in the order the spec lists them. A template declares the subset it can serve. */
export const ALL_FORMS: readonly WireForm[] = ['html', 'bundle', 'split', 'patch', 'delta', 'remote']

/** The compiler's escape-elision decision. `trusted-raw` must name its provenance. See `spec/ir/template-ir-2.md`. */
export type EscapeClass = 'escape' | 'proven-safe' | 'trusted-raw'

/** What a hole is, which decides who produces its bytes. See `spec/ir/template-ir-2.md`. */
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
  /** A shape that renders only when its binding is truthy. See `spec/ir/template-ir-2.md`. */
  | 'variant'

/** A value's name inside a template. Holes and wiring entries both address values by it. */
export type BindingId = string

/** One gap in a sealed template: what fills it, how it escapes, and where it is in the DOM. */
export interface Hole {
  index: number
  kind: HoleKind
  escape: EscapeClass
  binding: BindingId
  path: number[]
  attr?: string
  provenance?: string
  /** For `list`: the version items project through. For `component`/`variant`: the version rendered/written. See `spec/ir/template-ir-2.md`. */
  nested?: string
  /** For `component`/`variant`: child prop name to the parent binding that supplies it. See `spec/ir/template-ir-2.md`. */
  props?: Record<string, BindingId>
  /** For `component`: the template version holding the markup the call site wrote between the tags. See `spec/ir/template-ir-2.md`. */
  children?: string
  /** For `component`: the instance is its own cache unit and the parent does not render it. See `spec/ir/template-ir-2.md`. */
  isolated?: boolean
  /** For `list`: the binding each item is supplied as, when a row interpolates the item itself. See `spec/ir/template-ir-2.md`. */
  rowValue?: BindingId
  /** For `list`: the binding each row's zero-based position is supplied as. See `spec/ir/template-ir-2.md`. */
  rowIndex?: BindingId
  /** For `text`: the ordinal of the marker comment its value follows. Absent means the only text child at `path`. */
  anchor?: number
}

/** What a binding writes. `prop` exists because an attribute and a live value stop agreeing once somebody types. */
export type WiringOp = 'text' | 'attr' | 'prop' | 'bool' | 'event' | 'list'

/** One binding the client attaches on adoption. The cost model is the number of these. */
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
  /** For `text`: the ordinal of the marker comment this binding writes after. Absent means the only text child. */
  anchor?: number
}

/** Client-owned state the server renders at its initial value and then stops owning. */
export interface SignalDecl {
  id: BindingId
  type: 'string' | 'number' | 'boolean' | 'json'
  init?: Json
}

/** What a fragment reads, writes and does to the envelope, inferred by the compiler. See `spec/kernel/cache.md`. */
export interface EffectSet {
  reads: string[]
  writes: string[]
  envelope: string[]
  residency: 'server' | 'client' | 'either'
}

/** A sealed template: pre-encoded UTF-8 segments with holes between them, and a version that is a hash of its own content. See `spec/ir/template-ir-2.md`. */
export interface TemplateIR {
  spec: typeof TEMPLATE_IR_SPEC
  irVersion: string
  id: string
  version: string
  segments: Uint8Array[]
  holes: Hole[]
  wiring: WiringEntry[]
  signals: SignalDecl[]
  /** Values computed from other bindings. See `spec/ir/template-ir-2.md`: ownership follows the reads. */
  derived: DerivedDecl[]
  forms: WireForm[]
  effects: EffectSet
  meta?: Record<string, Json>
}

/** One render's values, by binding. Everything a template needs that is not in its segments. */
export type Values = Record<BindingId, Json>

/** The changed values of a region, against the base render the client says it holds. */
export interface DeltaPayload {
  spec: typeof PAYLOAD_SPEC
  irVersion: string
  form: 'delta'
  tpl: string
  base: string
  changed: Values
}

/** Reads nothing. `server` rather than `either` because a fixture is not a claim about residency. */
export const EMPTY_EFFECTS: EffectSet = { reads: [], writes: [], envelope: [], residency: 'server' }

/** A template before it is sealed. `seal` fills in the version, which is why that is absent here. */
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

/** A hole whose markup comes from a nested template rather than from a value. */
function fromTemplate(h: Hole): boolean {
  return h.kind === 'component' || h.kind === 'list' || h.kind === 'children'
}

/**
 * A hole whose *value* is markup: `raw()`. The nested kinds are trusted-raw as well and are not
 * this case — their markup comes from a template, which is what makes it addressable.
 */
export function rawValue(h: Hole): boolean {
  return h.escape === 'trusted-raw' && !fromTemplate(h)
}

/** Which wire forms this template can serve, derived rather than declared. See `spec/ir/template-ir-2.md`. */
export function derivableForms(holes: Hole[]): WireForm[] {
  const forms: WireForm[] = ['html', 'bundle', 'split']
  if (holes.every((h) => !(rawValue(h) && h.anchor !== undefined))) forms.push('patch')
  const projectable = holes.every((h) => h.kind !== 'slot' && !h.isolated && !rawValue(h))
  if (projectable) forms.push('delta')
  return forms
}

/** The values a component instance is rendered with. A missing prop is null rather than absent, so the child renders a hole, not "undefined". */
export function componentValues(hole: Hole, values: Values): Values {
  const out: Values = {}
  for (const [prop, binding] of Object.entries(hole.props ?? {})) out[prop] = values[binding] ?? null
  return out
}

/** The markup a call site wrote between a component's tags, and the value set it reads. A frame, not a hole value — see `spec/ir/template-ir-2.md`. */
export interface ChildrenFrame {
  ir: TemplateIR
  values: Values
  outer?: ChildrenFrame
}

/** The frame a component hole opens for its instance: absent when the call site wrote none. */
export function childrenFrame(
  hole: Hole,
  values: Values,
  resolve: ((version: string) => TemplateIR | undefined) | undefined,
  outer: ChildrenFrame | undefined,
): ChildrenFrame | undefined {
  if (!hole.children) return undefined
  const ir = resolve?.(hole.children)
  if (!ir) throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.children}`)
  return { ir, values, ...(outer ? { outer } : {}) }
}

/** The delta between two value sets for one template. See `spec/kernel/surgical.md`: a pure function of two content-addressed states. */
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
  /** Props a caller fed from a signal, carried across since the child has no way to rediscover it. */
  fromSignal: Set<BindingId>,
): Values {
  const before = resolveDerived(ir.derived, prev)
  const after = resolveDerived(ir.derived, next)
  const changed = diffValues(before, after)
  const addressable = addressableIn(ir, resolve, new Set())
  const sources = [...ir.signals, ...[...fromSignal].map((id) => ({ id }))]
  const owned = clientOwned(ir.derived, sources)
  // A row is its own template; without this a field feeding only an instance inside it would travel twice.
  const rowFields = new Map<BindingId, Set<BindingId>>()
  for (const hole of ir.holes) {
    if (hole.kind !== 'list' || !hole.nested) continue
    const row = resolve?.(hole.nested)
    if (row) rowFields.set(hole.binding, addressableIn(row, resolve, new Set()))
  }

  for (const key of Object.keys(changed)) {
    const tokens = key.split('.')
    const root = (tokens[0] as string).replace(/\[\d+\]$/, '')
    // Two things never travel: a value with no hole, which the client could not write
    // anywhere, and a derived value the client recomputes for itself.
    if (!addressable.has(root) || owned.has(root)) {
      delete changed[key]
      continue
    }
    const field = tokens[1]
    const fields = tokens[0] === root ? undefined : rowFields.get(root)
    if (fields && field !== undefined && !fields.has(field.replace(/\[\d+\]$/, ''))) delete changed[key]
  }

  const out: Values = {}
  for (const [key, value] of Object.entries(changed)) out[prefix ? `${prefix}.${key}` : key] = value

  Object.assign(out, instanceChanges(ir, before, after, resolve, prefix, owned, ir.signals, fromSignal))
  return out
}

/** The changes behind a nested template: a component instance, handed-down children, instances inside a list row. See `spec/ir/template-ir-2.md`. */
function instanceChanges(
  ir: TemplateIR,
  before: Values,
  after: Values,
  resolve: ((version: string) => TemplateIR | undefined) | undefined,
  prefix: string,
  owned: Set<BindingId>,
  signals: readonly { id: BindingId }[],
  fromSignal: Set<BindingId>,
): Values {
  const out: Values = {}
  for (const hole of ir.holes) {
    if (hole.children) {
      const content = resolve?.(hole.children)
      if (!content) throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs ${hole.children}`)
      Object.assign(out, instanceChanges(content, before, after, resolve, prefix, owned, signals, fromSignal))
    }

    if (hole.kind === 'list' && hole.nested) {
      const row = resolve?.(hole.nested)
      const prevRows = before[hole.binding]
      const nextRows = after[hole.binding]
      if (!row || !Array.isArray(prevRows) || !Array.isArray(nextRows)) continue
      if (prevRows.length !== nextRows.length) continue
      if (!row.holes.some((h) => h.kind === 'component' || h.children)) continue
      const at = prefix ? `${prefix}.${hole.binding}` : hole.binding
      nextRows.forEach((item, i) => {
        Object.assign(
          out,
          instanceChanges(
            row,
            resolveDerived(row.derived, prevRows[i] as Values),
            resolveDerived(row.derived, item as Values),
            resolve,
            `${at}[${i}]`,
            // A row cannot close over a signal, so nothing inside one is the client's to own.
            new Set(),
            [],
            new Set(),
          ),
        )
      })
      continue
    }

    if (hole.kind !== 'component') continue
    const child = hole.nested ? resolve?.(hole.nested) : undefined
    if (!child) {
      throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.nested ?? '?'}`)
    }
    const inherited = new Set<BindingId>()
    for (const [prop, binding] of Object.entries(hole.props ?? {})) {
      if (owned.has(binding) || fromSignal.has(binding) || signals.some((sig) => sig.id === binding)) {
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

/** Which bindings of this value set have somewhere to land, including children content. */
function addressableIn(
  ir: TemplateIR,
  resolve: ((version: string) => TemplateIR | undefined) | undefined,
  seen: Set<string>,
): Set<BindingId> {
  const out = new Set<BindingId>()
  for (const hole of ir.holes) {
    out.add(hole.binding)
    if (!hole.children || seen.has(hole.children)) continue
    seen.add(hole.children)
    const content = resolve?.(hole.children)
    if (content) for (const id of addressableIn(content, resolve, seen)) out.add(id)
  }
  return out
}

/** Path-keyed diff (`rows[3].qty`). A length change is structural and sends the list whole. See `spec/ir/template-ir-2.md`. */
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
