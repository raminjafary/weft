import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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
import { cacheClassOf, unionEffects } from '../../ir/src/effects.ts'
import { lower, returnedJsx, type ComponentRef, type ImportRef, type Lowered, type Scope } from './lower.ts'
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

/** A fragment another module exported, resolved for the module that renders it. */
export interface ExternalFragment {
  id: string
  props: Set<string>
  entry: TemplateIR
  templates: TemplateIR[]
  effects: EffectSet
}

export interface CompileOptions {
  /**
   * Template ids are stated relative to this directory. Ids feed the content hash, so
   * an absolute path would make a template's version depend on where it was checked out.
   */
  root?: string
  /** Type information for escape elision. Without it the compiler escapes by default. */
  types?: TypeOracle
  /**
   * Fragments this module imports and renders, already compiled. Supplied by the build,
   * which is the only layer that knows the file set and can order compilation by
   * dependency. Keyed by module specifier and exported name, exactly as written.
   */
  external?: (module: string, exported: string) => ExternalFragment | undefined
  /**
   * Export names in this module that some other module renders. A composed fragment wires
   * its props, because a caller may hand one a signal; the module cannot see that on its
   * own, so the build tells it.
   */
  composedElsewhere?: ReadonlySet<string>
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
        specifier.type === 'ImportSpecifier'
          ? name(node(specifier.imported))
          : specifier.type === 'ImportDefaultSpecifier'
            ? 'default'
            : '*'
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
  /** The name the module knows it by, which is also how a sibling fragment renders it. */
  local: string
  exportName: string
  call: Node
  /** Only an exported fragment is an entry point; a local one exists to be composed. */
  exported: boolean
}

function discover(program: Node, imports: Map<string, ImportRef>): Discovered[] {
  const found: Discovered[] = []

  const fromDeclaration = (declaration: Node, exported: boolean): void => {
    if (declaration.type !== 'VariableDeclaration') return
    for (const declarator of nodes(declaration.declarations)) {
      const call = declarator.init ? fragmentCall(node(declarator.init), imports) : null
      if (!call) continue
      const local = name(node(declarator.id))
      found.push({ local, exportName: local, call, exported })
    }
  }

  for (const statement of nodes(program.body)) {
    if (statement.type === 'ExportDefaultDeclaration') {
      const call = fragmentCall(node(statement.declaration), imports)
      if (call) found.push({ local: 'default', exportName: 'default', call, exported: true })
      continue
    }
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      fromDeclaration(node(statement.declaration), true)
      continue
    }
    // A fragment that is never exported is not an entry point, but a sibling may still
    // render it — which is the ordinary shape of a component in one file.
    fromDeclaration(statement, false)
  }
  return found
}

/**
 * Stamps the holes whose instances the parent does not render. The nth component hole
 * corresponds to the nth entry in `components`, which is how the lowering records them.
 */
function markIsolated(lowered: Lowered, isolated: Set<number>): Lowered {
  if (isolated.size === 0) return lowered
  let seen = 0
  return {
    ...lowered,
    holes: lowered.holes.map((hole) => {
      if (hole.kind !== 'component') return hole
      const index = seen++
      return isolated.has(index) ? { ...hole, isolated: true } : hole
    }),
  }
}

/**
 * Which fragments are rendered by another fragment in this module. Read syntactically,
 * before anything is lowered, so the answer does not depend on the order the compiler
 * happens to reach them in — a template's version must not depend on that.
 */
function composedNames(declarations: Discovered[]): Set<string> {
  const used = new Set<string>()
  const stack: Node[] = declarations.map((d) => d.call)
  while (stack.length) {
    const current = stack.pop() as Node
    if (current.type === 'JSXOpeningElement') {
      const tag = name(node(current.name))
      if (/^[A-Z]/.test(tag)) used.add(tag)
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object') stack.push(node(item))
      } else if (value && typeof value === 'object' && 'type' in (value as Node)) {
        stack.push(node(value))
      }
    }
  }
  return used
}

/** Nested rows are sealed first, so a parent can name the exact version it projects through. */
async function sealTree(
  lowered: Lowered,
  effects?: EffectSet,
): Promise<{ entry: TemplateIR; all: TemplateIR[] }> {
  const all: TemplateIR[] = []
  const holes = [...lowered.holes]

  for (const nested of lowered.nested) {
    // A child from another module is already sealed; one from this module is sealed here,
    // which is what lets a parent name the exact version it projects through.
    const child = nested.sealed
      ? { entry: nested.sealed.entry, all: nested.sealed.templates }
      : await sealTree(nested.lowered as Lowered)
    // One component used five times is one sealed template, because the version is the
    // content. Emitting it five times would make a resident client store five copies.
    for (const template of child.all) {
      if (!all.some((t) => t.version === template.version)) all.push(template)
    }
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
    derived: lowered.derived,
    ...(effects ? { effects } : {}),
    meta: { markers: lowered.markers },
  })
  const entry = assertValidTemplate(await seal(draft))
  if (!all.some((t) => t.version === entry.version)) all.push(entry)
  return { entry, all }
}

export async function compileSource(
  source: string,
  file: string,
  options?: CompileOptions,
): Promise<CompiledModule> {
  const parsed = parseSync(file, source, { sourceType: 'module', preserveParens: false })
  if (parsed.errors.length) {
    const first = parsed.errors[0]
    throw new CompileError('E_PARSE', first?.message ?? 'parse failed', locate(file, source, 0))
  }

  const program = node(parsed.program)
  const imports = readImports(program)
  const fragments: CompiledFragment[] = []
  const declarations = discover(program, imports)

  /**
   * A fragment's own reads, before the fragments it renders are folded in. Keyed by the
   * name the module knows it by.
   */
  const own = new Map<string, EffectSet>()
  const lowerings = new Map<string, Lowered>()
  const inProgress = new Set<string>()

  const components = new Map<string, ComponentRef>()
  const composed = composedNames(declarations)
  const external = new Map<string, ExternalFragment>()

  const prepare = (found: Discovered): { lowered: Lowered; effects: EffectSet } => {
    const cached = lowerings.get(found.local)
    if (cached) return { lowered: cached, effects: own.get(found.local) as EffectSet }
    if (inProgress.has(found.local)) {
      throw new CompileError(
        'E_COMPONENT_CYCLE',
        `${found.local} renders itself, directly or through another fragment in this module`,
        locate(file, source, found.call.start ?? 0),
      )
    }
    inProgress.add(found.local)

    const fn = nodes(found.call.arguments)[0]
    if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) {
      throw new CompileError(
        'E_FRAGMENT_ARGUMENT',
        'fragment() takes a function',
        locate(file, source, found.call.start ?? 0),
      )
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
      components,
      ...(composed.has(found.local) || options?.composedElsewhere?.has(found.exportName)
        ? { wireProps: true }
        : {}),
      ...(ctxParam ? { ctxParam } : {}),
    }
    const id = `${moduleId(file, options?.root)}#${found.exportName}`
    const input = { id, root: body, scope, file, source, ...(options?.types ? { types: options.types } : {}) }
    const root = body.type === 'BlockStatement' ? returnedJsx(body, input) : body

    const effects = inferEffects({ fn, file, source, ...(ctxParam ? { ctxParam } : {}) })
    const lowered = lower({ ...input, root })

    inProgress.delete(found.local)
    lowerings.set(found.local, lowered)
    own.set(found.local, effects)
    return { lowered, effects }
  }

  // A capitalised tag that is not declared here has to be imported, and the build has to
  // have compiled it already. Resolving it now rather than at the use site keeps the
  // failure at module scope, where the import is.
  for (const tag of composed) {
    if (declarations.some((d) => d.local === tag)) continue
    const imported = imports.get(tag)
    if (!imported) continue
    const found = options?.external?.(imported.module, imported.exported)
    if (found) external.set(tag, found)
  }
  for (const [tag, found] of external) {
    components.set(tag, {
      id: found.id,
      props: found.props,
      sealed: { entry: found.entry, templates: found.templates },
    })
  }

  const byId = new Map<string, Discovered>()
  for (const found of declarations) {
    const id = `${moduleId(file, options?.root)}#${found.exportName}`
    byId.set(id, found)
    const fn = nodes(found.call.arguments)[0]
    const declared = new Set<string>()
    if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
      collectProps(nodes(fn.params)[0], declared)
    }
    components.set(found.local, { id, props: declared, lower: () => prepare(found).lowered })
  }

  /** What a fragment reads once the fragments it renders are folded in. */
  const effectsOf = (local: string, seen = new Set<string>()): EffectSet => {
    if (seen.has(local)) return unionEffects([])
    seen.add(local)
    const lowered = lowerings.get(local)
    const sets: EffectSet[] = [own.get(local) ?? unionEffects([])]
    for (const id of lowered?.components ?? []) sets.push(childEffects(id, seen))
    return unionEffects(sets)
  }

  const childEffects = (id: string, seen = new Set<string>()): EffectSet => {
    const child = byId.get(id)
    if (child) return effectsOf(child.local, seen)
    const outside = [...external.values()].find((f) => f.id === id)
    return outside ? outside.effects : unionEffects([])
  }

  /**
   * Contagion, and the one place it is deliberately stopped. A fragment's class is its own
   * reads plus the reads of the children it renders inline. A private child inside a
   * non-private parent is *not* folded in: it is isolated into its own cache unit, so one
   * fragment that reads identity does not make a whole shared route private. The parent's
   * own class decides, so the answer does not depend on which child is looked at first.
   */
  const composeWithContagion = (local: string): { effects: EffectSet; isolated: Set<number> } => {
    const ownSet = own.get(local) ?? unionEffects([])
    const ownClass = cacheClassOf(ownSet)
    const lowered = lowerings.get(local)
    const sets: EffectSet[] = [ownSet]
    const isolated = new Set<number>()

    ;(lowered?.components ?? []).forEach((id, index) => {
      const child = childEffects(id)
      if (ownClass !== 'private' && cacheClassOf(child) === 'private') {
        isolated.add(index)
        return
      }
      sets.push(child)
    })
    return { effects: unionEffects(sets), isolated }
  }

  for (const found of declarations) {
    if (!found.exported) continue
    const { lowered } = prepare(found)
    const { effects, isolated } = composeWithContagion(found.local)
    const { entry, all } = await sealTree(markIsolated(lowered, isolated), effects)
    fragments.push({ entry, templates: all, exportName: found.exportName })
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
/**
 * What a module exports as a fragment, and which of them it renders from elsewhere. Read
 * by parsing, before anything is compiled, because a parent cannot name a child's version
 * until the child is sealed — so the build has to know the order first.
 */
interface ModuleFacts {
  file: string
  /** Export name to the props it declares. */
  exports: Map<string, Set<string>>
  /** Local tag name to the module specifier and export it came from. */
  imports: Map<string, ImportRef>
  /** Capitalised tags this module renders. */
  renders: Set<string>
}

async function readFacts(file: string): Promise<ModuleFacts> {
  const source = await readFile(file, 'utf8')
  const parsed = parseSync(file, source, { sourceType: 'module', preserveParens: false })
  if (parsed.errors.length) {
    const first = parsed.errors[0]
    throw new CompileError('E_PARSE', first?.message ?? 'parse failed', locate(file, source, 0))
  }
  const program = node(parsed.program)
  const imports = readImports(program)
  const declarations = discover(program, imports)
  const exports = new Map<string, Set<string>>()
  for (const found of declarations) {
    if (!found.exported) continue
    const fn = nodes(found.call.arguments)[0]
    const props = new Set<string>()
    if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
      collectProps(nodes(fn.params)[0], props)
    }
    exports.set(found.exportName, props)
  }
  return { file, exports, imports, renders: composedNames(declarations) }
}

/** Resolves a module specifier the way the file set does, rather than the way Node would. */
function resolveSpecifier(from: string, specifier: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`]) {
    if (known.has(candidate)) return candidate
  }
  return undefined
}

/**
 * Compiles in dependency order. A module that renders a fragment from another module is
 * compiled after it, because the parent's hole names the child's sealed version and a
 * version is a hash of content that does not exist until the child is compiled.
 */
function orderByDependency(facts: Map<string, ModuleFacts>): string[] {
  const files = [...facts.keys()]
  const known = new Set(files)
  const edges = new Map<string, Set<string>>()

  for (const fact of facts.values()) {
    const deps = new Set<string>()
    for (const tag of fact.renders) {
      const imported = fact.imports.get(tag)
      if (!imported) continue
      const target = resolveSpecifier(fact.file, imported.module, known)
      if (target && target !== fact.file) deps.add(target)
    }
    edges.set(fact.file, deps)
  }

  const order: string[] = []
  const done = new Set<string>()
  const path: string[] = []

  const visit = (file: string): void => {
    if (done.has(file)) return
    if (path.includes(file)) {
      const cycle = [...path.slice(path.indexOf(file)), file]
      throw new CompileError('E_COMPONENT_CYCLE', `these modules render each other: ${cycle.join(' -> ')}`, {
        file,
        line: 1,
        column: 1,
      })
    }
    path.push(file)
    for (const dep of edges.get(file) ?? []) visit(dep)
    path.pop()
    done.add(file)
    order.push(file)
  }

  for (const file of files) visit(file)
  return order
}

/**
 * Compiles with type information. Building a checker over the whole file set once is
 * far cheaper than one program per file, so this is the entry point a build should use.
 * It is also the only entry point that can compose across modules: composition needs an
 * order, and an order needs the file set.
 */
export async function compileFiles(
  files: string[],
  options?: Omit<CompileOptions, 'types' | 'external' | 'composedElsewhere'> & { types?: boolean },
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
    const absolute = files.map((f) => (isAbsolute(f) ? f : resolve(process.cwd(), f)))
    const facts = new Map<string, ModuleFacts>()
    for (const file of absolute) facts.set(file, await readFacts(file))

    const known = new Set(absolute)
    // Which exports are rendered from another module, so those modules wire their props.
    const composedElsewhere = new Map<string, Set<string>>()
    for (const fact of facts.values()) {
      for (const tag of fact.renders) {
        const imported = fact.imports.get(tag)
        if (!imported) continue
        const target = resolveSpecifier(fact.file, imported.module, known)
        if (!target || target === fact.file) continue
        const names = composedElsewhere.get(target) ?? new Set<string>()
        names.add(imported.exported)
        composedElsewhere.set(target, names)
      }
    }

    const compiledByFile = new Map<string, CompiledModule>()
    for (const file of orderByDependency(facts)) {
      const external = (module: string, exported: string): ExternalFragment | undefined => {
        const target = resolveSpecifier(file, module, known)
        if (!target) return undefined
        const compiled = compiledByFile.get(target)
        const fragment = compiled?.fragments.find((f) => f.exportName === exported)
        if (!fragment) return undefined
        return {
          id: fragment.entry.id,
          props: facts.get(target)?.exports.get(exported) ?? new Set<string>(),
          entry: fragment.entry,
          templates: fragment.templates,
          effects: fragment.entry.effects,
        }
      }

      compiledByFile.set(
        file,
        await compileFile(file, {
          ...(options?.root ? { root: options.root } : {}),
          ...(oracle ? { types: oracle } : {}),
          external,
          ...(composedElsewhere.has(file)
            ? { composedElsewhere: composedElsewhere.get(file) as Set<string> }
            : {}),
        }),
      )
    }

    // Returned in the order the caller asked for, not the order they had to be built in.
    return { modules: absolute.map((f) => compiledByFile.get(f) as CompiledModule), diagnostics }
  } finally {
    // The checker runs as a separate process; leaving it up would hang the caller.
    oracle?.dispose()
  }
}
