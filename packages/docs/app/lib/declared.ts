import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { escapeHtml } from './escape.ts'

/**
 * The declaration surfaces, read out of the source: one entry per property, its doc comment, its
 * type as written, and (for the config) the default the loader actually applies. `surface.ts`
 * already answers "what is exported"; this answers "what may I put in `weft.config.ts`" — a whole
 * interface as one signature once truncated `WeftConfig` at 880 characters, dropping 29 options.
 * `docs.test.ts` asserts every member appears on the page.
 */
export interface Field {
  name: string
  optional: boolean
  /** The type as written in the source, with newlines collapsed. */
  type: string
  /** The block comment above it, comment syntax stripped. Empty when there was none. */
  doc: string
  /** The members of an inline object-literal type, one level down. Empty otherwise. */
  members: Field[]
}

export interface Declaration {
  name: string
  /** Repository-relative, so a reader can open it. */
  file: string
  doc: string
  fields: Field[]
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

interface Node_ {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

interface Comment {
  /** `Block` or `Line`. Only a block comment is a doc comment. */
  type: string
  value: string
  start: number
  end: number
}

interface Parsed {
  source: string
  program: Node_
  comments: Comment[]
}

const files = new Map<string, Parsed>()

function parsed(file: string): Parsed {
  const held = files.get(file)
  if (held) return held
  const source = readFileSync(join(ROOT, file), 'utf8')
  const result = parseSync(file, source, { sourceType: 'module' })
  const value = {
    source,
    program: result.program as unknown as Node_,
    comments: (result.comments ?? []) as unknown as Comment[],
  }
  files.set(file, value)
  return value
}

function nodes(value: unknown): Node_[] {
  return Array.isArray(value) ? (value as Node_[]) : []
}

function node(value: unknown): Node_ | undefined {
  return value && typeof value === 'object' ? (value as Node_) : undefined
}

/** The block comment immediately above a node. Line comments are excluded deliberately — `ports.ts`'s `// ── section ──` banners once leaked in as descriptions. */
function docFor(file: Parsed, start: number): string {
  let best: Comment | undefined
  for (const comment of file.comments) {
    if (comment.type !== 'Block') continue
    if (comment.end > start) continue
    if (file.source.slice(comment.end, start).trim() !== '') continue
    if (!best || comment.end > best.end) best = comment
  }
  if (!best) return ''
  return best.value
    .replace(/^\*/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim()
}

/** A type as one line. A multi-line object literal is still a type, and a table cell is one row. */
function oneLine(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** A member's type, as written. A method signature has no type annotation to slice, so it's rebuilt as the arrow form a reader would write instead. */
function typeOf(file: Parsed, member: Node_): string {
  if (member.type === 'TSMethodSignature') {
    const args = nodes(member.params)
      .map((param) => {
        const name = typeof param.name === 'string' ? param.name : '…'
        const annotated = node(node(param.typeAnnotation)?.typeAnnotation)
        return annotated ? `${name}: ${renderType(file, annotated)}` : name
      })
      .join(', ')
    const returned = node(node(member.returnType)?.typeAnnotation)
    return `(${args}) => ${returned ? renderType(file, returned) : 'void'}`
  }
  const inner = node(node(member.typeAnnotation)?.typeAnnotation)
  return inner ? renderType(file, inner) : 'unknown'
}

/** A type as one line. An object literal is rebuilt from its members rather than sliced, since collapsing its newlines would drop the `;` separators a one-line type needs. */
function renderType(file: Parsed, type: Node_): string {
  if (type.type === 'TSTypeLiteral') {
    const members = nodes(type.members).map((member) => {
      const key = node(member.key)
      const name = key && typeof key.name === 'string' ? key.name : '…'
      return `${name}${member.optional ? '?' : ''}: ${typeOf(file, member)}`
    })
    return members.length ? `{ ${members.join('; ')} }` : '{}'
  }
  if (type.type === 'TSArrayType') {
    const element = node(type.elementType)
    if (element?.type === 'TSTypeLiteral') return `${renderType(file, element)}[]`
  }
  return oneLine(file.source.slice(type.start, type.end))
}

/** The object literal behind a type, when there is one: `{ a: A }` and `{ a: A }[]` both have one. */
function literalOf(member: Node_): Node_ | undefined {
  const inner = node(node(member.typeAnnotation)?.typeAnnotation)
  if (!inner) return undefined
  if (inner.type === 'TSTypeLiteral') return inner
  if (inner.type === 'TSArrayType') {
    const element = node(inner.elementType)
    if (element?.type === 'TSTypeLiteral') return element
  }
  return undefined
}

function fieldOf(file: Parsed, member: Node_, deep: boolean): Field | undefined {
  const key = node(member.key)
  const name = key && typeof key.name === 'string' ? key.name : undefined
  if (!name) return undefined
  const literal = deep ? literalOf(member) : undefined
  return {
    name,
    optional: member.optional === true,
    type: typeOf(file, member),
    doc: docFor(file, member.start),
    members: literal ? nodes(literal.members).flatMap((m) => fieldOf(file, m, false) ?? []) : [],
  }
}

/** One interface, as its members. Finds both `export interface X` and a bare `interface X` — not every declared shape is also exported. */
export function declarationOf(file: string, name: string): Declaration {
  const source = parsed(file)
  for (const statement of nodes(source.program.body)) {
    const declaration = node(statement.declaration) ?? statement
    if (declaration.type !== 'TSInterfaceDeclaration') continue
    const id = node(declaration.id)
    if (!id || id.name !== name) continue
    const body = node(declaration.body)
    return {
      name,
      file,
      doc: docFor(source, statement.start),
      fields: nodes(body?.body).flatMap((member) => fieldOf(source, member, true) ?? []),
    }
  }
  throw new Error(`E_DOCS_NO_DECLARATION: ${file} declares no interface named ${name}`)
}

/**
 * What the loader falls back to, keyed by the config path — read from the `??` expressions in the
 * resolver rather than typed into a table nobody updates when a default changes. A fallback that's
 * itself computed from the config comes back with `config` still in it; the page says "derived".
 */
export function defaultsOf(file: string, variable = 'config'): Map<string, string> {
  const { source } = parsed(file)
  const out = new Map<string, string>()
  const chain = new RegExp(`\\b${variable}((?:\\??\\.[A-Za-z0-9_$]+)+)\\s*\\?\\?\\s*`, 'g')
  for (const match of source.matchAll(chain)) {
    const path = (match[1] as string).replaceAll('?.', '.').slice(1)
    const from = match.index + match[0].length
    const expression = expressionAt(source, from)
    if (expression && !out.has(path)) out.set(path, expression)
  }

  // The other shape: a comparison narrowing a union, with no `??` to read — e.g. `config.x === 'a' ? 'a' : 'b'`.
  const narrowed = new RegExp(
    `\\b${variable}((?:\\??\\.[A-Za-z0-9_$]+)+)\\s*===\\s*'[^']*'\\s*\\?[^:]+:\\s*('[^']*')`,
    'g',
  )
  for (const match of source.matchAll(narrowed)) {
    const path = (match[1] as string).replaceAll('?.', '.').slice(1)
    if (!out.has(path)) out.set(path, match[2] as string)
  }
  return out
}

/** One expression, ending at the first delimiter that is not inside brackets or a string. */
function expressionAt(source: string, from: number): string {
  let depth = 0
  let quote = ''
  for (let at = from; at < source.length; at++) {
    const char = source[at] as string
    if (quote) {
      if (char === '\\') at++
      else if (char === quote) quote = ''
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) return source.slice(from, at).trim()
      depth--
    } else if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
      return source.slice(from, at).trim()
    }
  }
  return ''
}

/** A doc comment as inline HTML: backticks become `<code>`, nothing else is interpreted. Escaped first, so it's safe for a `raw()` hole. */
export function docHtml(text: string): string {
  return escapeHtml(text.replace(/\s+/g, ' ')).replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** A doc comment as paragraphs, each already inline-rendered. */
export function docParagraphs(doc: string): string[] {
  if (!doc.trim()) return []
  return doc
    .split(/\n\s*\n/)
    .map((paragraph) => docHtml(paragraph))
    .filter((html) => html.length > 0)
}

/** Every interface a file declares, in source order. Names only; `declarationOf` reads one. */
export function interfacesIn(file: string): string[] {
  const source = parsed(file)
  const out: string[] = []
  for (const statement of nodes(source.program.body)) {
    const declaration = node(statement.declaration) ?? statement
    if (declaration.type !== 'TSInterfaceDeclaration') continue
    const id = node(declaration.id)
    if (id && typeof id.name === 'string') out.push(id.name)
  }
  return out
}

/** What one interface extends, by name. `interface MemoryStore extends StorePort` is `['StorePort']`. */
export function extendsOf(file: string, name: string): string[] {
  const source = parsed(file)
  for (const statement of nodes(source.program.body)) {
    const declaration = node(statement.declaration) ?? statement
    if (declaration.type !== 'TSInterfaceDeclaration') continue
    const id = node(declaration.id)
    if (!id || id.name !== name) continue
    return nodes(declaration.extends).flatMap((clause) => {
      const expression = node(clause.expression)
      return expression && typeof expression.name === 'string' ? [expression.name] : []
    })
  }
  return []
}

export interface ExportedFunction {
  name: string
  doc: string
  /** The return type as written, or empty when it was not annotated. */
  returns: string
  file: string
}

/** Every `export function` in a file, with its doc comment and its declared return type. */
export function functionsIn(file: string): ExportedFunction[] {
  const source = parsed(file)
  const out: ExportedFunction[] = []
  for (const statement of nodes(source.program.body)) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = node(statement.declaration)
    if (!declaration || declaration.type !== 'FunctionDeclaration') continue
    const id = node(declaration.id)
    if (!id || typeof id.name !== 'string') continue
    const returned = node(node(declaration.returnType)?.typeAnnotation)
    out.push({
      name: id.name,
      doc: docFor(source, statement.start),
      returns: returned ? oneLine(source.source.slice(returned.start, returned.end)) : '',
      file,
    })
  }
  return out
}

export interface TypeAlias {
  name: string
  /** The aliased type as written. */
  type: string
}

/** Every `export type X = …` in a file. An adapter's branded return is usually one of these. */
export function typeAliasesIn(file: string): TypeAlias[] {
  const source = parsed(file)
  const out: TypeAlias[] = []
  for (const statement of nodes(source.program.body)) {
    const declaration = node(statement.declaration) ?? statement
    if (declaration.type !== 'TSTypeAliasDeclaration') continue
    const id = node(declaration.id)
    const annotation = node(declaration.typeAnnotation)
    if (!id || typeof id.name !== 'string' || !annotation) continue
    out.push({ name: id.name, type: oneLine(source.source.slice(annotation.start, annotation.end)) })
  }
  return out
}
