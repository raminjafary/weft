import { clientOwned, resolveDerived, type DerivedDecl } from './derived.ts'
import { PAYLOAD_SPEC, PAYLOAD_VERSION, TEMPLATE_IR_SPEC, TEMPLATE_IR_VERSION } from './version.ts'

/** What can be a hole's value. A template is data, so its values have to be data too. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/**
 * How a fragment's update can be encoded.
 *
 * Every form of a fragment must produce identical bytes, which is what makes negotiating between
 * them safe — the harness refuses to publish a number until it has checked that they do. `data` was
 * cut on the evidence; see `spec/VERSIONING.md`.
 */
export type WireForm = 'html' | 'bundle' | 'split' | 'patch' | 'delta' | 'remote'

/** Every form, in the order the spec lists them. A template declares the subset it can serve. */
export const ALL_FORMS: readonly WireForm[] = ['html', 'bundle', 'split', 'patch', 'delta', 'remote']

/**
 * `escape` is applied at render time; `proven-safe` is the escape-elision class the
 * compiler assigns when a value's type makes escaping a no-op. `trusted-raw` must
 * name its provenance, so an audit can ask who vouched for it.
 */
export type EscapeClass = 'escape' | 'proven-safe' | 'trusted-raw'

/**
 * What a hole is, which decides who produces its bytes.
 *
 * `slot` and an isolated `component` are the two this render does *not* own — one left for slow
 * work, one for work with a different cache class — which is why the plan layer treats them as one
 * list of boundaries.
 */
export type HoleKind =
  'text' | 'attr' | 'attr-bool' | 'attr-presence' | 'node' | 'list' | 'slot' | 'component' | 'children'

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
   * For a `component` hole: the template version holding the markup the call site wrote
   * between the tags. It is named here rather than in the child because the child is shared
   * — one `<Card/>` used five times is one sealed template, and each of the five call sites
   * writes different children. The content is lowered in the *caller's* binding namespace,
   * so it reads the caller's props and signals directly and needs no projection.
   */
  children?: string
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
  /**
   * For a `text` op: the ordinal of the marker comment this binding writes after,
   * counted in document order within the fragment and skipping list-hole subtrees.
   * Absent means the target is the parent element's only text child.
   */
  anchor?: number
}

/** Client-owned state the server renders at its initial value and then stops owning. */
export interface SignalDecl {
  id: BindingId
  type: 'string' | 'number' | 'boolean' | 'json'
  init?: Json
}

/**
 * What a fragment reads, writes and does to the envelope, inferred by the compiler.
 *
 * `reads` is the input to every cache decision — the key, the class and the `Vary` header all come
 * from it. `writes` and `envelope` stay empty on a fragment, and deliberately: a render cannot
 * write, so there is nothing in one to infer a write from.
 */
export interface EffectSet {
  reads: string[]
  writes: string[]
  envelope: string[]
  residency: 'server' | 'client' | 'either'
}

/**
 * A sealed template: pre-encoded UTF-8 segments with holes between them, and a version that is a
 * hash of its own content.
 *
 * Sealed because nothing can change it after compilation — so two renders of the same template with
 * the same values are the same bytes by construction, which is what lets a client hold one and be
 * sent only values.
 */
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

/**
 * Which wire forms this template can serve, derived rather than declared.
 * `html` is unconditional — it is the floor that needs nothing resident on the client.
 * `delta` requires every hole to be value-projectable through a template the client
 * already holds, which a structural `slot` hole is not.
 */
export function derivableForms(holes: Hole[]): WireForm[] {
  const forms: WireForm[] = ['html', 'bundle', 'split']
  // A patch addresses the DOM structurally rather than by binding, so a slot hole and a
  // non-projectable value are both fine — what it cannot address is markup with no boundary.
  // A raw value that is not its element's only child produced an unknown number of nodes after a
  // marker comment, and nothing in the template says where they end.
  if (holes.every((h) => !(rawValue(h) && h.anchor !== undefined))) forms.push('patch')
  const projectable = holes.every(
    (h) =>
      // An isolated instance is structurally a hole this render does not fill, which is what
      // a slot is. Neither can be projected from values the parent holds.
      h.kind !== 'slot' &&
      !h.isolated &&
      // A `raw()` hole's *value* is markup, and a delta is applied by writing values into nodes —
      // where the only thing a node can be written is text. Projecting one therefore displays the
      // markup escaped, which is worse than sending the region again.
      //
      // `list`, `component` and `children` holes are trusted-raw as well and are not this case:
      // their markup comes from a nested template the client already holds, and a delta projects
      // values into it. The distinction is where the markup comes from — a template, or the
      // value set.
      !rawValue(h),
  )
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

/**
 * The markup a call site wrote between a component's tags, and the value set it reads.
 *
 * It is a frame rather than a value on the hole because a component may hand its own children
 * on to another one — `<Card><Panel>{children}</Panel></Card>` — and the inner `{children}`
 * has to mean the caller's markup, not Card's. `outer` is the frame that was active where the
 * children markup was written, which is what makes the scoping lexical rather than dynamic.
 */
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

/**
 * The delta between two value sets for one template.
 *
 * `base` is the render the client named, and naming it is what makes this memoisable: a delta is a
 * pure function of two content-addressed states, so one computation serves every client making the
 * same transition.
 */
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
  const addressable = addressableIn(ir, resolve, new Set())
  const sources = [...ir.signals, ...[...fromSignal].map((id) => ({ id }))]
  const owned = clientOwned(ir.derived, sources)
  // A row is its own template, so the rule about holes applies one level down as well. Without
  // this, a row field that only feeds an instance inside the row would travel twice: once
  // under a name the row has nothing to write it into, and once through the instance.
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

/**
 * The changes that live behind a nested template rather than in this one's value set: a
 * component instance, the children a call site handed one, and the instances inside a list
 * row. Everything here is addressed by walking down from the caller — `c0.label`,
 * `rows[3].c0.label` — because the client adopted each of them as its own table and a value
 * the parent never held has no name at the parent's level.
 */
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
    // Children are the caller's markup rendered somewhere else, so they share the caller's
    // value set and its prefix: nothing about them is renamed on the way in.
    if (hole.children) {
      const content = resolve?.(hole.children)
      if (!content) throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs ${hole.children}`)
      Object.assign(out, instanceChanges(content, before, after, resolve, prefix, owned, signals, fromSignal))
    }

    // A row is its own template, so an instance inside one is reached through the row. The
    // row's own values are already diffed by path; this is the part no path can express.
    if (hole.kind === 'list' && hole.nested) {
      const row = resolve?.(hole.nested)
      const prevRows = before[hole.binding]
      const nextRows = after[hole.binding]
      if (!row || !Array.isArray(prevRows) || !Array.isArray(nextRows)) continue
      // A length change is structural and sends the list whole, so there is nothing to address.
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

/**
 * Which bindings of this value set have somewhere to land. Children content is included
 * because it is written in this template's namespace and rendered inside the instance: a
 * value used only there is still this template's to send.
 */
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
