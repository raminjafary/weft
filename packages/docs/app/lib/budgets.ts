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
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SOURCE = join(ROOT, 'packages/bench/src/budget.ts')
const SITE = fileURLToPath(new URL('../../weft.budget.json', import.meta.url))

const ENTRY =
  /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)',\s*entry:[^,]+,\s*limit:\s*([0-9]+)\s*\*\s*1024,\s*limitNote:\s*((?:'[^']*'|"[^"]*"|`[^`]*`)(?:\s*\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`))*)/g

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
    const [, id, label, kb, note] = match
    const text = joined(note as string)
    out.push({
      id: id as string,
      label: label as string,
      limit: Number(kb) * 1024,
      note: text,
      stated: !text.startsWith('no design figure'),
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
