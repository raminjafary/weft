import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { parse, stringify, type TemplateIR } from '@weftjs/ir'
import { bootPrelude, createApp } from './serve.ts'
import { prerender, STATIC_DIR, type StaticManifest, type StaticRefusal } from './static.ts'
import { checkJsBudgets, describeJsVerdict, measureClientJs } from './js-budget.ts'
import { moduleFiles } from './assets.ts'
import type { CompiledApp, CompiledFragment } from './compile.ts'
import type { Discovered } from './convention.ts'
import type { ResolvedConfig, WeftConfig } from './config.ts'

/**
 * What a deployment needs, written down: sealed templates, the generated plan, the intent
 * manifest, every revved asset and a byte report. `routes.json` is reviewable because the plan is
 * data rather than a function that runs. Nothing is minified — see `spec/kernel/budgets.md`.
 */
export interface BuildReport {
  outDir: string
  templates: number
  /** What a page downloads, and every declared ceiling it broke. One number for the application:
   * there is no bundler and therefore no per-route JavaScript. */
  client: { raw: number; brotli: number; modules: number; baseline?: number }
  routes: { pattern: string; slots: number; markupBytes: number; styles: string[]; live: string[] }[]
  intents: { id: string; name: string; module: string }[]
  /** The catalogue: what a client on this deployment may ask to have rendered, and by what. */
  renderables: {
    id: string
    name: string
    by: string
    module: string
    capabilities: string[]
    signed: boolean
  }[]
  /** Every region a route composes, and where this deployment's registry says it is. */
  regions: { region: string; route: string; locus: string; where: string }[]
  assets: { href: string; bytes: number; immutable: boolean }[]
  /** L0: the documents resolved here rather than per request. `pattern` is the route, `path` the
   * URL — they differ for a parameterised route, one document per declared value. */
  static: { pattern: string; path: string; file: string; bytes: number }[]
  /** Every route that is not one of them, with the reason. A tier nobody can see is a tier nobody uses. */
  refused: { pattern: string; code: StaticRefusal; reason: string }[]
  diagnostics: string[]
}

function slug(id: string): string {
  return id
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/** Every sealed template the build wrote, so a channel can answer a `WARM tpl=`. */
export interface IrManifest {
  irVersion: string
  fragments: Record<string, { entry: string; file: string; templates: string[] }>
  /** Version to the file that holds it. */
  templates: Record<string, string>
}

/** Compile, generate, bundle, prerender, and write the manifest. The whole of `weft build`. */
export async function build(root: string, overrides: WeftConfig = {}): Promise<BuildReport> {
  const app = await createApp(root, { ...overrides, mode: 'build' })
  const out = join(root, app.config.outDir)
  for (const dir of ['ir', 'assets', STATIC_DIR]) await rm(join(out, dir), { recursive: true, force: true })
  await mkdir(join(out, 'ir'), { recursive: true })

  const manifest: IrManifest = {
    irVersion: app.compiled.templates[0]?.irVersion ?? '',
    fragments: {},
    templates: {},
  }
  for (const template of app.compiled.templates) {
    const file = `${slug(template.id)}-${template.version.slice(0, 8)}.json`
    await writeFile(join(out, 'ir', file), `${stringify(template)}\n`)
    manifest.templates[template.version] = file
  }
  for (const [name, fragment] of Object.entries(app.compiled.fragments)) {
    manifest.fragments[name] = {
      entry: fragment.entry.version,
      file: fragment.file,
      templates: fragment.templates.map((t) => t.version),
    }
  }
  await writeFile(join(out, 'ir', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // The generated plan, as data: reviewable, diffable.
  await writeFile(
    join(out, 'routes.json'),
    `${JSON.stringify(
      app.routes.map((route) => ({
        ...route.plan,
        css: route.css.map((file) => relative(root, file)),
        live: Object.keys(route.live),
      })),
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(out, 'intents.json'),
    `${JSON.stringify({ entries: app.intents.entries, names: app.intents.names }, null, 2)}\n`,
  )
  // Its own file: a different question from `intents.json`, which is what may be written.
  await writeFile(
    join(out, 'catalogue.json'),
    `${JSON.stringify({ entries: app.catalogue.entries, names: app.catalogue.names }, null, 2)}\n`,
  )

  // Every revved file, at the path it is served from, so the directory can be uploaded as it is.
  const assets: BuildReport['assets'] = []
  for (const [href, asset] of app.assets.files) {
    const target = join(out, 'assets', href.replace(/^\//, ''))
    await mkdir(dirname(target), { recursive: true })
    const body = typeof asset.body === 'string' ? Buffer.from(asset.body) : Buffer.from(asset.body)
    await writeFile(target, body)
    assets.push({ href, bytes: body.byteLength, immutable: asset.immutable })
  }
  // The module trees, materialised: `files` never held them, so up to here the output was a site
  // with every document and no runtime.
  for (const [href, body] of await moduleFiles(app.assets, bootPrelude(app))) {
    const target = join(out, 'assets', href.replace(/^\//, ''))
    await mkdir(dirname(target), { recursive: true })
    const bytes = Buffer.from(body)
    await writeFile(target, bytes)
    assets.push({ href, bytes: bytes.byteLength, immutable: app.assets.revved })
  }
  await writeFile(join(out, 'assets', 'manifest.json'), `${JSON.stringify(app.assets.manifest, null, 2)}\n`)

  // L0, and the only tier that produces files rather than behaviour. What is refused is written
  // down beside it. See `spec/kernel/static.md`.
  const prerendered = await prerender(app)
  for (const document of prerendered.documents) {
    const target = join(out, STATIC_DIR, document.file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(document.body))
  }
  const staticManifest: StaticManifest = {
    documents: prerendered.documents.map(({ body: _body, ...rest }) => rest),
    refused: prerendered.refused,
  }
  await mkdir(join(out, STATIC_DIR), { recursive: true })
  await writeFile(join(out, STATIC_DIR, 'manifest.json'), `${JSON.stringify(staticManifest, null, 2)}\n`)

  // The client, measured and gated: `budget({ js })` is enforced here, against what a page
  // actually downloads module by module. See `spec/kernel/budgets.md`.
  const client = await measureClientJs(app.assets, app.assets.app)
  // Beside the config rather than inside `.weft/`, which is gitignored: a growth cap needs
  // something committed to diff against.
  const baselinePath = join(root, 'weft.budget.json')
  const baseline = await readBaseline(baselinePath)
  const broken = checkJsBudgets(app.routes, client, baseline)
  await writeFile(
    baselinePath,
    `${JSON.stringify({ note: 'what a page downloads, brotli. Commit this: a growth cap is a diff.', brotli: client.brotli, raw: client.raw, modules: client.modules.length }, null, 2)}\n`,
  )
  if (broken.length) {
    throw new Error(broken.map(describeJsVerdict).join('\n'))
  }

  const report: BuildReport = {
    outDir: app.config.outDir,
    templates: app.compiled.templates.length,
    client: {
      raw: client.raw,
      brotli: client.brotli,
      modules: client.modules.length,
      ...(baseline !== undefined ? { baseline } : {}),
    },
    routes: app.routes.map((route) => ({
      pattern: route.pattern,
      slots: route.plan.slots.length,
      markupBytes: markupBytes(
        app.compiled,
        route.plan.slots.map((s) => s.fragment ?? ''),
      ),
      styles: route.css.map((file) => relative(root, file)),
      live: Object.keys(route.live),
    })),
    intents: app.intents.entries.map((e) => ({ id: e.id, name: e.name, module: e.module })),
    renderables: app.catalogue.entries.map((e) => ({
      id: e.id,
      name: e.name,
      by: e.by,
      module: e.module,
      capabilities: e.capabilities,
      signed: e.signed,
    })),
    regions: (app.regions?.regions ?? []).map((status) => ({
      region: status.region,
      route: status.route,
      locus: status.declared,
      where: status.bound?.executor ?? 'unresolved',
    })),
    assets,
    static: prerendered.documents.map((d) => ({
      pattern: d.pattern,
      path: d.path,
      file: d.file,
      bytes: d.bytes,
    })),
    refused: prerendered.refused,
    diagnostics: app.diagnostics,
  }
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

/**
 * The sealed markup a page carries: the part of it that is not values. Every template each slot
 * needs, not only its entry, or a page whose text lives in a row would report almost nothing.
 */
function markupBytes(compiled: CompiledApp, ids: readonly string[]): number {
  const counted = new Set<string>()
  let total = 0
  for (const id of new Set(ids)) {
    const fragment = Object.values(compiled.fragments).find((f) => f.entry.id === id)
    if (!fragment) continue
    for (const template of fragment.templates) {
      if (counted.has(template.version)) continue
      counted.add(template.version)
      total += template.segments.reduce((sum, segment) => sum + segment.length, 0)
    }
  }
  return total
}

/**
 * The build, loaded back. `weft start` runs no compiler — it reads the sealed templates the build
 * wrote and validates each on the way in, so what is served is byte-for-byte what was measured.
 */
export async function loadBuild(discovered: Discovered, config: ResolvedConfig): Promise<CompiledApp> {
  const dir = join(config.root, config.outDir, 'ir')
  let manifest: IrManifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as IrManifest
  } catch {
    throw new Error(
      `E_NO_BUILD: ${config.outDir}/ir/manifest.json does not exist. Run \`weft build\` before \`weft start\``,
    )
  }

  const templates = new Map<string, TemplateIR>()
  for (const [version, file] of Object.entries(manifest.templates)) {
    const { ir } = parse(await readFile(join(dir, file), 'utf8'))
    templates.set(version, ir)
  }

  const fragments: Record<string, CompiledFragment> = {}
  // A station that shows source gets it when `app/` shipped and an empty string when it did not.
  const sourceOf = async (file: string): Promise<string> => {
    try {
      return await readFile(join(config.root, file), 'utf8')
    } catch {
      return ''
    }
  }
  for (const [name, record] of Object.entries(manifest.fragments)) {
    const entry = templates.get(record.entry)
    if (!entry) {
      throw new Error(`E_MISSING_TEMPLATE: ${name} names version ${record.entry}, which is not in the build`)
    }
    const owned = record.templates
      .map((version) => templates.get(version))
      .filter((t): t is TemplateIR => Boolean(t))
    const byVersion = new Map(owned.map((t) => [t.version, t]))
    fragments[name] = {
      entry,
      templates: owned,
      resolve: (version) => byVersion.get(version),
      file: record.file,
      source: await sourceOf(record.file),
    }
  }

  // Every route with a template of its own has to be in the build, or a page added since 404s
  // with no explanation. A route with no `.tsx` is exempt — its body is named by its declaration.
  for (const route of discovered.routes) {
    if (!route.file || fragments[`route:${route.pattern}`]) continue
    throw new Error(
      `E_STALE_BUILD: ${route.pattern} is a route in ${config.srcDir}/routes but not in the build. Run \`weft build\``,
    )
  }

  return { fragments, diagnostics: [], templates: [...templates.values()] }
}

/** The build report: a line per route, then the L0 section — which pages became files, and why not. */
export function formatReport(report: BuildReport): string {
  const lines: string[] = ['']
  lines.push(`  ${report.templates} sealed templates · ${report.routes.length} routes`)
  lines.push('')
  for (const route of report.routes) {
    const live = route.live.length ? `  live:${route.live.join(',')}` : ''
    lines.push(
      `  ${route.pattern.padEnd(26)} ${String(route.slots).padStart(2)} slots  ` +
        `${String(route.markupBytes).padStart(6)} B markup  ${route.styles.length} css${live}`,
    )
  }
  lines.push('')
  const immutable = report.assets.filter((a) => a.immutable)
  for (const asset of immutable) {
    lines.push(`  ${asset.href.padEnd(56)} ${String(asset.bytes).padStart(7)} B  immutable`)
  }
  if (report.static.length || report.refused.length) {
    lines.push('')
    lines.push(`  L0 — resolved at build time, served without the kernel:`)
    for (const document of report.static) {
      lines.push(
        `    ${document.pattern.padEnd(26)} ${String(document.bytes).padStart(7)} B  ${STATIC_DIR}/${document.file}`,
      )
    }
    for (const refusal of report.refused) {
      lines.push(`    ${refusal.pattern.padEnd(26)} ${refusal.code} — ${refusal.reason}`)
    }
  }
  if (report.intents.length) {
    lines.push('')
    for (const intent of report.intents) {
      lines.push(`  intent ${intent.id}  ${intent.name.padEnd(18)} ${intent.module}`)
    }
  }
  if (report.renderables.length) {
    lines.push('')
    for (const entry of report.renderables) {
      lines.push(
        `  render ${entry.id}  ${entry.name.padEnd(18)} ${entry.by.padEnd(24)}` +
          `${entry.capabilities.join(',') || '—'}${entry.signed ? '  signed' : ''}`,
      )
    }
  }
  if (report.regions.length) {
    lines.push('')
    for (const region of report.regions) {
      lines.push(
        `  region ${region.region.padEnd(16)} ${region.locus.padEnd(8)} ${region.where.padEnd(20)} ${region.route}`,
      )
    }
    // The registry can be written to without anybody rebuilding, so the build states what it saw
    // and `weft verify` gates.
    lines.push(`  \`weft verify --probe\` asks each one what it is serving right now`)
  }
  if (report.diagnostics.length) {
    lines.push('')
    lines.push(`  ${report.diagnostics.length} type diagnostics — escape elision fell back to escaping:`)
    for (const line of report.diagnostics.slice(0, 10)) lines.push(`    ${line}`)
  }
  lines.push('')
  lines.push(
    `  wrote ${report.outDir}/ — ir, routes.json, intents.json, catalogue.json, assets/, ${STATIC_DIR}/, report.json`,
  )
  lines.push('')
  return lines.join('\n')
}

/** The recorded figure a growth cap is measured against, or nothing on a first build. Committed,
 * so a regression is a diff. */
async function readBaseline(path: string): Promise<number | undefined> {
  try {
    const held = JSON.parse(await readFile(path, 'utf8')) as { brotli?: number }
    return typeof held.brotli === 'number' ? held.brotli : undefined
  } catch {
    return undefined
  }
}
