import { brotliCompressSync, constants } from 'node:zlib'
import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REWRITTEN_SPECIFIERS, type AssetTable, type ModuleTree } from './assets.ts'
import type { GeneratedRoute } from './routes.ts'

/**
 * `budget({ js, grow })`, enforced — and the granularity it turned out to have.
 *
 * The declaration is per slot, which is where the design put it, and the design was describing a
 * framework with a bundler: chunks per route, a slot's island in one of them, a number per slot.
 * This framework has no bundler. A page loads one boot module and whatever that module imports, the
 * same set on every route, so **there is no per-slot JavaScript to measure** — the honest number is
 * what a page downloads, and it is one number for the whole application.
 *
 * That does not make the budget useless, it makes it a different claim: a slot declaring `js: '8kb'`
 * is saying the page it is on should not ship more than that, and the build can tell it whether it
 * does. What it cannot do is attribute the excess to the slot, so the failure names the route, the
 * slot that declared the ceiling, and the measurement, and leaves the attribution to a reader who
 * knows what their application imports.
 *
 * `grow` is the other half and needs no bundler at all: a cap on regression against a recorded
 * baseline. A ceiling alone produces permanent silence just under it; a growth cap notices the
 * afternoon somebody added 900 bytes.
 */
export interface JsMeasurement {
  /** Modules a page loads, in the order the walk found them. */
  modules: { href: string; raw: number; brotli: number }[]
  raw: number
  /** Compressed, module by module and then summed — which is what a page without a bundler pays. */
  brotli: number
}

export interface JsVerdict {
  route: string
  /** The slot that declared the ceiling, or `document` for a route-level declaration. */
  declaredBy: string
  limit: number
  measured: number
  kind: 'ceiling' | 'growth'
  /** The recorded figure a growth cap is measured against. */
  baseline?: number
}

const BROTLI = { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }

function compressed(source: string): { raw: number; brotli: number } {
  const bytes = Buffer.from(source, 'utf8')
  return { raw: bytes.byteLength, brotli: brotliCompressSync(bytes, BROTLI).byteLength }
}

function importsOf(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push(match[1] as string)
  }
  return out
}

/**
 * What a page downloads, walked rather than declared.
 *
 * There is no bundle to measure, so this follows the same edges the browser will: the boot module,
 * every relative import it reaches, and the two bare specifiers the front door rewrites. Each
 * module is compressed on its own, because that is how each one arrives — a bundler's figure would
 * be smaller than the truth and this framework does not have one to be smaller with.
 */
export async function measureClientJs(assets: AssetTable, appClient?: string): Promise<JsMeasurement> {
  const trees = [...assets.trees.entries()]
  const treeFor = (href: string): { prefix: string; tree: ModuleTree } | undefined => {
    const found = trees.find(([prefix]) => href.startsWith(prefix))
    return found ? { prefix: found[0], tree: found[1] } : undefined
  }

  const seen = new Set<string>()
  const modules: JsMeasurement['modules'] = []
  const queue = [assets.boot, ...(appClient ? [appClient] : [])]

  while (queue.length) {
    const href = queue.shift() as string
    if (seen.has(href)) continue
    seen.add(href)
    const located = treeFor(href)
    if (!located) continue
    const name = href.slice(located.prefix.length)
    let source: string
    try {
      source = await readFile(join(located.tree.dir, name), 'utf8')
    } catch {
      continue
    }
    const stripped = name.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source
    modules.push({ href, ...compressed(stripped) })

    for (const specifier of importsOf(source)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(new URL(specifier, `file:///${href.replace(/^\//, '')}`).pathname)
        continue
      }
      const tree = REWRITTEN_SPECIFIERS[specifier]
      if (!tree) continue
      const target = trees.find(([prefix]) => prefix.endsWith(`/${tree}/`))
      if (target) queue.push(`${target[0]}index${target[1].ext}`)
    }
  }

  return {
    modules,
    raw: modules.reduce((sum, m) => sum + m.raw, 0),
    brotli: modules.reduce((sum, m) => sum + m.brotli, 0),
  }
}

/**
 * Every declared ceiling this measurement breaks, and every growth cap it exceeds.
 *
 * Returned rather than thrown: the build prints all of them. A gate that reports the first failure
 * makes a reader fix one number, rebuild, and find the next.
 */
export function checkJsBudgets(
  routes: readonly GeneratedRoute[],
  measured: JsMeasurement,
  baseline?: number,
): JsVerdict[] {
  const out: JsVerdict[] = []
  for (const route of routes) {
    for (const slot of route.plan.slots) {
      const budget = slot.budget
      if (!budget) continue
      if (budget.jsBytes !== undefined && measured.brotli > budget.jsBytes) {
        out.push({
          route: route.pattern,
          declaredBy: slot.name,
          limit: budget.jsBytes,
          measured: measured.brotli,
          kind: 'ceiling',
        })
      }
      if (budget.growBytes !== undefined && baseline !== undefined) {
        if (measured.brotli - baseline > budget.growBytes) {
          out.push({
            route: route.pattern,
            declaredBy: slot.name,
            limit: budget.growBytes,
            measured: measured.brotli - baseline,
            kind: 'growth',
            baseline,
          })
        }
      }
    }
  }
  return out
}

export function describeJsVerdict(verdict: JsVerdict): string {
  if (verdict.kind === 'growth') {
    return (
      `E_JS_GROWTH: ${verdict.route} declares (on ${verdict.declaredBy}) that the client may grow by ` +
      `${verdict.limit} B, and it grew by ${verdict.measured} B against a recorded ${verdict.baseline} B`
    )
  }
  return (
    `E_JS_BUDGET: ${verdict.route} declares (on ${verdict.declaredBy}) a client budget of ` +
    `${verdict.limit} B, and a page on it downloads ${verdict.measured} B compressed. There is no ` +
    `bundler here, so this is the whole application's client and not this slot's share of it`
  )
}
