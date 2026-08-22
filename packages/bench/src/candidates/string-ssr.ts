import { componentValues, resolveDerived, type Hole, type Json, type TemplateIR, type Values } from '@weft/ir'
import type { Candidate, ServeHandle, ServeOptions, UpdatePayloads } from '../candidate.ts'
import { compileScenario, compiledFor, type Compiled } from '../compiled.ts'
import { sleep, type Scenario } from '../workloads/index.ts'
import { createServer } from 'node:http'

const utf8 = new TextEncoder()
const decoder = new TextDecoder()

interface StringTemplate {
  parts: string[]
  holes: Hole[]
}

/** The control has to carry a call site's children too, or it is not rendering the same page. */
interface Frame {
  ir: TemplateIR
  values: Values
  outer?: Frame
}

const templates = new Map<string, StringTemplate>()

/**
 * What a string-concatenation SSR compiler would have emitted from the same source:
 * the segments as JavaScript string literals rather than as bytes.
 */
function asStrings(ir: TemplateIR): StringTemplate {
  const hit = templates.get(ir.version)
  if (hit) return hit
  const value: StringTemplate = { parts: ir.segments.map((s) => decoder.decode(s)), holes: ir.holes }
  templates.set(ir.version, value)
  return value
}

function escape(s: string, attr: boolean): string {
  let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (attr) out = out.replace(/"/g, '&quot;')
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

function renderTemplate(ir: TemplateIR, supplied: Values, compiled: Compiled, frame?: Frame): string {
  // The control has to compute derived values too, or it is not rendering the same
  // template. What is being compared is segment copying against string concatenation.
  const values = resolveDerived(ir.derived, supplied)
  const template = asStrings(ir)
  let out = ''
  for (let i = 0; i < template.parts.length; i++) {
    out += template.parts[i]
    const hole = template.holes[i]
    if (!hole) continue
    const value = values[hole.binding]
    switch (hole.kind) {
      case 'slot':
        break
      case 'component': {
        const nested = hole.nested ? compiled.resolve(hole.nested) : undefined
        if (!nested) throw new Error(`E_NESTED_UNRESOLVED: ${hole.nested ?? 'unnamed'}`)
        const content = hole.children ? compiled.resolve(hole.children) : undefined
        if (hole.children && !content) throw new Error(`E_NESTED_UNRESOLVED: ${hole.children}`)
        out += renderTemplate(
          nested,
          componentValues(hole, values),
          compiled,
          content ? { ir: content, values, ...(frame ? { outer: frame } : {}) } : undefined,
        )
        break
      }
      case 'children': {
        if (frame) out += renderTemplate(frame.ir, frame.values, compiled, frame.outer)
        break
      }
      case 'attr-bool':
        if (truthy(value)) out += hole.attr ?? ''
        break
      case 'attr-presence':
        if (truthy(value)) out += `${hole.attr ?? ''}="${escape(stringify(value), true)}"`
        break
      case 'list': {
        if (!Array.isArray(value)) break
        const nested = hole.nested ? compiled.resolve(hole.nested) : undefined
        if (!nested) throw new Error(`E_NESTED_UNRESOLVED: ${hole.nested ?? 'unnamed'}`)
        for (const item of value) out += renderTemplate(nested, item as Values, compiled)
        break
      }
      default:
        out +=
          hole.escape === 'trusted-raw' ? stringify(value) : escape(stringify(value), hole.kind === 'attr')
    }
  }
  return out
}

function renderDocument(scenario: Scenario, values: Values, rows: Values[]): string {
  const compiled = compiledFor(scenario)
  const all = compiled.rowBinding
    ? { ...values, [compiled.rowBinding]: rows as unknown as Values[string] }
    : values
  return renderTemplate(compiled.root, all, compiled)
}

/**
 * The control flushes early too — that is what streaming SSR does — but it has to build
 * each piece as a string before it can send it, and it cannot know the total length in
 * advance, so the response is chunked.
 */
function renderSplit(
  scenario: Scenario,
  supplied: Values,
  rows: Values[],
): { prefix: string; rest: string } | null {
  const compiled = compiledFor(scenario)
  const listIndex = compiled.root.holes.findIndex((h) => h.kind === 'list')
  if (listIndex < 0 || !compiled.row) return null

  const values = resolveDerived(compiled.root.derived, supplied)
  const template = asStrings(compiled.root)
  let prefix = ''
  for (let i = 0; i <= listIndex; i++) {
    prefix += template.parts[i]
    const hole = template.holes[i]
    if (hole && i < listIndex) {
      prefix +=
        hole.escape === 'trusted-raw'
          ? stringify(values[hole.binding])
          : escape(stringify(values[hole.binding]), hole.kind === 'attr')
    }
  }

  let rest = ''
  for (const row of rows) rest += renderTemplate(compiled.row, row, compiled)
  // A segment always precedes the hole that follows it; reversing these silently
  // relocates a value and keeps the byte count identical.
  for (let i = listIndex + 1; i < template.parts.length; i++) {
    rest += template.parts[i]
    const hole = template.holes[i]
    if (hole) {
      rest +=
        hole.escape === 'trusted-raw'
          ? stringify(values[hole.binding])
          : escape(stringify(values[hole.binding]), hole.kind === 'attr')
    }
  }
  return { prefix, rest }
}

export const stringSsrCandidate: Candidate = {
  id: 'string-ssr',
  label: 'String-concatenation SSR (control)',
  mechanism:
    'The same compiled templates as JavaScript strings rather than bytes: build the document by concatenation, escape every interpolation, encode to bytes once at the end. No precomputed shell.',

  render(scenario, values, rows) {
    return utf8.encode(renderDocument(scenario, values, rows))
  },

  updateForms(scenario, values, _prev, next): UpdatePayloads {
    return { html: utf8.encode(renderDocument(scenario, values, next)) }
  },

  unsupported: {
    'update-bytes:delta':
      'no addressable base render to diff against, and no resident template to write into',
  },

  async serve(scenario, options?: ServeOptions): Promise<ServeHandle> {
    await compileScenario(scenario)
    const values = scenario.values()
    const rows = scenario.rows()
    const stream = (options?.transport ?? 'stream') === 'stream'
    const server = createServer((_req, res) => {
      const split = stream ? renderSplit(scenario, values, rows) : null
      if (!split) {
        const body = Buffer.from(renderDocument(scenario, values, rows))
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
        })
        res.end(body)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.write(split.prefix)
      if (!scenario.slowMs) {
        res.end(split.rest)
        return
      }
      void sleep(scenario.slowMs).then(() => {
        const fresh = renderSplit(scenario, values, scenario.rows())
        res.end(fresh ? fresh.rest : '')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address === 'string' || address === null) throw new Error('E_NO_ADDRESS')
    return {
      url: `http://127.0.0.1:${address.port}${scenario.route}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  },
}
