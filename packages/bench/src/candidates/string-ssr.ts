import type { Json, Values } from '../../../ir/src/index.ts'
import type { Candidate, ServeHandle, ServeOptions, UpdatePayloads } from '../candidate.ts'
import type { Authored, Scenario } from '../workloads/index.ts'
import { createServer } from 'node:http'

const utf8 = new TextEncoder()

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

/** The control path: concatenate strings, escape every interpolation, encode once. */
function renderAuthored(a: Authored, values: Values, listOverride?: string): string {
  let out = ''
  for (let i = 0; i < a.parts.length; i++) {
    out += a.parts[i]
    const hole = a.holes[i]
    if (!hole) continue
    const value = values[hole.binding]
    switch (hole.kind) {
      case 'slot':
        break
      case 'attr-bool':
        if (truthy(value)) out += hole.attr ?? ''
        break
      case 'attr-presence':
        if (truthy(value)) out += `${hole.attr ?? ''}="${escape(stringify(value), true)}"`
        break
      case 'list':
        if (listOverride !== undefined) out += listOverride
        else if (Array.isArray(value)) out += value.map((v) => stringify(v)).join('')
        break
      default: {
        const isAttr = hole.kind === 'attr'
        out += hole.escape === 'trusted-raw' ? stringify(value) : escape(stringify(value), isAttr)
      }
    }
  }
  return out
}

function renderDocument(scenario: Scenario, values: Values, rows: Values[]): string {
  if (!scenario.row) return renderAuthored(scenario.root, values)
  const rowsHtml = rows.map((r) => renderAuthored(scenario.row!.authored, r)).join('')
  return renderAuthored(scenario.root, values, rowsHtml)
}

/**
 * The control flushes early too — that is what streaming SSR does — but it has to
 * build each piece as a string before it can send it, and it cannot know the total
 * length in advance, so the response is chunked.
 */
function renderSplit(scenario: Scenario, values: Values, rows: Values[]): { prefix: string; rest: string } | null {
  const listIndex = scenario.root.holes.findIndex((h) => h.kind === 'list')
  if (listIndex < 0 || !scenario.row) return null
  const head: Authored = {
    ...scenario.root,
    parts: scenario.root.parts.slice(0, listIndex + 1),
    holes: scenario.root.holes.slice(0, listIndex),
  }
  const tail: Authored = {
    ...scenario.root,
    parts: scenario.root.parts.slice(listIndex + 1),
    holes: scenario.root.holes.slice(listIndex + 1),
  }
  const rowsHtml = rows.map((r) => renderAuthored(scenario.row!.authored, r)).join('')
  return { prefix: renderAuthored(head, values), rest: rowsHtml + renderAuthored(tail, values) }
}

export const stringSsrCandidate: Candidate = {
  id: 'string-ssr',
  label: 'String-concatenation SSR (control)',
  mechanism:
    'The path Solid and Svelte SSR take: build the document as a JavaScript string, escape every interpolation, encode to bytes once at the end. No precomputed shell.',

  render(scenario, values, rows) {
    return utf8.encode(renderDocument(scenario, values, rows))
  },

  updateForms(scenario, values, _prev, next): UpdatePayloads {
    return { html: utf8.encode(renderDocument(scenario, values, next)) }
  },

  unsupported: {
    'update-bytes:data': 'no template on the client to project values through',
    'update-bytes:delta': 'no addressable base render to diff against',
  },

  async serve(scenario, options?: ServeOptions): Promise<ServeHandle> {
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
      res.end(split.rest)
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
