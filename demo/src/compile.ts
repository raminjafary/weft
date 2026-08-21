import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compileFiles } from '../../packages/compiler/src/index.ts'
import type { Resolver, TemplateIR } from '../../packages/ir/src/index.ts'

/**
 * The demo compiles its own fragments with the real compiler, once, at boot.
 *
 * Nothing here is a hand-written IR. If a station shows you a hole, a read set or a cache class,
 * it is the one the compiler inferred from the `.tsx` file you can open next to it — which is the
 * only version of this demo worth having, because a demo whose numbers come from somewhere else
 * is a demo that will disagree with the framework.
 */
export interface Compiled {
  entry: TemplateIR
  resolve: Resolver
  templates: TemplateIR[]
  /** The source, so a station can show you the file that produced what you are looking at. */
  source: string
  file: string
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DIR = fileURLToPath(new URL('./fragments/', import.meta.url))

export const FRAGMENTS = [
  'shell',
  'feed',
  'cart',
  'article',
  'panels',
  'dashboard',
  'dash-shell',
  'greeting',
  'markup',
  'ordinary',
  'product-card',
  'interactive',
  'race',
] as const

export type FragmentName = (typeof FRAGMENTS)[number]

let cache: Record<string, Compiled> | null = null

export async function compileDemo(): Promise<Record<FragmentName, Compiled>> {
  if (cache) return cache as Record<FragmentName, Compiled>
  const files = FRAGMENTS.map((name) => `${DIR}${name}.tsx`)
  const { modules, diagnostics } = await compileFiles(files, { root: ROOT })
  if (diagnostics.length) {
    // A type diagnostic changes escape classes, so it is not cosmetic here.
    process.stderr.write(`demo: ${diagnostics.length} type diagnostics\n`)
  }

  const out: Record<string, Compiled> = {}
  for (const compiledModule of modules) {
    for (const fragment of compiledModule.fragments) {
      const name = fragment.entry.id.replace(/^.*\/([^/]+)\.tsx#.*$/, '$1')
      const templates = fragment.templates
      const byVersion = new Map(templates.map((t) => [t.version, t]))
      out[name] = {
        entry: fragment.entry,
        templates,
        resolve: (version) => byVersion.get(version),
        // Read back, so a station showing you the source is showing you the file that produced
        // the IR beside it rather than a copy somebody pasted.
        source: await readFile(compiledModule.file, 'utf8'),
        file: `demo/src/fragments/${name}.tsx`,
      }
    }
  }
  for (const name of FRAGMENTS) {
    if (!out[name]) throw new Error(`E_FRAGMENT_MISSING: ${name}.tsx produced no fragment() export`)
  }
  cache = out
  return out as Record<FragmentName, Compiled>
}

/** The binding name of a fragment's list hole, taken from the IR rather than written down. */
export function listBinding(compiled: Compiled): string {
  const hole = compiled.entry.holes.find((h) => h.kind === 'list')
  if (!hole) throw new Error(`E_NO_LIST_HOLE: ${compiled.file} has no list hole`)
  return hole.binding
}

/** Slot boundaries this fragment leaves, in document order. */
export function slotBindings(compiled: Compiled): string[] {
  return compiled.entry.holes.filter((h) => h.kind === 'slot').map((h) => h.binding)
}
