import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseSync } from 'oxc-parser'
import {
  assertValidTemplate,
  draftTemplate,
  seal,
  type Json,
  type SignalDecl,
  type TemplateIR,
} from '../../ir/src/index.ts'
import { name, node, nodes, type Node } from './ast.ts'
import { CompileError, locate } from './errors.ts'
import { lower, returnedJsx, type ImportRef, type Lowered, type Scope } from './lower.ts'

export interface CompiledFragment {
  /** The root template, plus every nested row template it needs, sealed. */
  entry: TemplateIR
  templates: TemplateIR[]
  exportName: string
}

export interface CompiledModule {
  file: string
  fragments: CompiledFragment[]
}

export interface CompileOptions {
  /**
   * Template ids are stated relative to this directory. Ids feed the content hash, so
   * an absolute path would make a template's version depend on where it was checked out.
   */
  root?: string
}

function moduleId(file: string, root?: string): string {
  const base = root ?? process.cwd()
  const rel = relative(base, isAbsolute(file) ? file : resolve(base, file))
  const normalized = (rel === '' ? file : rel).split(sep).join('/')
  return normalized.startsWith('..') ? normalized : normalized.replace(/^\.\//, '')
}

function readImports(program: Node): Map<string, ImportRef> {
  const imports = new Map<string, ImportRef>()
  for (const statement of nodes(program.body)) {
    if (statement.type !== 'ImportDeclaration') continue
    const module = String(node(statement.source).value ?? '')
    for (const specifier of nodes(statement.specifiers)) {
      const local = name(node(specifier.local))
      const exported =
        specifier.type === 'ImportSpecifier' ? name(node(specifier.imported)) : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*'
      imports.set(local, { module, exported })
    }
  }
  return imports
}

function signalType(init: Node | undefined): SignalDecl['type'] {
  if (!init) return 'json'
  if (init.type === 'Literal') {
    if (typeof init.value === 'number') return 'number'
    if (typeof init.value === 'boolean') return 'boolean'
    if (typeof init.value === 'string') return 'string'
  }
  return 'json'
}

function readSignals(body: Node, imports: Map<string, ImportRef>): Map<string, SignalDecl> {
  const signals = new Map<string, SignalDecl>()
  if (body.type !== 'BlockStatement') return signals
  for (const statement of nodes(body.body)) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declarator of nodes(statement.declarations)) {
      const init = declarator.init ? node(declarator.init) : undefined
      if (!init || init.type !== 'CallExpression') continue
      const callee = node(init.callee)
      if (callee.type !== 'Identifier') continue
      const imported = imports.get(name(callee))
      if (!imported || imported.exported !== 'signal') continue
      const id = name(node(declarator.id))
      const first = nodes(init.arguments)[0]
      const decl: SignalDecl = { id, type: signalType(first) }
      if (first && first.type === 'Literal' && first.value !== undefined && first.value !== null) {
        decl.init = first.value as Json
      }
      signals.set(id, decl)
    }
  }
  return signals
}

function readProps(param: Node | undefined): { props: Set<string>; propsIdent?: string } {
  const props = new Set<string>()
  if (!param) return { props }
  if (param.type === 'Identifier') return { props, propsIdent: name(param) }
  if (param.type === 'ObjectPattern') {
    for (const property of nodes(param.properties)) {
      if (property.type === 'Property') props.add(name(node(property.key)))
    }
  }
  return { props }
}

function fragmentCall(declaration: Node, imports: Map<string, ImportRef>): Node | null {
  if (declaration.type !== 'CallExpression') return null
  const callee = node(declaration.callee)
  if (callee.type !== 'Identifier') return null
  const imported = imports.get(name(callee))
  if (!imported || imported.exported !== 'fragment') return null
  return declaration
}

interface Discovered {
  exportName: string
  call: Node
}

function discover(program: Node, imports: Map<string, ImportRef>): Discovered[] {
  const found: Discovered[] = []
  for (const statement of nodes(program.body)) {
    if (statement.type === 'ExportDefaultDeclaration') {
      const call = fragmentCall(node(statement.declaration), imports)
      if (call) found.push({ exportName: 'default', call })
      continue
    }
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      const declaration = node(statement.declaration)
      if (declaration.type !== 'VariableDeclaration') continue
      for (const declarator of nodes(declaration.declarations)) {
        const call = declarator.init ? fragmentCall(node(declarator.init), imports) : null
        if (call) found.push({ exportName: name(node(declarator.id)), call })
      }
    }
  }
  return found
}

/** Nested rows are sealed first, so a parent can name the exact version it projects through. */
async function sealTree(lowered: Lowered): Promise<{ entry: TemplateIR; all: TemplateIR[] }> {
  const all: TemplateIR[] = []
  const holes = [...lowered.holes]

  for (const nested of lowered.nested) {
    const child = await sealTree(nested.lowered)
    all.push(...child.all)
    const parentHole = holes[nested.holeIndex]
    if (!parentHole) throw new Error(`E_NESTED_HOLE_MISSING: ${nested.id}`)
    holes[nested.holeIndex] = { ...parentHole, nested: child.entry.version }
  }

  const draft = draftTemplate({
    id: lowered.id,
    segments: lowered.parts,
    holes,
    wiring: lowered.wiring,
    signals: lowered.signals,
    meta: { markers: lowered.markers },
  })
  const entry = assertValidTemplate(await seal(draft))
  all.push(entry)
  return { entry, all }
}

export async function compileSource(source: string, file: string, options?: CompileOptions): Promise<CompiledModule> {
  const parsed = parseSync(file, source, { sourceType: 'module', preserveParens: false })
  if (parsed.errors.length) {
    const first = parsed.errors[0]
    throw new CompileError('E_PARSE', first?.message ?? 'parse failed', locate(file, source, 0))
  }

  const program = node(parsed.program)
  const imports = readImports(program)
  const fragments: CompiledFragment[] = []

  for (const { exportName, call } of discover(program, imports)) {
    const fn = nodes(call.arguments)[0]
    if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) {
      throw new CompileError('E_FRAGMENT_ARGUMENT', 'fragment() takes a function', locate(file, source, call.start ?? 0))
    }
    const body = node(fn.body)
    const signals = readSignals(body, imports)
    const { props, propsIdent } = readProps(nodes(fn.params)[0])
    const scope: Scope = { props, signals, imports, ...(propsIdent ? { propsIdent } : {}) }
    const id = `${moduleId(file, options?.root)}#${exportName}`
    const input = { id, root: body, scope, file, source }
    const root = body.type === 'BlockStatement' ? returnedJsx(body, input) : body

    const lowered = lower({ ...input, root })
    const { entry, all } = await sealTree(lowered)
    fragments.push({ entry, templates: all, exportName })
  }

  return { file, fragments }
}

export async function compileFile(path: string, options?: CompileOptions): Promise<CompiledModule> {
  return compileSource(await readFile(path, 'utf8'), path, options)
}
