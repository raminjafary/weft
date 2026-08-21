import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { fragmentIR, type CompiledFragment } from 'weft'
import type { Resolver, TemplateIR } from '@weft/ir'

/**
 * The demo's compiled fragments — read from the framework's own table rather than compiled again.
 *
 * This file used to *be* the compile step: it named a list of `.tsx` files, called `compileFiles`
 * and cached the result, and every station read from it. All of that is now the framework's, and
 * what is left is a lookup. That is the point of the migration: a station showing you a hole, a
 * read set or a cache class is showing you the one the renderer beside it used, and there is no
 * second compilation that could disagree with the first.
 *
 * `source` is still read here, because a station that shows you a file should show you the bytes
 * on disk rather than a copy somebody pasted.
 */
export interface Compiled {
  entry: TemplateIR
  resolve: Resolver
  templates: TemplateIR[]
  /** The source, so a station can show the file that produced what you are looking at. */
  source: string
  file: string
}

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * The names a station asks for, and where the convention puts each one.
 *
 * `shell` and `dash-shell` were fragments the demo passed to `plan()` by hand; they are documents
 * now, so they are the layout and a named layout. Everything else is a fragment a route's slot
 * names, which is why the showcases need no `.tsx` of their own.
 */
const WHERE = {
  shell: 'layout',
  'dash-shell': 'layout:dash',
  feed: 'fragment:feed',
  cart: 'fragment:cart',
  article: 'fragment:article',
  panels: 'fragment:panels',
  dashboard: 'fragment:dashboard',
  greeting: 'fragment:greeting',
  markup: 'fragment:markup',
  ordinary: 'fragment:ordinary',
  'product-card': 'fragment:product-card',
  interactive: 'fragment:interactive',
  race: 'layout:race',
} as const

export type FragmentName = keyof typeof WHERE

export const FRAGMENTS = Object.keys(WHERE) as FragmentName[]

const sources = new Map<string, string>()

async function sourceOf(fragment: CompiledFragment): Promise<string> {
  const cached = sources.get(fragment.file)
  if (cached !== undefined) return cached
  const text = await readFile(`${ROOT}${fragment.file}`, 'utf8')
  sources.set(fragment.file, text)
  return text
}

let cache: Record<FragmentName, Compiled> | null = null

export async function compileDemo(): Promise<Record<FragmentName, Compiled>> {
  if (cache) return cache
  const out = {} as Record<FragmentName, Compiled>
  for (const [name, where] of Object.entries(WHERE) as [FragmentName, string][]) {
    const fragment = fragmentIR(where)
    out[name] = {
      entry: fragment.entry,
      templates: fragment.templates,
      resolve: fragment.resolve,
      source: await sourceOf(fragment),
      file: fragment.file,
    }
  }
  cache = out
  return out
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
