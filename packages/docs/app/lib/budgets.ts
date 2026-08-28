import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The byte budgets, read out of the module that measures them.
 *
 * `packages/bench/src/budget.ts` declares one entry per real module a deployment can import on its
 * own, each with a ceiling and a sentence saying where that ceiling came from. Quoting those numbers
 * by hand here would be quoting a number that moves, so this parses the declaration — and the
 * ceiling on the page is the one the gate compares against.
 *
 * What this deliberately does not do is run the bundler. Measuring is `pnpm bench budget`, which
 * takes rolldown and a minifier; a documentation page that shelled out to that would be a page that
 * takes twenty seconds to render. The ceilings are static, the measurement is a command, and the
 * page says which is which.
 */
export interface Budget {
  id: string
  label: string
  /** Compressed ceiling, in bytes. */
  limit: number
  /** Where the figure comes from — sometimes "no design figure", which is the honest answer. */
  note: string
  /** Whether the design stated this number, or the repository measured it and drew a line. */
  stated: boolean
  /**
   * The package the entry lives in.
   *
   * `budget.ts` reaches its entries through two helpers — `src()` for `packages/client/src` and
   * `kernelSrc()` for `packages/kernel/src` — so which package an entry belongs to is written into
   * the call rather than needing a table here. Those are the only two: nothing else in this
   * workspace is shipped to a browser or measured against a ceiling.
   */
  module: string
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SOURCE = join(ROOT, 'packages/bench/src/budget.ts')
const SITE = fileURLToPath(new URL('../../weft.budget.json', import.meta.url))

/**
 * One declared entry, pulled out of the array by splitting on `id:` rather than by one long regex.
 *
 * The regex this replaced required `entry:` and `limit:` to be adjacent and the limit to be written
 * `N * 1024`. Four of the twenty-one entries are neither — three carry a JSDoc block between the
 * two fields explaining where their ceiling moved from, and three state a limit that is not a whole
 * number of kibibytes. So the page quietly showed seventeen budgets and no one could tell, which
 * included dropping the one ceiling on this page that came from a design figure rather than a
 * watermark. Splitting first and reading fields out of each chunk tolerates both.
 */
const ID = /\n\s*id: '([^']+)',/g
const LABEL = /label:\s*'([^']+)'/
const REACH = /entry:\s*([a-zA-Z]+)\(/
const LIMIT = /limit:\s*([0-9]+)(?:\s*\*\s*([0-9]+))?\s*,/
/**
 * A note, which is one single-quoted string or several concatenated.
 *
 * Escapes are part of the literal: one of them is `'the design\'s "target under 8 KB…"'`, and a
 * pattern that stopped at the first quote read four words of it and called that the note.
 */
const NOTE = /limitNote:\s*('(?:[^'\\]|\\.)*'(?:\s*\+\s*'(?:[^'\\]|\\.)*')*)/

/** Which package an entry's helper reaches into. The call says it, so no table has to. */
const REACHES: Record<string, string> = {
  src: '@weftjs/client',
  kernelSrc: '@weftjs/kernel',
  front: 'weft',
}

function joined(literal: string): string {
  return literal
    .split(/\s*\+\s*/)
    .map((part) =>
      part
        .trim()
        .slice(1, -1)
        .replace(/\\(['"`\\])/g, '$1'),
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Every declared entry, in the order the module lists them.
 *
 * The count is checked against the number of `id:` fields in the file, so an entry this cannot
 * parse fails the page rather than going missing from it — which is the failure that already
 * happened once and was invisible for as long as it lasted.
 */
export function budgets(): Budget[] {
  const source = readFileSync(SOURCE, 'utf8')
  const starts = [...source.matchAll(ID)]
  const out: Budget[] = []
  for (const [at, start] of starts.entries()) {
    const from = start.index ?? 0
    const to = starts[at + 1]?.index ?? source.length
    const chunk = source.slice(from, to)
    const label = LABEL.exec(chunk)
    const reach = REACH.exec(chunk)
    const limit = LIMIT.exec(chunk)
    const note = NOTE.exec(chunk)
    if (!label || !reach || !limit || !note) continue
    const text = joined(note[1] as string)
    out.push({
      id: start[1] as string,
      label: label[1] as string,
      limit: Number(limit[1]) * (limit[2] ? Number(limit[2]) : 1),
      note: text,
      stated: !text.startsWith('no design figure'),
      module: REACHES[reach[1] as string] ?? 'weft',
    })
  }
  if (out.length !== starts.length) {
    throw new Error(
      `E_DOCS_BUDGET_UNPARSED: ${starts.length} entries declared, ${out.length} parsed. ` +
        'An entry this cannot read is an entry the page would silently omit.',
    )
  }
  return out
}

export interface SiteWeight {
  brotli: number
  raw: number
  modules: number
}

/**
 * What this site's own client actually weighs, from the file the growth cap is a diff of.
 *
 * It is the honest counterpart to the table above: those ceilings are measured bundled and minified,
 * and this framework has no bundler — a page fetches the boot module and every module it imports as
 * its own response. This number is that walk, compressed the way it arrives.
 */
export function siteWeight(): SiteWeight {
  const parsed = JSON.parse(readFileSync(SITE, 'utf8')) as SiteWeight
  return { brotli: parsed.brotli, raw: parsed.raw, modules: parsed.modules }
}

/**
 * One entry by the id it declares, with what the gate last measured it at.
 *
 * `ceilingFor` answers a module page's question — what is the tightest thing this package is held
 * to — and cannot answer a page that names three specific entries. The tutorial's last step does
 * exactly that: it has the reader add a signal, a live region and a navigation, and then prints
 * what each of those three cost. Those figures were typed by hand and were wrong by a factor of
 * four, which is the argument for this function existing rather than for typing them more carefully.
 */
export function entryFor(
  id: string,
): { id: string; label: string; limit: number; brotli?: number } | undefined {
  const found = budgets().find((entry) => entry.id === id)
  if (!found) return undefined
  const brotli = measured().get(id)
  return { id: found.id, label: found.label, limit: found.limit, ...(brotli === undefined ? {} : { brotli }) }
}

/**
 * The tightest ceiling declared for a package, and how many entries it has.
 *
 * A package with entries has several — the client has nine, one per capability a page can import —
 * and the interesting one for a module page is the smallest, because that is the entry a deployment
 * pays for at minimum. Packages with none get nothing rather than a zero.
 */
export function ceilingFor(
  module: string,
): { limit: number; entries: number; label: string; brotli?: number } | undefined {
  const mine = budgets().filter((entry) => entry.module === module)
  if (!mine.length) return undefined
  const tightest = mine.reduce((low, entry) => (entry.limit < low.limit ? entry : low))
  const brotli = measured().get(tightest.id)
  return {
    limit: tightest.limit,
    entries: mine.length,
    label: tightest.label,
    ...(brotli === undefined ? {} : { brotli }),
  }
}

/**
 * What the last recorded run measured, per entry.
 *
 * `pnpm bench budget --write` bundles each entry with rolldown, compresses it, and writes the
 * result to `packages/bench/budgets.json` — which is committed, on the same argument as the file
 * beside this site: a growth cap is a diff. Reading it here is why a page can print a measured
 * figure without taking on a bundler and twenty seconds to render, and a test in `packages/bench`
 * holds the specification's own table to the same file.
 *
 * A missing file is not an error. It means nobody has run the gate in this checkout, and a page
 * that prints the ceiling and names the command is more use than one that fails to render.
 */
const RECORDED = join(ROOT, 'packages/bench/budgets.json')

let sizes: Map<string, number> | undefined

function measured(): Map<string, number> {
  if (sizes) return sizes
  sizes = new Map()
  try {
    const parsed = JSON.parse(readFileSync(RECORDED, 'utf8')) as { id: string; brotli: number }[]
    for (const entry of parsed) sizes.set(entry.id, entry.brotli)
  } catch {}
  return sizes
}
