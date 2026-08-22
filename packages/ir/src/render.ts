import { resolveDerived } from './derived.ts'
import { childrenFrame, componentValues } from './template-ir.ts'
import type { ChildrenFrame, DeltaPayload, Hole, Json, TemplateIR, Values } from './template-ir.ts'

const utf8 = new TextEncoder()

function needsEscape(s: string, attr: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 38 || c === 60 || c === 62) return true
    if (attr && c === 34) return true
  }
  return false
}

/**
 * Escapes only when a scan proves it necessary — the runtime half of escape elision. The
 * escaping itself goes through the string form: replacing in a string and encoding once is
 * one allocation, where splicing pre-encoded entities into a byte array was one per run.
 */
export function escapeBytes(s: string, attr: boolean): Uint8Array {
  return utf8.encode(needsEscape(s, attr) ? escapeString(s, attr) : s)
}

export function escapeString(s: string, attr: boolean): string {
  let out = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    let rep = ''
    if (c === 38) rep = '&amp;'
    else if (c === 60) rep = '&lt;'
    else if (c === 62) rep = '&gt;'
    else if (attr && c === 34) rep = '&quot;'
    if (rep) {
      if (i > start) out += s.slice(start, i)
      out += rep
      start = i + 1
    }
  }
  return start === 0 ? s : out + s.slice(start)
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function stringify(v: Json | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function truthy(v: Json | undefined): boolean {
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0
}

/** Resolves a nested template by version, which is how a list of fragments is projected. */
export type Resolver = (version: string) => TemplateIR | undefined

/**
 * One hole's bytes, for a consumer that walks a template itself rather than rendering it —
 * the kernel cutting a shell at its slots, or the incremental renderer filling in around a
 * memoised region. It is the buffer writer with a copy on the end rather than a second
 * implementation of the same switch: two of those would eventually disagree, and the one
 * they disagreed about would be the wire form nobody was testing.
 */
export function renderHole(hole: Hole, value: Json | undefined, resolve?: Resolver): Uint8Array {
  for (;;) {
    try {
      return scratch.slice(0, writeValue(hole, value, scratch, 0, resolve))
    } catch (e) {
      if (e !== OVERFLOW) throw e
      grow()
    }
  }
}

/**
 * The one rendering function. The server calls it to produce the `html` form and the
 * client calls it to project the `data` form, which is what makes the two provably
 * equal for a given template version and value set.
 *
 * Segments are already UTF-8, so they are copied rather than encoded, and hole values
 * are encoded straight into the destination buffer. Nothing intermediate is allocated
 * per render except the escaped form of a value that actually needed escaping.
 */
export function render(ir: TemplateIR, values: Values, resolve?: Resolver): Uint8Array {
  for (;;) {
    try {
      const written = writeTemplate(ir, values, resolve, scratch, 0, undefined)
      return scratch.slice(0, written)
    } catch (e) {
      if (e !== OVERFLOW) throw e
      grow()
    }
  }
}

/** Writes into a caller-owned buffer and returns the byte count. Throws OVERFLOW if it does not fit. */
export function renderInto(
  ir: TemplateIR,
  values: Values,
  out: Uint8Array,
  offset = 0,
  resolve?: Resolver,
): number {
  return writeTemplate(ir, values, resolve, out, offset, undefined) - offset
}

const OVERFLOW = Symbol('weft.render.overflow')
let scratch = new Uint8Array(1 << 16)

function grow(): void {
  scratch = new Uint8Array(scratch.length * 2)
}

function writeBytes(src: Uint8Array, out: Uint8Array, off: number): number {
  if (off + src.length > out.length) throw OVERFLOW
  out.set(src, off)
  return off + src.length
}

function writeString(s: string, out: Uint8Array, off: number): number {
  const target = out.subarray(off)
  const { read, written } = utf8.encodeInto(s, target)
  if (read < s.length) throw OVERFLOW
  return off + written
}

function writeValue(
  hole: Hole,
  value: Json | undefined,
  out: Uint8Array,
  off: number,
  resolve?: Resolver,
): number {
  switch (hole.kind) {
    // Nothing this render owns. A slot is left for a later frame; a component is projected
    // from the whole value set and children are the caller's markup, and both are written by
    // `writeTemplate` before it ever reaches here.
    case 'slot':
    case 'component':
    case 'children':
      return off
    case 'attr-bool':
      return truthy(value) ? writeString(hole.attr ?? '', out, off) : off
    case 'attr-presence': {
      if (!truthy(value)) return off
      let cursor = writeString(`${hole.attr ?? ''}="`, out, off)
      cursor = writeEscaped(stringify(value), hole.escape === 'escape', true, out, cursor)
      return writeString('"', out, cursor)
    }
    case 'list': {
      if (!Array.isArray(value)) return off
      let cursor = off
      if (hole.nested) {
        const nested = resolve?.(hole.nested)
        if (!nested) throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.nested}`)
        for (const item of value) {
          cursor = writeTemplate(nested, item as Values, resolve, out, cursor, undefined)
        }
        return cursor
      }
      for (const item of value) {
        cursor = writeEscaped(stringify(item), hole.escape === 'escape', false, out, cursor)
      }
      return cursor
    }
    default:
      return writeEscaped(stringify(value), hole.escape === 'escape', hole.kind === 'attr', out, off)
  }
}

/** Escapes only when a scan proves it necessary, then encodes in one pass. */
function writeEscaped(s: string, escape: boolean, attr: boolean, out: Uint8Array, off: number): number {
  if (!escape || !needsEscape(s, attr)) return writeString(s, out, off)
  return writeString(escapeString(s, attr), out, off)
}

function writeTemplate(
  ir: TemplateIR,
  supplied: Values,
  resolve: Resolver | undefined,
  out: Uint8Array,
  offset: number,
  frame: ChildrenFrame | undefined,
): number {
  const values = resolveDerived(ir.derived, supplied)
  let off = offset
  for (let i = 0; i < ir.segments.length; i++) {
    off = writeBytes(ir.segments[i] as Uint8Array, out, off)
    const hole = ir.holes[i]
    if (!hole) continue
    if (hole.kind === 'component') {
      // An isolated instance is not this render's to produce: it has its own cache entry,
      // and the kernel composes it in the same pass that fills a slot.
      if (hole.isolated) continue
      off = writeTemplate(
        child(hole, resolve),
        componentValues(hole, values),
        resolve,
        out,
        off,
        childrenFrame(hole, values, resolve, frame),
      )
      continue
    }
    if (hole.kind === 'children') {
      // The caller's markup, rendered against the caller's values and under the frame that
      // was open where it was written — so a component that passes its children on gets its
      // caller's children, not its own.
      if (frame) off = writeTemplate(frame.ir, frame.values, resolve, out, off, frame.outer)
      continue
    }
    off = writeValue(hole, values[hole.binding], out, off, resolve)
  }
  return off
}

function child(hole: Hole, resolve: Resolver | undefined): TemplateIR {
  const nested = hole.nested ? resolve?.(hole.nested) : undefined
  if (!nested) throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.nested ?? '?'}`)
  return nested
}

export const renderHtml = render

/** A delta is only applicable to the template version it was computed against. */
export function assertSameTemplate(ir: TemplateIR, payload: { tpl: string }): void {
  if (payload.tpl !== ir.version) {
    throw new Error(`E_TPL_MISMATCH: payload targets ${payload.tpl}, template is ${ir.version}`)
  }
}

const PATH_TOKEN = /^([^[.]+)(?:\[(\d+)\])?$/

/**
 * Undoes the projections a delta addresses through, so a path written for the client's tables
 * becomes a path into the caller's value set. `c0.tone` names a hole inside an instance; the
 * caller knows that value by whatever binding feeds the prop, and the component hole says
 * which. A list is not a projection — a row keeps its own names — so it only moves the walk
 * into the row template.
 *
 * A child hole with no prop behind it is a value the child *computed*, and the caller's value
 * set has no name for it at all. That is refused rather than dropped: a reconstruction that
 * quietly ignored one changed value would produce a plausible wrong render.
 */
function invertPath(path: string, ir: TemplateIR, resolve: Resolver | undefined): string {
  const out: string[] = []
  let current: TemplateIR | undefined = ir
  const tokens = path.split('.')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    const m = PATH_TOKEN.exec(token)
    const key = m ? (m[1] as string) : token
    const suffix = m && m[2] !== undefined ? `[${m[2]}]` : ''
    const hole: Hole | undefined = current ? holeFor(current, key, resolve) : undefined
    if (hole?.kind === 'component') {
      const rest = tokens[i + 1]
      if (rest === undefined) break
      const inner = PATH_TOKEN.exec(rest)
      const innerKey = inner ? (inner[1] as string) : rest
      const behind = hole.props?.[innerKey]
      if (behind === undefined) {
        throw new Error(
          `E_DELTA_NOT_INVERTIBLE: ${path} names ${innerKey}, which the instance computes; the caller's value set has no binding for it`,
        )
      }
      tokens[i + 1] = behind + (inner && inner[2] !== undefined ? `[${inner[2]}]` : '')
      current = hole.nested ? resolve?.(hole.nested) : undefined
      continue
    }
    out.push(key + suffix)
    current = hole?.kind === 'list' && hole.nested ? resolve?.(hole.nested) : undefined
  }
  return out.join('.')
}

/** A binding of this template, or of the children markup that shares its namespace. */
function holeFor(ir: TemplateIR, binding: string, resolve: Resolver | undefined): Hole | undefined {
  for (const hole of ir.holes) {
    if (hole.binding === binding) return hole
    const content = hole.children ? resolve?.(hole.children) : undefined
    const inside = content ? holeFor(content, binding, resolve) : undefined
    if (inside) return inside
  }
  return undefined
}

/**
 * Applies a path-keyed delta (`rows[3].qty`) onto a base value set. Given the template it also
 * inverts the projections the delta addressed through, which is what makes "apply the delta to
 * the base and render again" comparable to rendering the new values. Without one, a path into
 * an instance lands under the instance's binding and is inert — right for a client writing into
 * the DOM it already has, wrong for anybody rebuilding the values.
 */
export function applyDelta(base: Values, delta: DeltaPayload, ir?: TemplateIR, resolve?: Resolver): Values {
  const next = structuredClone(base) as Values
  for (const [addressed, value] of Object.entries(delta.changed)) {
    const path = ir ? invertPath(addressed, ir, resolve) : addressed
    if (!path) continue
    let cursor: Record<string, Json> | Json[] = next as Record<string, Json>
    const tokens = path.split('.')
    tokens.forEach((token, i) => {
      const m = PATH_TOKEN.exec(token)
      if (!m) throw new Error(`E_DELTA_PATH: ${path}`)
      const key = m[1] as string
      const index = m[2] === undefined ? undefined : Number(m[2])
      const last = i === tokens.length - 1

      const container = cursor as Record<string, Json>
      if (last && index === undefined) {
        container[key] = value as Json
        return
      }
      let node = container[key]
      if (node === undefined || node === null) {
        node = index === undefined ? {} : []
        container[key] = node
      }
      if (index === undefined) {
        cursor = node as Record<string, Json>
        return
      }
      const arr = node as Json[]
      if (last) {
        arr[index] = value as Json
        return
      }
      if (arr[index] === undefined || arr[index] === null) arr[index] = {}
      cursor = arr[index] as Record<string, Json>
    })
  }
  return next
}

export function byteLength(
  ir: TemplateIR,
  supplied: Values,
  resolve?: Resolver,
  frame?: ChildrenFrame,
): number {
  const values = resolveDerived(ir.derived, supplied)
  let total = 0
  for (let i = 0; i < ir.segments.length; i++) {
    total += (ir.segments[i] as Uint8Array).length
    const hole = ir.holes[i]
    if (!hole) continue
    if (hole.kind === 'component') {
      if (hole.isolated) continue
      const inner = childrenFrame(hole, values, resolve, frame)
      total += byteLength(child(hole, resolve), componentValues(hole, values), resolve, inner)
      continue
    }
    if (hole.kind === 'children') {
      if (frame) total += byteLength(frame.ir, frame.values, resolve, frame.outer)
      continue
    }
    total += renderHole(hole, values[hole.binding], resolve).length
  }
  return total
}
