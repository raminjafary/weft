import { readFile, readdir, stat } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { extname, join, relative, sep } from 'node:path'
import { fastHash, short } from '@weft/ir'

/**
 * Every URL the browser fetches, revved.
 *
 * An asset served under a stable name can only ever be sent with `no-store`, and a framework
 * whose whole argument is about bytes cannot then ask the browser to re-fetch its own runtime on
 * every visit. So a production URL carries a digest of what it contains and is immutable for a
 * year; `weft dev` serves the same bytes at a stable name with no store at all. Two policies,
 * one asset table, and the dev one is the one that must never cache.
 *
 * Modules are revved by *directory* rather than by file, and that is not a shortcut. A module
 * graph's imports are relative specifiers, so hashing each file would mean rewriting every
 * import to its neighbour's digest and re-hashing until it converged. Hashing the tree once and
 * mounting it under that digest gets the same immutability with none of that: the imports inside
 * are untouched, and the whole tree moves when any file in it does.
 */
export interface Asset {
  body: string | Uint8Array
  type: string
  immutable: boolean
}

export interface ModuleTree {
  dir: string
  /** `.ts` means the source still has its types and they are stripped on the way out. */
  ext: '.js' | '.ts'
}

export interface AssetTable {
  /** Everything served verbatim, by path. */
  files: Map<string, Asset>
  /** Module trees, by the prefix they are mounted at. */
  trees: Map<string, ModuleTree>
  /** The one stylesheet a page links. */
  pageCss(pattern: string): string
  /** The client entry a layout loads. */
  boot: string
  /** `app/client.ts`, when the application has one. Imported by the boot after adoption. */
  app?: string
  /**
   * A file from `public/`, by the path an author wrote. Unknown paths throw: a missing asset
   * should fail the render that referenced it, not become a 404 nobody sees until production.
   */
  asset(path: string): string
  /** Original path to revved href, for a build artifact a CDN can be pointed at. */
  manifest: Record<string, string>
  /** True when URLs carry a digest, which is the only state in which they can be cached. */
  revved: boolean
}

const MODULE_ROOT = '/_weft/m'
const CSS_ROOT = '/_weft/a'
const PUBLIC_ROOT = '/_weft/p'
const IMMUTABLE = 'public, max-age=31536000, immutable'

export function cacheControlFor(asset: Asset): string {
  return asset.immutable ? IMMUTABLE : 'no-store'
}

export function slugOf(pattern: string): string {
  return (
    pattern
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'index'
  )
}

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
}

/** A content digest, which is the whole of what makes a URL cacheable. */
function digestOf(body: string | Uint8Array): string {
  return short(fastHash(typeof body === 'string' ? body : Buffer.from(body).toString('base64')), 10)
}

export function typeOf(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else out.push(path)
  }
  return out
}

async function treeDigest(trees: readonly ModuleTree[]): Promise<string> {
  const parts: string[] = []
  for (const tree of trees) {
    for (const name of (await readdir(tree.dir)).sort()) {
      if (!name.endsWith(tree.ext)) continue
      parts.push(name, await readFile(join(tree.dir, name), 'utf8'))
    }
  }
  return short(fastHash(parts.join(' ')), 10)
}

export interface AssetInput {
  /**
   * One bundle per route: the framework's stylesheet, the application's, the layout's, and the
   * one belonging to every fragment that page renders — in that cascade order.
   *
   * One request rather than several, and content-addressed rather than named, so two pages whose
   * CSS is identical share a URL and therefore a cache entry. A page still links only the
   * stylesheets of the components on it, which is the property worth having; paying a request per
   * component to prove it is not.
   */
  pageCss: Map<string, string>
  /** `public/`, served as it is written and revved by content. */
  publicDir: string
  runtime: ModuleTree
  warp: ModuleTree
  client: ModuleTree
  /** `app/client.ts` and anything beside it: the application's own browser code. */
  app?: ModuleTree
  /** `false` in dev: stable names, never stored. */
  revved: boolean
}

export async function buildAssets(input: AssetInput): Promise<AssetTable> {
  const files = new Map<string, Asset>()
  const trees = new Map<string, ModuleTree>()
  const manifest: Record<string, string> = {}
  const { revved } = input

  const pages = new Map<string, string>()
  for (const [pattern, css] of input.pageCss) {
    const href = revved ? `${CSS_ROOT}/${digestOf(css)}.css` : `${CSS_ROOT}/${slugOf(pattern)}.css`
    files.set(href, { body: css, type: TYPES['.css'] as string, immutable: revved })
    manifest[`css/${slugOf(pattern)}.css`] = href
    pages.set(pattern, href)
  }

  // `public/`. Revved by a directory segment rather than by mangling the filename, so an author
  // referring to `/logo.svg` still sees `logo.svg` in the network panel and in a stack trace.
  const publicFiles = new Map<string, string>()
  for (const file of await walk(input.publicDir)) {
    const rel = `/${relative(input.publicDir, file).split(sep).join('/')}`
    const body = await readFile(file)
    const href = revved ? `${PUBLIC_ROOT}/${digestOf(body)}${rel}` : `${PUBLIC_ROOT}${rel}`
    files.set(href, { body, type: typeOf(file), immutable: revved })
    // Also reachable at the path the author wrote, so a hand-written `<img src="/logo.svg">`
    // works — unrevved, because a URL that does not name its content cannot be cached.
    files.set(rel, { body, type: typeOf(file), immutable: false })
    publicFiles.set(rel, href)
    manifest[rel.slice(1)] = href
  }

  const digest = revved
    ? await treeDigest([input.client, input.runtime, input.warp, ...(input.app ? [input.app] : [])])
    : 'dev'
  const prefix = `${MODULE_ROOT}/${digest}`
  trees.set(`${prefix}/client/`, input.client)
  trees.set(`${prefix}/runtime/`, input.runtime)
  trees.set(`${prefix}/warp/`, input.warp)
  if (input.app) trees.set(`${prefix}/app/`, input.app)
  const boot = `${prefix}/client/boot${input.client.ext}`
  manifest['client/boot.js'] = boot
  const app = input.app ? `${prefix}/app/client${input.app.ext}` : undefined
  if (app) manifest['app/client.js'] = app

  return {
    files,
    trees,
    boot,
    ...(app ? { app } : {}),
    pageCss: (pattern) => {
      const href = pages.get(pattern)
      if (!href) throw new Error(`E_NO_PAGE_CSS: no stylesheet was built for ${pattern}`)
      return href
    },
    asset(path) {
      const key = path.startsWith('/') ? path : `/${path}`
      const href = publicFiles.get(key)
      if (!href) {
        throw new Error(
          `E_NO_ASSET: ${key} is not in public/. Known: ${[...publicFiles.keys()].join(', ') || 'nothing'}`,
        )
      }
      return href
    },
    manifest,
    revved,
  }
}

/**
 * A client module on its way to the browser: types stripped, and bare specifiers rewritten to
 * the paths those packages are mounted at. That is the whole of it. The alternative is a
 * bundler, and the alternative to a bundler is two replacements.
 */
export function browserModule(source: string, tree: ModuleTree, mountedAt: string): string {
  const stripped = tree.ext === '.ts' ? stripTypeScriptTypes(source, { mode: 'strip' }) : source
  const root = mountedAt.replace(/\/[a-z]+\/$/, '')
  return stripped
    .replace(/(['"])@weft\/client\1/g, `'${root}/runtime/index${tree.ext}'`)
    .replace(/(['"])@weft\/warp\1/g, `'${root}/warp/index${tree.ext}'`)
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
