import { brotliCompressSync, constants } from 'node:zlib'
import {
  build,
  createApp,
  discover,
  loadBuild,
  loadConfig,
  measureClientJs,
  serveApp,
} from '@weftjs/core/server'

/**
 * What a page downloads, fetched rather than computed — and the same figure computed, beside it.
 *
 * `weft build` already reports what a page downloads: `measureClientJs` walks the import graph, and
 * `budget({ js, grow })` is enforced against it. That walk is done over files on disk, which is the
 * right way to gate a build and is not proof that a browser receives those bytes. Between the two
 * sit specifier rewrites, type stripping, comment stripping and whatever a host adds — every one of
 * them a place where the number a build reports and the number a reader pays could part company.
 *
 * So this asks the running server. It fetches the document, takes the module the document names,
 * follows every relative specifier in what comes back, and compresses each response on its own —
 * which is how each one arrives, there being no bundler to share a window between them.
 *
 * The agreement is the point rather than either number. `spec/FINDINGS.md` has said "the same walk
 * over HTTP agrees within 0.3%" since the reversal that put it there, and until now that sentence
 * was the only record of a measurement nobody could re-run: it was made once, by hand, and the
 * figure beside it went stale twice while the claim about it did not move. A cross-check that
 * cannot be re-run is a memory of a cross-check.
 */
export interface DownloadReport {
  root: string
  /** The document whose modules were walked. */
  path: string
  /** What the server actually sent, module by module. */
  served: { modules: number; raw: number; brotli: number }
  /** What `weft build` reports for the same application, through the same function it gates on. */
  built: { modules: number; raw: number; brotli: number }
  /** How far apart the two are, as a percentage of the served figure. */
  driftPercent: number
}

export interface DownloadOptions {
  root: string
  /** Which document to start from. Defaults to the first route the build reports. */
  path?: string
}

const BROTLI = { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }

function compressed(body: string): { raw: number; brotli: number } {
  const bytes = Buffer.from(body, 'utf8')
  return { raw: bytes.byteLength, brotli: brotliCompressSync(bytes, BROTLI).byteLength }
}

/**
 * Every relative specifier in a module, which is the whole of what a browser follows.
 *
 * Bare specifiers are not followed because they are not fetched: the build rewrites the two this
 * framework has into paths, so anything still bare at this point is not something the browser will
 * ask for. `import()` is not followed either — a dynamic import is code the page decided not to
 * need yet, and counting it would report a download that has not happened.
 */
function specifiers(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/(?:^|[\s;}])(?:from|import)\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1] as string
    if (specifier.startsWith('/') || specifier.startsWith('.')) found.push(specifier)
  }
  return found
}

export async function measureDownload(options: DownloadOptions): Promise<DownloadReport> {
  const report = await build(options.root)
  const config = await loadConfig(options.root, {})
  const discovered = await discover(options.root, config.srcDir)
  const compiled = await loadBuild(discovered, config)
  const app = await createApp(options.root, { mode: 'start', compiled, port: 0 })
  const serving = await serveApp(app)

  try {
    const path = options.path ?? report.static[0]?.pattern ?? '/'
    const document = await (await fetch(new URL(path, serving.url))).text()
    const roots = [...document.matchAll(/<script type="module" src="([^"]+)"/g)].map(
      (match) => match[1] as string,
    )
    if (!roots.length) {
      throw new Error(
        `E_NO_CLIENT: ${path} loads no module, so there is no download to measure. Point --route at ` +
          `a page that does.`,
      )
    }

    const seen = new Map<string, { raw: number; brotli: number }>()
    const walk = async (href: string): Promise<void> => {
      const url = new URL(href, serving.url)
      if (seen.has(url.pathname)) return
      const body = await (await fetch(url)).text()
      seen.set(url.pathname, compressed(body))
      for (const specifier of specifiers(body)) await walk(new URL(specifier, url).pathname)
    }
    for (const href of roots) await walk(href)

    const built = await measureClientJs(app.assets, app.assets.app)
    const served = {
      modules: seen.size,
      raw: [...seen.values()].reduce((sum, one) => sum + one.raw, 0),
      brotli: [...seen.values()].reduce((sum, one) => sum + one.brotli, 0),
    }
    return {
      root: options.root,
      path,
      served,
      built: { modules: built.modules.length, raw: built.raw, brotli: built.brotli },
      driftPercent: served.brotli ? (Math.abs(served.brotli - built.brotli) / served.brotli) * 100 : 0,
    }
  } finally {
    await serving.close()
  }
}

const row = (label: string, one: { modules: number; raw: number; brotli: number }): string =>
  `  ${label.padEnd(22)}${String(one.modules).padStart(3)} modules  ` +
  `${one.brotli.toLocaleString('en-US').padStart(8)} B brotli  (${one.raw.toLocaleString('en-US')} raw)`

export function formatDownload(report: DownloadReport): string {
  return [
    '',
    `  ${report.root} — the client of ${report.path}, each module compressed as it arrives`,
    '',
    row('fetched over HTTP', report.served),
    row('walked at build time', report.built),
    '',
    `  ${report.driftPercent.toFixed(2)}% apart. The build's walk is what \`budget({ js, grow })\` gates on;`,
    '  this is the same set asked of the running server, so the gate is checked against the wire.',
    '',
  ].join('\n')
}
