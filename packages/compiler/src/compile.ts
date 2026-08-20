import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseSync } from 'oxc-parser'
import {
  assertValidTemplate,
  draftTemplate,
  seal,
  type EffectSet,
  type Json,
  type SignalDecl,
  type TemplateIR,
} from '../../ir/src/index.ts'
import { name, node, nodes, type Node } from './ast.ts'
import { CompileError, locate } from './errors.ts'
import { inferEffects } from './effects.ts'
import { lower, returnedJsx, type ImportRef, type Lowered, type Scope } from './lower.ts'
import { createTypeOracle, type TypeOracle } from './types.ts'

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
  /** Type information for escape elision. Without it the compiler escapes by default. */
  types?: TypeOracle
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

interface Params {
  props: Set<string>
  ctxParam?: string
}

/**
 * `fragment((ctx) => …)` takes the context. `fragment(({ a, b }) => …)` takes props.
 * `fragment(({ a }, ctx) => …)` takes both. A bare identifier is always the context,
 * because a fragment that needs props destructures them.
 */
function readParams(params: Node[]): Params {
  const props = new Set<string>()
  const first = params[0]
  const second = params[1]

  if (second && second.type === 'Identifier') {
    collectProps(first, props)
    return { props, ctxParam: name(second) }
  }
  if (first && first.type === 'Identifier') return { props, ctxParam: name(first) }
  collectProps(first, props)
  return { props }
}

function collectProps(param: Node | undefined, into: Set<string>): void {
  if (!param || param.type !== 'ObjectPattern') return
  for (const property of nodes(param.properties)) {
    if (property.type === 'Property') into.add(name(node(property.key)))
  }
}

/** Anything the body computes can be interpolated, whatever it was computed from. */
function readLocals(body: Node): Set<string> {
  const locals = new Set<string>()
  if (body.type !== 'BlockStatement') return locals
  for (const statement of nodes(body.body)) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declarator of nodes(statement.declarations)) {
      const id = node(declarator.id)
      if (id.type === 'Identifier') locals.add(name(id))
    }
  }
  return locals
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
async function sealTree(lowered: Lowered, effects?: EffectSet): Promise<{ entry: TemplateIR; all: TemplateIR[] }> {
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
    ...(effects ? { effects } : {}),
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
    const { props, ctxParam } = readParams(nodes(fn.params))
    const locals = readLocals(body)
    const scope: Scope = {
      props,
      signals,
      imports,
      locals,
      ...(ctxParam ? { ctxParam } : {}),
    }
    const id = `${moduleId(file, options?.root)}#${exportName}`
    const input = { id, root: body, scope, file, source, ...(options?.types ? { types: options.types } : {}) }
    const root = body.type === 'BlockStatement' ? returnedJsx(body, input) : body

    const effects = inferEffects({ fn, file, source, ...(ctxParam ? { ctxParam } : {}) })
    const lowered = lower({ ...input, root })
    const { entry, all } = await sealTree(lowered, effects)
    fragments.push({ entry, templates: all, exportName })
  }

  return { file, fragments }
}

export async function compileFile(path: string, options?: CompileOptions): Promise<CompiledModule> {
  return compileSource(await readFile(path, 'utf8'), path, options)
}

/**
 * Compiles with type information. Building a checker over the whole file set once is
 * far cheaper than one program per file, so this is the entry point a build should use.
 */
export async function compileFiles(
  files: string[],
  options?: Omit<CompileOptions, 'types'> & { types?: boolean },
): Promise<{ modules: CompiledModule[]; diagnostics: string[] }> {
  let oracle: TypeOracle | undefined
  let diagnostics: string[] = []
  if (options?.types !== false) {
    try {
      oracle = createTypeOracle(files, options?.root)
      diagnostics = oracle.diagnostics()
    } catch {
      // TypeScript is an optional peer: without it the compiler falls back to syntax.
      oracle = undefined
    }
  }
  try {
    const modules: CompiledModule[] = []
    for (const file of files) {
      modules.push(
        await compileFile(file, {
          ...(options?.root ? { root: options.root } : {}),
          ...(oracle ? { types: oracle } : {}),
        }),
      )
    }
    return { modules, diagnostics }
  } finally {
    // The checker runs as a separate process; leaving it up would hang the caller.
    oracle?.dispose()
  }
}
