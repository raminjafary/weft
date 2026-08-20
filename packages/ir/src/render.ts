import { resolveDerived } from './derived.ts'
import type { DeltaPayload, Hole, Json, TemplateIR, Values } from './template-ir.ts'

const utf8 = new TextEncoder()
const EMPTY = new Uint8Array(0)

const AMP = utf8.encode('&amp;')
const LT = utf8.encode('&lt;')
const GT = utf8.encode('&gt;')
const QUOT = utf8.encode('&quot;')

function needsEscape(s: string, attr: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 38 || c === 60 || c === 62) return true
    if (attr && c === 34) return true
  }
  return false
}

/** Escapes only when a scan proves it necessary — the runtime half of escape elision. */
export function escapeBytes(s: string, attr: boolean): Uint8Array {
  if (!needsEscape(s, attr)) return utf8.encode(s)
  const parts: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    let rep: Uint8Array | null = null
    if (c === 38) rep = AMP
    else if (c === 60) rep = LT
    else if (c === 62) rep = GT
    else if (attr && c === 34) rep = QUOT
    if (rep) {
      if (i > start) parts.push(utf8.encode(s.slice(start, i)))
      parts.push(rep)
      start = i + 1
    }
  }
  if (start < s.length) parts.push(utf8.encode(s.slice(start)))
  return concat(parts)
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

export function renderHole(hole: Hole, value: Json | undefined, resolve?: Resolver): Uint8Array {
  switch (hole.kind) {
    case 'slot':
      return EMPTY
    case 'attr-bool':
      return truthy(value) ? utf8.encode(hole.attr ?? '') : EMPTY
    case 'attr-presence': {
      if (!truthy(value)) return EMPTY
      const body =
        hole.escape === 'escape' ? escapeBytes(stringify(value), true) : utf8.encode(stringify(value))
      return concat([utf8.encode(`${hole.attr ?? ''}="`), body, utf8.encode('"')])
    }
    case 'list': {
      if (!Array.isArray(value)) return EMPTY
      if (hole.nested) {
        const nested = resolve?.(hole.nested)
        if (!nested) {
          throw new Error(`E_NESTED_UNRESOLVED: hole ${hole.index} needs template ${hole.nested}`)
        }
        return concat(value.map((item) => render(nested, item as Values, resolve)))
      }
      return concat(
        value.map((v) =>
          hole.escape === 'escape' ? escapeBytes(stringify(v), false) : utf8.encode(stringify(v)),
        ),
      )
    }
    default: {
      const attrContext = hole.kind === 'attr'
      const s = stringify(value)
      return hole.escape === 'escape' ? escapeBytes(s, attrContext) : utf8.encode(s)
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
      const written = writeTemplate(ir, values, resolve, scratch, 0)
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
  return writeTemplate(ir, values, resolve, out, offset) - offset
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
    case 'slot':
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
        for (const item of value) cursor = writeTemplate(nested, item as Values, resolve, out, cursor)
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
): number {
  const values = resolveDerived(ir.derived, supplied)
  let off = offset
  for (let i = 0; i < ir.segments.length; i++) {
    off = writeBytes(ir.segments[i] as Uint8Array, out, off)
    const hole = ir.holes[i]
    if (hole) off = writeValue(hole, values[hole.binding], out, off, resolve)
  }
  return off
}

export const renderHtml = render

/** A delta is only applicable to the template version it was computed against. */
export function assertSameTemplate(ir: TemplateIR, payload: { tpl: string }): void {
  if (payload.tpl !== ir.version) {
    throw new Error(`E_TPL_MISMATCH: payload targets ${payload.tpl}, template is ${ir.version}`)
  }
}

const PATH_TOKEN = /^([^[.]+)(?:\[(\d+)\])?$/

/** Applies a path-keyed delta (`rows[3].qty`) onto a base value set. */
export function applyDelta(base: Values, delta: DeltaPayload): Values {
  const next = structuredClone(base) as Values
  for (const [path, value] of Object.entries(delta.changed)) {
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

export function byteLength(ir: TemplateIR, supplied: Values, resolve?: Resolver): number {
  const values = resolveDerived(ir.derived, supplied)
  let total = 0
  for (let i = 0; i < ir.segments.length; i++) {
    total += (ir.segments[i] as Uint8Array).length
    const hole = ir.holes[i]
    if (hole) total += renderHole(hole, values[hole.binding], resolve).length
  }
  return total
}
