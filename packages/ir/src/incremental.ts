import { evalDerived, readsOf, type DerivedDecl } from './derived.ts'
import { canonicalJson, fastHash } from './hash.ts'
import { concat, renderHole, type Resolver } from './render.ts'
import {
  childrenFrame,
  componentValues,
  type BindingId,
  type ChildrenFrame,
  type Hole,
  type Json,
  type TemplateIR,
  type Values,
} from './template-ir.ts'

/**
 * The design's second and third memoisation levels. The first — a whole fragment, keyed by its
 * effect signature — is `StorePort` and has existed since the plan layer. These two are the
 * opt-in part, and the reason they are opt-in is that the literature is explicit about the hard
 * case: a structural change to the computation graph invalidates the reasoning that makes
 * incremental cheap, so it is per-slot rather than a mode.
 *
 * **Level two, derived values.** A derived expression whose inputs did not change does not need
 * re-evaluating. The dependency graph is already on the wire — `readsOf` walks it — so the set
 * of derived ids a change can reach is computable rather than guessable.
 *
 * **Level three, template segments.** A rendered nested template is a pure function of its
 * template version and its values, so it is content-addressed and shareable by exactly the
 * argument the delta memo uses: one computation, many deliveries. A list of 500 rows where
 * three changed costs three row renders.
 *
 * Two scoping decisions are deliberate and stated rather than discovered later.
 *
 * Only **nested** templates are memoised — list rows and component instances. A text hole is
 * one escape scan and one encode, and a hash of its value costs more than rendering it. A memo
 * that loses is worse than no memo, so the line is where the work is.
 *
 * The memo is **process-local**, because `render` is synchronous. It writes into a buffer and
 * returns a byte count, and a memo it consults has to answer synchronously — which rules out a
 * shared tier. Sharing row bytes between isolates would mean making rendering async, and that
 * would cost every render more than it saves any. So this is an isolate-local LRU, which for a
 * hot list is where the win is anyway, and the honest statement is that the sharing stops at
 * the isolate boundary.
 */
export interface SegmentMemo {
  get(key: string): Uint8Array | undefined
  set(key: string, bytes: Uint8Array): void
  readonly hits: number
  readonly misses: number
  readonly size: number
}

export interface SegmentMemoOptions {
  /** Bytes. An unbounded memo inside a 128 MB isolate is an outage waiting for traffic. */
  maxBytes?: number
}

export function createSegmentMemo(options: SegmentMemoOptions = {}): SegmentMemo {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
  const entries = new Map<string, Uint8Array>()
  let bytes = 0
  let hits = 0
  let misses = 0

  return {
    get hits() {
      return hits
    },
    get misses() {
      return misses
    },
    get size() {
      return entries.size
    },
    get(key) {
      const found = entries.get(key)
      if (!found) {
        misses++
        return undefined
      }
      hits++
      // Reinsert, so Map's insertion order is LRU order.
      entries.delete(key)
      entries.set(key, found)
      return found
    },
    set(key, value) {
      if (value.length > maxBytes) return
      const existing = entries.get(key)
      if (existing) bytes -= existing.length
      entries.set(key, value)
      bytes += value.length
      while (bytes > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) return
        bytes -= (entries.get(oldest) as Uint8Array).length
        entries.delete(oldest)
      }
    },
  }
}

/** The content address of a rendered nested template. Pure function in, pure function out. */
export function segmentKey(tpl: string, values: Values): string {
  return `${tpl}:${fastHash(canonicalJson(values as unknown as Json))}`
}

// ── level two: derived values ────────────────────────────────────────────────────────

export interface DerivedPlan {
  /** Derived ids to recompute, in declaration order, for a given set of changed bindings. */
  affectedBy(changed: ReadonlySet<BindingId>): BindingId[]
  readonly order: readonly DerivedDecl[]
}

/**
 * Which derived values a change can reach, computed once per template rather than per render.
 * Transitive, because one derived value may read another, and declaration order is what makes
 * a single forward pass enough.
 */
export function derivedPlan(decls: readonly DerivedDecl[]): DerivedPlan {
  const reads = decls.map((decl) => ({ id: decl.id, reads: readsOf(decl.expr) }))
  return {
    order: decls,
    affectedBy(changed) {
      const dirty = new Set<BindingId>(changed)
      const out: BindingId[] = []
      for (const decl of reads) {
        if (!decl.reads.some((id) => dirty.has(id))) continue
        dirty.add(decl.id)
        out.push(decl.id)
      }
      return out
    },
  }
}

export interface IncrementalDerived {
  values: Values
  recomputed: BindingId[]
  reused: BindingId[]
}

/**
 * Resolve derived values against a previous resolved set. Everything a change cannot reach is
 * carried over; everything it can is recomputed. The result is identical to a full
 * `resolveDerived`, and there is a gate asserting exactly that.
 */
export function resolveDerivedFrom(
  plan: DerivedPlan,
  previousResolved: Values,
  next: Values,
  changed: ReadonlySet<BindingId>,
): IncrementalDerived {
  if (plan.order.length === 0) return { values: next, recomputed: [], reused: [] }
  const affected = new Set(plan.affectedBy(changed))
  const out: Values = { ...next }
  const recomputed: BindingId[] = []
  const reused: BindingId[] = []
  for (const decl of plan.order) {
    if (affected.has(decl.id)) {
      out[decl.id] = evalDerived(decl.expr, (id) => out[id])
      recomputed.push(decl.id)
    } else {
      out[decl.id] = previousResolved[decl.id] as Json
      reused.push(decl.id)
    }
  }
  return { values: out, recomputed, reused }
}

/** Top-level bindings whose values differ. Canonical JSON, so key order is not a change. */
export function changedBindings(prev: Values, next: Values): Set<BindingId> {
  const changed = new Set<BindingId>()
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const a = prev[key]
    const b = next[key]
    if (a === b) continue
    if (canonicalJson(a as Json) !== canonicalJson(b as Json)) changed.add(key)
  }
  return changed
}

// ── level three: template segments ───────────────────────────────────────────────────

export interface IncrementalStats {
  /** Nested templates served from the memo, and rendered. */
  segments: { reused: number; rendered: number }
  derived: { reused: number; recomputed: number }
  /**
   * Holes whose shape changed rather than whose values did — a list that grew, a hole that is
   * suddenly not an array. Nothing is reused for one of these, and naming them is the point:
   * a slot that reports structural change every time is a slot for which `.incremental()` is
   * costing rather than saving.
   */
  structural: string[]
}

export interface IncrementalRender {
  bytes: Uint8Array
  stats: IncrementalStats
  /** The resolved value set, so the next round has a previous to compare against. */
  resolved: Values
}

export interface IncrementalInput {
  ir: TemplateIR
  values: Values
  memo: SegmentMemo
  resolve?: Resolver
  /** The previous render's resolved values, for level two. Without one every derived value is recomputed. */
  previous?: { resolved: Values; supplied: Values }
  /** Precomputed dependency graph. Built from `ir.derived` when absent. */
  plan?: DerivedPlan
}

/**
 * A render that consults the memo for every nested template and recomputes only the derived
 * values a change can reach. Byte-identical to `render()` for the same inputs, which is the one
 * property that makes it safe to turn on: there is a gate over the fixtures asserting it.
 */
export function renderIncremental(input: IncrementalInput): IncrementalRender {
  const stats: IncrementalStats = {
    segments: { reused: 0, rendered: 0 },
    derived: { reused: 0, recomputed: 0 },
    structural: [],
  }

  const plan = input.plan ?? derivedPlan(input.ir.derived)
  let values: Values
  if (input.previous) {
    const changed = changedBindings(input.previous.supplied, input.values)
    const resolved = resolveDerivedFrom(plan, input.previous.resolved, input.values, changed)
    values = resolved.values
    stats.derived = { reused: resolved.reused.length, recomputed: resolved.recomputed.length }
  } else {
    const all = new Set(Object.keys(input.values))
    const resolved = resolveDerivedFrom(plan, {}, input.values, all)
    values = resolved.values
    stats.derived = { reused: 0, recomputed: resolved.recomputed.length }
  }

  const parts: Uint8Array[] = []
  writeSegments(input.ir, values, input, stats, parts, undefined)
  return { bytes: concat(parts), stats, resolved: values }
}

function writeSegments(
  ir: TemplateIR,
  values: Values,
  input: IncrementalInput,
  stats: IncrementalStats,
  parts: Uint8Array[],
  frame: ChildrenFrame | undefined,
): void {
  for (let i = 0; i < ir.segments.length; i++) {
    parts.push(ir.segments[i] as Uint8Array)
    const hole = ir.holes[i]
    if (!hole) continue

    if (hole.kind === 'component') {
      if (hole.isolated) continue
      const nested = child(hole, input.resolve)
      const inner = childrenFrame(hole, values, input.resolve, frame)
      parts.push(nestedBytes(nested, componentValues(hole, values), input, stats, inner))
      continue
    }

    if (hole.kind === 'children') {
      // Children are the caller's markup and the caller's values, so the memo key that
      // would address them is the caller's — not anything this template can name. Rendered
      // in place, exactly as `render` does it.
      if (frame) writeSegments(frame.ir, frame.values, input, stats, parts, frame.outer)
      continue
    }

    if (hole.kind === 'list' && hole.nested) {
      const value = values[hole.binding]
      if (!Array.isArray(value)) {
        stats.structural.push(hole.binding)
        continue
      }
      const nested = child(hole, input.resolve)
      for (const row of value) {
        parts.push(nestedBytes(nested, row as Values, input, stats, undefined))
      }
      continue
    }

    // A text or attribute hole: one escape scan and one encode. Cheaper than hashing it.
    parts.push(renderHole(hole, values[hole.binding], input.resolve))
  }
}

function nestedBytes(
  nested: TemplateIR,
  values: Values,
  input: IncrementalInput,
  stats: IncrementalStats,
  frame: ChildrenFrame | undefined,
): Uint8Array {
  // An instance's bytes are a function of its props *and* of the markup its call site put
  // between the tags. Two call sites can hand the same props to one template and different
  // children, so the frame is part of the address or the memo would answer with the wrong
  // markup — a content-addressed cache whose key is not the content.
  const key = segmentKey(nested.version, values) + frameKey(frame)
  const cached = input.memo.get(key)
  if (cached) {
    stats.segments.reused++
    return cached
  }
  stats.segments.rendered++
  // A nested template's own derived values are resolved inside its own pass, and its own
  // nested templates get their own memo lookups.
  const parts: Uint8Array[] = []
  const own = derivedPlan(nested.derived)
  const resolved = resolveDerivedFrom(own, {}, values, new Set(Object.keys(values)))
  writeSegments(nested, resolved.values, input, stats, parts, frame)
  const bytes = concat(parts)
  input.memo.set(key, bytes)
  return bytes
}

function frameKey(frame: ChildrenFrame | undefined): string {
  let key = ''
  for (let f = frame; f; f = f.outer) key += `|${segmentKey(f.ir.version, f.values)}`
  return key
}

function child(hole: Hole, resolve: Resolver | undefined): TemplateIR {
  const nested = hole.nested ? resolve?.(hole.nested) : undefined
  if (!nested) {
    throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.nested ?? '?'}`)
  }
  return nested
}
