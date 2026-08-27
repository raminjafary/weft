import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Which specification documents name a given export.
 *
 * The error reference already does this for codes, and the argument is the same one: a code, or a
 * signature, tells you what a thing is; the document tells you why it is that and not something
 * else. So an export links the documents that argue for it.
 *
 * Only *backticked* mentions count, and that restriction is the whole reason this is usable. A
 * plain word match reports `fragment` as specified in twenty-three documents, because "fragment" is
 * also an English word these documents use constantly — and a reference that points at everything
 * points at nothing. Inside backticks it is a name rather than a noun, and the same search returns
 * one document.
 *
 * About one export in five is named this way. The other four say nothing rather than guessing,
 * which is the same thing the error pages do with a code no document mentions.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SPEC = join(ROOT, 'spec')

/** `` `name` ``, `` `name(` `` and `` `name<` `` — a bare name, a call, and a generic. */
const NAMED = /`([A-Za-z_$][A-Za-z0-9_$]*)[`(<]/g

let index: Map<string, string[]> | undefined

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.md')) out.push(path)
  }
  return out
}

/** Built once: every name any document mentions in a code span, to the documents that mention it. */
function built(): Map<string, string[]> {
  if (index) return index
  index = new Map()
  for (const path of walk(SPEC, [])) {
    const doc = path.slice(ROOT.length)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(NAMED)) {
      const name = match[1] as string
      const found = index.get(name) ?? []
      if (!found.includes(doc)) found.push(doc)
      index.set(name, found)
    }
  }
  return index
}

export function specifiedIn(name: string): string[] {
  return built().get(name) ?? []
}

/** How many of a set of names any document names. Read by the test, so the join cannot rot. */
export function namedCount(names: readonly string[]): number {
  return names.filter((name) => specifiedIn(name).length > 0).length
}
