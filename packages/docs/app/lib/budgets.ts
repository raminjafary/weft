import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The byte budgets, read out of `packages/bench/src/budget.ts` rather than quoted by hand, so the
 * ceiling on the page is the one the gate compares against. Deliberately does not run the bundler —
 * that's `pnpm bench budget`, and a page that shelled out to it would take twenty seconds to render.
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
  /** The package the entry lives in — read from which of `budget.ts`'s two helpers (`src`/`kernelSrc`) the call used. */
  module: string
}

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SOURCE = join(ROOT, 'packages/bench/src/budget.ts')
const SITE = fileURLToPath(new URL('../../weft.budget.json', import.meta.url))
const DEMO = join(ROOT, 'demo/weft.budget.json')

/**
 * One declared entry, pulled out by splitting on `id:` rather than one long regex. The regex this
 * replaced required `entry:`/`limit:` adjacent and `N * 1024`; four of twenty-one entries weren't,
 * so the page silently showed seventeen budgets and nobody noticed. Splitting first tolerates both.
 */
const ID = /\n\s*id: '([^']+)',/g
const LABEL = /label:\s*'([^']+)'/
const REACH = /entry:\s*([a-zA-Z]+)\(/
const LIMIT = /limit:\s*([0-9]+)(?:\s*\*\s*([0-9]+))?\s*,/
/** A note: one single-quoted string or several concatenated. Must handle escapes — a pattern stopping at the first quote truncated one to four words. */
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

/** Every declared entry. Count is checked against the `id:` fields found, so an unparseable entry fails the page rather than silently vanishing (as it once did). */
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

/** What this site's own client actually weighs — the real per-module walk (no bundler), not the bundled-and-minified ceilings above. */
export function siteWeight(): SiteWeight {
  return weightOf(SITE)
}

/** The same question about the demo. Three pages once hand-typed this as 46,698 B; it moved to 25,835 and only one of the three noticed. Read from the build's own file now. */
export function demoWeight(): SiteWeight {
  return weightOf(DEMO)
}

function weightOf(file: string): SiteWeight {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SiteWeight
  return { brotli: parsed.brotli, raw: parsed.raw, modules: parsed.modules }
}

/** How far the bundled front-door entry is from what a page actually downloads. Both halves measured, neither typed — the ratio moved from 3.5× to under 2× on its own when comment-stripping shipped. */
export function downloadRatio(): string {
  const bundled = entryFor('front-door')?.brotli
  if (!bundled) return 'not measured'
  return (demoWeight().brotli / bundled).toFixed(1)
}

/** One entry by id, with what the gate last measured. Needed because the tutorial's last step names three specific entries — hand-typed, those figures were once off by 4×. */
export function entryFor(
  id: string,
): { id: string; label: string; limit: number; brotli?: number } | undefined {
  const found = budgets().find((entry) => entry.id === id)
  if (!found) return undefined
  const brotli = measured().get(id)
  return { id: found.id, label: found.label, limit: found.limit, ...(brotli === undefined ? {} : { brotli }) }
}

/** The tightest ceiling declared for a package, and how many entries it has — the smallest is what a deployment pays for at minimum. */
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
 * What the last recorded run measured, per entry, from the committed `packages/bench/budgets.json`
 * — reading it is what lets a page print a measured figure without a bundler and twenty seconds to
 * render. A missing file isn't an error: it means nobody ran the gate in this checkout.
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
