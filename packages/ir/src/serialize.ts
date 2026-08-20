import type { Json, TemplateIR } from './template-ir.ts'
import { TEMPLATE_IR_SPEC, TEMPLATE_IR_VERSION, accepts, migrate } from './version.ts'
import { validateTemplate } from './validate.ts'

const KNOWN_KEYS = new Set([
  'spec',
  'irVersion',
  'id',
  'version',
  'segments',
  'holes',
  'wiring',
  'signals',
  'forms',
  'effects',
  'meta',
])

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export interface SerializedTemplate {
  spec: string
  irVersion: string
  id: string
  version: string
  encoding: 'base64'
  segments: string[]
  holes: Json
  wiring: Json
  signals: Json
  forms: Json
  effects: Json
  meta?: Json
  [k: string]: Json | undefined
}

export function toJSON(ir: TemplateIR, forward: Record<string, Json> = {}): SerializedTemplate {
  return {
    ...forward,
    spec: ir.spec,
    irVersion: ir.irVersion,
    id: ir.id,
    version: ir.version,
    encoding: 'base64',
    segments: ir.segments.map(toBase64),
    holes: ir.holes as unknown as Json,
    wiring: ir.wiring as unknown as Json,
    signals: ir.signals as unknown as Json,
    forms: ir.forms as unknown as Json,
    effects: ir.effects as unknown as Json,
    ...(ir.meta ? { meta: ir.meta as unknown as Json } : {}),
  }
}

export interface ParseResult {
  ir: TemplateIR
  /** Fields a newer minor added. Kept so a re-emit does not silently drop them. */
  forward: Record<string, Json>
  migrationsApplied: string[]
  mode: 'exact' | 'upgrade' | 'forward'
}

export function fromJSON(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) throw new Error('E_NOT_A_DOCUMENT')
  const raw = input as Record<string, Json>

  const acc = accepts(raw)
  if (!acc.ok) throw new Error(`${acc.code}: ${acc.reason}`)

  const { doc, applied } = acc.mode === 'upgrade' ? migrate({ ...raw }) : { doc: { ...raw }, applied: [] as string[] }

  const forward: Record<string, Json> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_KEYS.has(k) && k !== 'encoding' && v !== undefined) forward[k] = v as Json
  }

  if (doc.encoding !== undefined && doc.encoding !== 'base64') {
    throw new Error(`E_ENCODING_UNSUPPORTED: ${String(doc.encoding)}`)
  }

  const segments = Array.isArray(doc.segments) ? (doc.segments as string[]).map(fromBase64) : []

  const ir: TemplateIR = {
    spec: TEMPLATE_IR_SPEC,
    irVersion: acc.mode === 'forward' ? (doc.irVersion as string) : TEMPLATE_IR_VERSION,
    id: String(doc.id ?? ''),
    version: String(doc.version ?? ''),
    segments,
    holes: (doc.holes ?? []) as TemplateIR['holes'],
    wiring: (doc.wiring ?? []) as TemplateIR['wiring'],
    signals: (doc.signals ?? []) as TemplateIR['signals'],
    forms: (doc.forms ?? []) as TemplateIR['forms'],
    effects: (doc.effects ?? { reads: [], writes: [], envelope: [], residency: 'server' }) as TemplateIR['effects'],
    ...(doc.meta ? { meta: doc.meta as Record<string, Json> } : {}),
  }

  const check = validateTemplate(ir)
  if (!check.ok) {
    throw new Error(`E_INVALID_DOCUMENT:\n${check.errors.map((e) => `  ${e.code} at ${e.at}: ${e.message}`).join('\n')}`)
  }

  return { ir, forward, migrationsApplied: applied, mode: acc.mode }
}

export function stringify(ir: TemplateIR, forward?: Record<string, Json>): string {
  return JSON.stringify(toJSON(ir, forward), null, 2)
}

export function parse(text: string): ParseResult {
  return fromJSON(JSON.parse(text))
}
