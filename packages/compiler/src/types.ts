import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  API,
  isBooleanLiteralType,
  isIntrinsicType,
  isNumberLiteralType,
  isStringLiteralType,
  isTemplateLiteralType,
  isUnionType,
  type Type,
} from 'typescript/unstable/sync'
import { getTokenAtPosition, type Node, type SourceFile } from 'typescript/unstable/ast'
import type { TypeOracle, ValueKind } from './kinds.ts'

export { cannotBeMarkup, type TypeOracle, type ValueKind } from './kinds.ts'

type Snapshot = ReturnType<InstanceType<typeof API>['updateSnapshot']>
type Project = ReturnType<Snapshot['getProjects']>[number]

interface Resolved {
  project: Project
  source: SourceFile
}

/** Escape elision is a type question, not a syntax question. Asks the TypeScript checker. See `spec/compiler/supported-subset.md`. */
export function createTypeOracle(files: string[], root = process.cwd()): TypeOracle {
  const absolute = files.map((f) => (isAbsolute(f) ? f : resolve(root, f)))
  const api = new API({})
  const snapshot = api.updateSnapshot({ openFiles: absolute })
  const resolvedFiles = new Map<string, Resolved | null>()

  for (const file of absolute) {
    const project = snapshot.getDefaultProjectForFile(file) ?? snapshot.getProjects()[0]
    const source = project?.program.getSourceFile(file)
    resolvedFiles.set(file, project && source ? { project, source } : null)
  }

  function resolvedFor(file: string): Resolved | null {
    const target = isAbsolute(file) ? file : resolve(root, file)
    return resolvedFiles.get(target) ?? resolvedFiles.get(file) ?? null
  }

  return {
    kindAt(file, start, end) {
      const resolved = resolvedFor(file)
      if (!resolved || start < 0 || end <= start) return 'other'
      let node: Node | undefined
      try {
        node = getTokenAtPosition(resolved.source, start)
      } catch {
        return 'other'
      }
      if (!node) return 'other'
      // The token at the start of `row.name` is `row`; widen to the whole expression.
      while (node.parent && node.parent.end <= end) node = node.parent
      try {
        const type = resolved.project.checker.getTypeAtLocation(node)
        return type ? kindOf(type) : 'other'
      } catch {
        return 'other'
      }
    },

    diagnostics() {
      const out: string[] = []
      for (const file of absolute) {
        const resolved = resolvedFor(file)
        if (!resolved) continue
        let reported: readonly unknown[] = []
        try {
          // Passing the file name, not the source file: the API encodes its arguments,
          // and a source-file object contains a cycle.
          reported = resolved.project.program.getSemanticDiagnostics(file) ?? []
        } catch {
          continue
        }
        for (const entry of reported) out.push(describe(entry))
      }
      return out
    },

    dispose() {
      api.close()
    },
  }
}

function describe(entry: unknown): string {
  const record = entry as { fileName?: string; pos?: number; text?: string; code?: number }
  const message = record.text ?? JSON.stringify(entry)
  if (!record.fileName || record.pos === undefined) return message
  return `${record.fileName}:${lineAndColumn(record.fileName, record.pos)} — ${message}`
}

function lineAndColumn(file: string, position: number): string {
  try {
    const upto = readFileSync(file, 'utf8').slice(0, position).split('\n')
    return `${upto.length}:${(upto[upto.length - 1] ?? '').length + 1}`
  } catch {
    return String(position)
  }
}

/** A union qualifies only if every constituent does, so `number | string` still escapes. */
function kindOf(type: Type): ValueKind {
  if (isUnionType(type)) {
    // Constituents are fetched, not held: the checker is another process.
    const constituents = type.getTypes() ?? []
    if (!constituents.length) return 'other'
    const kinds = new Set(constituents.map(kindOf))
    if (kinds.size === 1) return [...kinds][0] as ValueKind
    // `boolean` is a union of its two literals, and mixing numbers with booleans is still safe.
    if (kinds.size === 2 && kinds.has('number') && kinds.has('boolean')) return 'number'
    return 'other'
  }
  if (isNumberLiteralType(type)) return 'number'
  if (isBooleanLiteralType(type)) return 'boolean'
  if (isStringLiteralType(type) || isTemplateLiteralType(type)) return 'string'
  if (isIntrinsicType(type)) {
    switch (type.intrinsicName) {
      case 'number':
      case 'bigint':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'string':
        return 'string'
      default:
        return 'other'
    }
  }
  return 'other'
}
