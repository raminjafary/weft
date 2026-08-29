import type { Json, TemplateIR, Values } from './template-ir.ts'

const utf8 = new TextEncoder()

/** Deterministic JSON: object keys sorted, so a hash is stable across emitters. */
export function canonicalJson(value: Json | undefined): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`).join(',')}}`
}

/** The bytes a template version is a hash of. `meta` is excluded on purpose. See `spec/ir/template-ir-2.md`. */
export function templateFingerprint(ir: TemplateIR): Uint8Array {
  const head = utf8.encode(
    canonicalJson({
      spec: ir.spec,
      irVersion: ir.irVersion,
      id: ir.id,
      holes: ir.holes as unknown as Json,
      wiring: ir.wiring as unknown as Json,
      signals: ir.signals as unknown as Json,
      derived: ir.derived as unknown as Json,
      forms: ir.forms as unknown as Json,
      effects: ir.effects as unknown as Json,
    }),
  )
  let total = head.length + 4
  for (const s of ir.segments) total += 4 + s.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let off = 0
  view.setUint32(off, head.length)
  off += 4
  out.set(head, off)
  off += head.length
  for (const s of ir.segments) {
    view.setUint32(off, s.length)
    off += 4
    out.set(s, off)
    off += s.length
  }
  return out
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Template versions get a real digest: SHA-256 truncated to 128 bits. See `spec/ir/template-ir-2.md`. */
export async function templateVersion(ir: TemplateIR): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', templateFingerprint(ir) as unknown as ArrayBuffer)
  return hex(new Uint8Array(digest).subarray(0, 16))
}

/** Stamp a template with a hash of its own content. After this, its version *is* its identity. */
export async function seal(ir: TemplateIR): Promise<TemplateIR> {
  return { ...ir, version: await templateVersion(ir) }
}

/** FNV-1a over two 32-bit lanes. Used only where a collision is cheap. See `spec/ir/template-ir-2.md`. */
export function fastHash(input: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** The content address of one render, which is what a client names when it asks for a delta. */
export function baseRenderId(ir: TemplateIR, values: Values): string {
  return fastHash(`${ir.version}|${canonicalJson(values as unknown as Json)}`)
}

/** A hash shortened for a log or a report. Never for a key. */
export function short(hash: string, n = 6): string {
  return hash.slice(0, n)
}
