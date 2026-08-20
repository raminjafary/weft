import { accepts } from './version.ts'
import { derivableForms, type TemplateIR } from './template-ir.ts'
import { templateVersion } from './hash.ts'

export interface IrError {
  code: string
  at: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: IrError[]
}

const HEX128 = /^[0-9a-f]{32}$/

export function validateTemplate(ir: TemplateIR): ValidationResult {
  const errors: IrError[] = []
  const fail = (code: string, at: string, message: string) => errors.push({ code, at, message })

  const acc = accepts(ir)
  if (!acc.ok) fail(acc.code, 'spec', acc.reason)

  if (!ir.id) fail('E_ID_MISSING', 'id', 'template id is required')

  if (ir.version !== '' && !HEX128.test(ir.version)) {
    fail('E_VERSION_SHAPE', 'version', `expected 32 lowercase hex characters, got ${ir.version}`)
  }

  if (ir.segments.length !== ir.holes.length + 1) {
    fail(
      'E_SEGMENT_COUNT',
      'segments',
      `pre-encoded rendering interleaves segments and holes: expected ${ir.holes.length + 1} segments for ${ir.holes.length} holes, got ${ir.segments.length}`,
    )
  }

  const bindings = new Set<string>()
  ir.holes.forEach((h, i) => {
    bindings.add(h.binding)
    if (h.index !== i) fail('E_HOLE_INDEX', `holes[${i}]`, `hole index ${h.index} is out of order`)
    if (!h.binding) fail('E_HOLE_BINDING', `holes[${i}]`, 'hole has no binding id')
    if ((h.kind === 'attr' || h.kind === 'attr-bool' || h.kind === 'attr-presence') && !h.attr) {
      fail('E_HOLE_ATTR', `holes[${i}]`, `${h.kind} hole must name its attribute`)
    }
    if (h.escape === 'trusted-raw' && !h.provenance) {
      fail('E_RAW_UNVOUCHED', `holes[${i}]`, 'trusted-raw must name the source that vouches for it')
    }
    if (h.anchor !== undefined) {
      if (h.kind !== 'text') fail('E_ANCHOR_KIND', `holes[${i}]`, 'only a text hole follows a marker comment')
      if (!Number.isInteger(h.anchor) || h.anchor < 0) {
        fail('E_ANCHOR_SHAPE', `holes[${i}].anchor`, 'anchor is a non-negative marker ordinal')
      }
    }
    if (h.nested !== undefined) {
      if (h.kind !== 'list') fail('E_NESTED_KIND', `holes[${i}]`, 'only a list hole can name a nested template')
      if (!HEX128.test(h.nested)) {
        fail('E_NESTED_SHAPE', `holes[${i}].nested`, `nested must be a sealed template version, got ${h.nested}`)
      }
    }
    if (!h.path.every((p) => Number.isInteger(p) && p >= 0)) {
      fail('E_PATH_SHAPE', `holes[${i}].path`, 'paths are non-negative child indices')
    }
  })

  for (const s of ir.signals) bindings.add(s.id)

  ir.wiring.forEach((w, i) => {
    if (w.op !== 'event' && !bindings.has(w.binding)) {
      fail(
        'E_WIRING_UNKNOWN_BINDING',
        `wiring[${i}]`,
        `binding ${w.binding} is neither a hole nor a declared signal, so the client cannot resolve it`,
      )
    }
    if (w.op === 'event' && !w.event) fail('E_WIRING_EVENT', `wiring[${i}]`, 'event op must name an event')
    if (w.op === 'event' && !w.intent) {
      fail('E_WIRING_INTENT', `wiring[${i}]`, 'event op must name an intent id; the client never names server code')
    }
    if ((w.op === 'attr' || w.op === 'bool') && !w.attr) {
      fail('E_WIRING_ATTR', `wiring[${i}]`, `${w.op} op must name its attribute`)
    }
    if (w.anchor !== undefined) {
      if (w.op !== 'text') fail('E_ANCHOR_OP', `wiring[${i}]`, 'only a text op writes after a marker comment')
      if (!Number.isInteger(w.anchor) || w.anchor < 0) {
        fail('E_ANCHOR_SHAPE', `wiring[${i}].anchor`, 'anchor is a non-negative marker ordinal')
      }
    }
    if (!w.path.every((p) => Number.isInteger(p) && p >= 0)) {
      fail('E_PATH_SHAPE', `wiring[${i}].path`, 'paths are non-negative child indices')
    }
  })

  const provable = new Set(derivableForms(ir.holes))
  for (const f of ir.forms) {
    if (f === 'remote') continue
    if (!provable.has(f)) {
      fail(
        'E_FORM_UNPROVABLE',
        'forms',
        `form ${f} is declared but not derivable from this template's holes; equivalence cannot be proven`,
      )
    }
  }
  if (!ir.forms.includes('html')) {
    fail('E_FORM_FLOOR', 'forms', 'html is the version-independent fallback and must always be offered')
  }

  if (!['server', 'client', 'either'].includes(ir.effects.residency)) {
    fail('E_RESIDENCY', 'effects.residency', `unknown residency ${ir.effects.residency}`)
  }

  return { ok: errors.length === 0, errors }
}

export function assertValidTemplate(ir: TemplateIR): TemplateIR {
  const result = validateTemplate(ir)
  if (!result.ok) {
    throw new Error(
      `invalid ${ir.spec} document:\n${result.errors.map((e) => `  ${e.code} at ${e.at}: ${e.message}`).join('\n')}`,
    )
  }
  return ir
}

/** Confirms the content address actually addresses this content. */
export async function verifySealed(ir: TemplateIR): Promise<ValidationResult> {
  const base = validateTemplate(ir)
  if (ir.version === '') {
    return { ok: false, errors: [...base.errors, { code: 'E_VERSION_UNSEALED', at: 'version', message: 'template was never sealed' }] }
  }
  const expected = await templateVersion(ir)
  if (expected !== ir.version) {
    return {
      ok: false,
      errors: [
        ...base.errors,
        { code: 'E_VERSION_MISMATCH', at: 'version', message: `content hashes to ${expected}, document claims ${ir.version}` },
      ],
    }
  }
  return base
}
