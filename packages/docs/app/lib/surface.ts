import { readFileSync } from 'node:fs'
import { posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

/**
 * The API reference, read out of the source rather than written beside it.
 *
 * A hand-written API page is a second copy of the surface, and a second copy drifts — silently, and
 * in the direction that makes the documentation wrong rather than merely old. So this walks each
 * package's public entry, follows its re-exports, and collects every exported declaration with the
 * doc comment already sitting above it. Adding an export adds a row. Deleting one deletes a row.
 * `test/docs.test.ts` asserts that nothing exported is missing from the page, which is what makes
 * "the whole API is documented" a gate rather than a claim.
 *
 * It reads `.ts`, not `.d.ts`, for the same reason the examples are real files: the doc comment a
 * reader should see is the one the author wrote, and declaration emit does not keep all of them.
 */
export type ApiKind = 'function' | 'interface' | 'type' | 'const' | 'class' | 'enum' | 'unknown'

export interface ApiEntry {
  name: string
  kind: ApiKind
  /** The declaration as written, with a function's body elided. */
  signature: string
  /** The block comment above it, with the comment syntax stripped. Empty when there was none. */
  doc: string
  /** Repository-relative, so a reader can open it. */
  file: string
}

export interface ApiModule {
  /** URL segment: `weft`, `weft-server`, `kernel`. */
  id: string
  /** What you write in an import. */
  specifier: string
  title: string
  blurb: string
  /** Repository-relative entry file. */
  entry: string
  entries: ApiEntry[]
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

interface Node_ {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

interface Comment {
  start: number
  end: number
}

function nodes(value: unknown): Node_[] {
  return Array.isArray(value) ? (value as Node_[]) : []
}

function node(value: unknown): Node_ | undefined {
  return value && typeof value === 'object' ? (value as Node_) : undefined
}

function nameOf(declaration: Node_): string | undefined {
  const id = node(declaration.id)
  if (id && typeof id.name === 'string') return id.name
  const declarations = nodes(declaration.declarations)
  const first = declarations[0] && node(declarations[0]?.id)
  return first && typeof first.name === 'string' ? first.name : undefined
}

function kindOf(declaration: Node_): ApiKind {
  switch (declaration.type) {
    case 'FunctionDeclaration':
    // An overload set: the signatures without a body. Every one of them is a function.
    case 'TSDeclareFunction':
      return 'function'
    case 'TSInterfaceDeclaration':
      return 'interface'
    case 'TSTypeAliasDeclaration':
      return 'type'
    case 'ClassDeclaration':
      return 'class'
    case 'TSEnumDeclaration':
      return 'enum'
    case 'VariableDeclaration':
      return 'const'
    default:
      return 'unknown'
  }
}

/** A declaration's text, with a function body replaced by an ellipsis: a signature, not an implementation. */
function signatureOf(source: string, declaration: Node_): string {
  const body = node(declaration.body)
  const isFunction = declaration.type === 'FunctionDeclaration' || declaration.type === 'TSDeclareFunction'
  const end = isFunction && body && typeof body.start === 'number' ? body.start : declaration.end
  let text = source.slice(declaration.start, end).trim()
  if (isFunction && body) text = `${text.replace(/\s*$/, '')} { … }`
  // A long const initialiser is a table of data, not a signature. Keep the name and the type.
  if (text.length > 900) text = `${text.slice(0, 880).trimEnd()}\n  …`
  return text.startsWith('export ') ? text : `export ${text}`
}

/** The block comment immediately above a node: nothing but whitespace between them. */
function docFor(source: string, comments: readonly Comment[], start: number): string {
  let best: Comment | undefined
  for (const comment of comments) {
    if (comment.end > start) continue
    if (source.slice(comment.end, start).trim() !== '') continue
    if (!best || comment.end > best.end) best = comment
  }
  if (!best) return ''
  return source
    .slice(best.start, best.end)
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim()
}

/**
 * A module specifier, resolved to a file in this repository.
 *
 * Relative paths are joined. Bare specifiers are resolved too, and that is not a convenience: the
 * front door re-exports whole packages — `weft` hands you `redisLeases` and `workerPool` so an
 * application never imports `@weft/adapters` directly — and a walk that stopped at the package
 * boundary would list the surface an application does not use and omit the one it does.
 */
function resolveWithin(from: string, specifier: string, root: string): string | undefined {
  const candidates: string[] = []
  if (specifier.startsWith('.')) {
    const base = posix.join(posix.dirname(from.split('\\').join('/')), specifier)
    candidates.push(base, `${base}.ts`, `${base}/index.ts`)
  } else if (specifier === 'weft') {
    candidates.push(posix.join(root, 'packages/weft/src/index.ts'))
  } else if (specifier === 'weft/server') {
    candidates.push(posix.join(root, 'packages/weft/src/server.ts'))
  } else if (specifier.startsWith('@weft/')) {
    candidates.push(posix.join(root, `packages/${specifier.slice('@weft/'.length)}/src/index.ts`))
  }
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, 'utf8')
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

interface Collected {
  entries: Map<string, ApiEntry>
}

/**
 * Every exported name reachable from one entry file.
 *
 * `export *` is followed, `export { a as b } from` is followed and renamed, and a file already
 * visited is not visited twice — a barrel that re-exports a sibling barrel is ordinary here. The
 * first declaration of a name wins, which matches what the module system would do.
 */
function collect(file: string, out: Collected, seen: Set<string>, root: string): void {
  if (seen.has(file)) return
  seen.add(file)
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const parsed = parseSync(file, source, { sourceType: 'module' })
  const comments = (parsed.comments ?? []) as unknown as Comment[]
  const program = parsed.program as unknown as Node_
  const local = new Map<string, Node_>()

  for (const statement of nodes(program.body)) {
    const declaration = node(statement.declaration)
    if (declaration) {
      const name = nameOf(declaration)
      if (name) local.set(name, statement)
    }
  }

  const record = (name: string, statement: Node_): void => {
    if (out.entries.has(name)) return
    const declaration = node(statement.declaration)
    if (!declaration) return
    out.entries.set(name, {
      name,
      kind: kindOf(declaration),
      signature: signatureOf(source, declaration),
      doc: docFor(source, comments, statement.start),
      file: relative(root, file).split('\\').join('/'),
    })
  }

  for (const statement of nodes(program.body)) {
    const from = node(statement.source)
    const specifier = from && typeof from.value === 'string' ? from.value : undefined

    if (statement.type === 'ExportAllDeclaration' && specifier) {
      const target = resolveWithin(file, specifier, root)
      if (target) collect(target, out, seen, root)
      continue
    }
    if (statement.type !== 'ExportNamedDeclaration') continue

    const declaration = node(statement.declaration)
    if (declaration) {
      const name = nameOf(declaration)
      if (name) record(name, statement)
      continue
    }

    // `export { a, b as c }`, with or without a source. Either way the exported name is what a
    // caller writes, and the declaration it points at is where the doc comment lives.
    const target = specifier ? resolveWithin(file, specifier, root) : file
    if (specifier && target) collect(target, out, seen, root)
    for (const spec of nodes(statement.specifiers)) {
      const exported = node(spec.exported)
      const localName = node(spec.local)
      const name = exported && typeof exported.name === 'string' ? exported.name : undefined
      if (!name) continue
      if (specifier) {
        // Already collected from the target under its own name; rename if the caller renamed it.
        const source_ = localName && typeof localName.name === 'string' ? localName.name : name
        const found = out.entries.get(source_)
        if (found && !out.entries.has(name)) out.entries.set(name, { ...found, name })
        continue
      }
      const held = local.get(localName && typeof localName.name === 'string' ? localName.name : name)
      if (held) record(name, held)
    }
  }
}

const MODULES: readonly Omit<ApiModule, 'entries'>[] = [
  {
    id: 'weft',
    specifier: 'weft',
    title: 'weft',
    blurb:
      'The authoring surface, and the only module an application’s own code has to know about. Everything here is either a declaration the compiler reads statically or a typed identity function.',
    entry: 'packages/weft/src/index.ts',
  },
  {
    id: 'weft-server',
    specifier: 'weft/server',
    title: 'weft/server',
    blurb:
      'The front door’s own parts, exported so a deployment that needs its own entry point can build one. Discovery, compilation, plan generation, the build and the server.',
    entry: 'packages/weft/src/server.ts',
  },
  {
    id: 'kernel',
    specifier: '@weft/kernel',
    title: '@weft/kernel',
    blurb:
      'The request lifecycle, the two-phase envelope, cache-key derivation, wave dispatch and the stream. Everything a framework usually does that is not one of these is a port on the other side of this module.',
    entry: 'packages/kernel/src/index.ts',
  },
  {
    id: 'plan',
    specifier: '@weft/plan',
    title: '@weft/plan',
    blurb:
      'Placement, declared and then checked against what the compiler inferred. A plan that contradicts a derivation loses, at build time, with the read that caused it named.',
    entry: 'packages/plan/src/index.ts',
  },
  {
    id: 'ir',
    specifier: '@weft/ir',
    title: '@weft/ir',
    blurb:
      'The sealed template format and the one rendering function. Versioned, because a wire format cannot be versioned retroactively.',
    entry: 'packages/ir/src/index.ts',
  },
  {
    id: 'warp',
    specifier: '@weft/warp',
    title: '@weft/warp',
    blurb: 'The frame protocol: negotiation, frames, and the codec. Also versioned, and for the same reason.',
    entry: 'packages/warp/src/index.ts',
  },
  {
    id: 'client',
    specifier: '@weft/client',
    title: '@weft/client',
    blurb:
      'The runtime: adoption, the signal graph, deltas, epochs, residency and navigation. Every capability is its own entry, so a page pays for what it uses.',
    entry: 'packages/client/src/index.ts',
  },
  {
    id: 'compiler',
    specifier: '@weft/compiler',
    title: '@weft/compiler',
    blurb:
      'TSX to sealed templates, on Oxc, with effect inference and type-driven escape elision. Also the virtual file set the playground on this site compiles through.',
    entry: 'packages/compiler/src/index.ts',
  },
  {
    id: 'adapters',
    specifier: '@weft/adapters',
    title: '@weft/adapters',
    blurb:
      'Implementations of the ports the kernel refuses to know about: stores, sessions, flags, executors, transports, limiters, a registry and the Workers entry.',
    entry: 'packages/adapters/src/index.ts',
  },
]

let cached: ApiModule[] | null = null

/** The whole public surface, read once. */
export function surface(): ApiModule[] {
  if (cached) return cached
  cached = MODULES.map((module) => {
    const out: Collected = { entries: new Map() }
    collect(resolve(ROOT, module.entry), out, new Set(), ROOT)
    const entries = [...out.entries.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { ...module, entries }
  })
  return cached
}

export function moduleById(id: string): ApiModule | undefined {
  return surface().find((module) => module.id === id)
}

/** Every exported name across every module, for the completeness gate and for search. */
export function everyExport(): { module: string; name: string; kind: ApiKind }[] {
  return surface().flatMap((module) =>
    module.entries.map((entry) => ({ module: module.specifier, name: entry.name, kind: entry.kind })),
  )
}
