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

const ENTRY =
  /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)',\s*entry:\s*([a-zA-Z]+)\([^)]*\),\s*limit:\s*([0-9]+)\s*\*\s*1024,\s*limitNote:\s*((?:'[^']*'|"[^"]*"|`[^`]*`)(?:\s*\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`))*)/g

function joined(literal: string): string {
  return literal
    .split(/\s*\+\s*/)
    .map((part) => part.trim().slice(1, -1))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every declared entry, in the order the module lists them. */
export function budgets(): Budget[] {
  const source = readFileSync(SOURCE, 'utf8')
  const out: Budget[] = []
  for (const match of source.matchAll(ENTRY)) {
    const [, id, label, reach, kb, note] = match
    const text = joined(note as string)
    out.push({
      id: id as string,
      label: label as string,
      limit: Number(kb) * 1024,
      note: text,
      stated: !text.startsWith('no design figure'),
      module: reach === 'kernelSrc' ? '@weft/kernel' : '@weft/client',
    })
  }
  if (out.length < 5) throw new Error(`E_DOCS_NO_BUDGETS: parsed only ${out.length} entries`)
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
 * The tightest ceiling declared for a package, and how many entries it has.
 *
 * A package with entries has several — the client has nine, one per capability a page can import —
 * and the interesting one for a module page is the smallest, because that is the entry a deployment
 * pays for at minimum. Packages with none get nothing rather than a zero.
 */
export function ceilingFor(module: string): { limit: number; entries: number; label: string } | undefined {
  const mine = budgets().filter((entry) => entry.module === module)
  if (!mine.length) return undefined
  const tightest = mine.reduce((low, entry) => (entry.limit < low.limit ? entry : low))
  return { limit: tightest.limit, entries: mine.length, label: tightest.label }
}
