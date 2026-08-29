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

/** The design's second and third memoisation levels — opt-in, per-slot. See `spec/kernel/surgical.md`. */
export interface SegmentMemo {
  get(key: string): Uint8Array | undefined
  set(key: string, bytes: Uint8Array): void
  readonly hits: number
  readonly misses: number
  readonly size: number
}

/** How much of the memo to keep, which is a memory-for-renders trade and nothing else. */
export interface SegmentMemoOptions {
  /** Bytes. An unbounded memo inside a 128 MB isolate is an outage waiting for traffic. */
  maxBytes?: number
}

/** A content-addressed memo over nested templates — list rows and component instances. See `spec/kernel/surgical.md`. */
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

/** Which derived values a change can reach, computed once per template rather than per render. See `spec/kernel/surgical.md`. */
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

/** Which derived values a recompute could skip, because nothing they read changed. */
export interface IncrementalDerived {
  values: Values
  recomputed: BindingId[]
  reused: BindingId[]
}

/** Resolve derived values against a previous resolved set. Identical to a full `resolveDerived`, gated by a fixture. */
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
  /** Holes whose shape changed rather than whose values did. See `spec/kernel/surgical.md`. */
  structural: string[]
}

/** The bytes, plus how many nested templates were reused rather than rendered. */
export interface IncrementalRender {
  bytes: Uint8Array
  stats: IncrementalStats
  /** The resolved value set, so the next round has a previous to compare against. */
  resolved: Values
}

/** The previous values and the memo, which is everything an incremental render needs extra. */
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

/** A render that consults the memo for nested templates and recomputes only reachable derived values. Byte-identical to `render()`, gated. */
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
      // Rendered in place, exactly as `render` does it — the memo key is the caller's, not this template's.
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
  // The frame is part of the key: two call sites can hand the same props to one template with different children.
  const key = segmentKey(nested.version, values) + frameKey(frame)
  const cached = input.memo.get(key)
  if (cached) {
    stats.segments.reused++
    return cached
  }
  stats.segments.rendered++
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
