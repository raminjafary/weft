import type { AssetPort, PreloadLink } from '@weftjs/kernel'
import { readFile, readdir, stat } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '@weftjs/compiler'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fastHash, short } from '@weftjs/ir'

/**
 * Every URL the browser fetches, revved. A production URL carries a digest of what it contains and
 * is immutable for a year; `weft dev` serves the same bytes at a stable name.
 *
 * The table, the three roots and the three cache policies are `spec/kernel/static.md`.
 */
export interface Asset {
  body: string | Uint8Array
  type: string
  immutable: boolean
}

/** The client modules a page pulls in, walked from its boot module. */
export interface ModuleTree {
  dir: string
  /** `.ts` means the source still has its types and they are stripped on the way out. */
  ext: '.js' | '.ts'
}

/**
 * The URL a client module is served at, which always ends in `.js`. A static host reads `.ts` as an
 * MPEG transport stream and the browser then refuses the module — see `spec/kernel/static.md`.
 */
export function servedModuleName(fileName: string, tree: ModuleTree): string {
  return tree.ext === '.ts' ? `${fileName.slice(0, -tree.ext.length)}.js` : fileName
}

/** The file behind a served module URL, which is the inverse of `servedModuleName`. */
export function moduleFileName(served: string, tree: ModuleTree): string {
  return tree.ext === '.ts' && served.endsWith('.js') ? `${served.slice(0, -'.js'.length)}.ts` : served
}

/**
 * Every URL the browser will fetch, and the digest that makes it immutable.
 *
 * Built after the generator has said which stylesheets each page links, because an href carries a
 * hash of the bundle's contents — so there is one late binding here rather than an unrevved URL.
 */
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

/** Where each kind of generated URL is mounted, by its own initial: assets, styles, modules. */
const ASSET_ROOT = '/_weft/a'
const STYLE_ROOT = '/_weft/s'
const MODULE_ROOT = '/_weft/m'

/**
 * The three roots, exported for the one question that has to be asked about a URL nothing matched:
 * a *miss* under one of them must be stored by nobody. See `spec/kernel/static.md`.
 */
export const IMMUTABLE_ROOTS = [ASSET_ROOT, STYLE_ROOT, MODULE_ROOT] as const

/** Whether a path is under a root whose URLs name their own contents. */
export function addressedByDigest(path: string): boolean {
  return IMMUTABLE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
}

/** What a miss under one of those roots answers with. Never stored, so a 404 cannot outlive a rollback. */
export const MISS = 'no-store'
/** A year, and a shared cache may answer with it too — `s-maxage` is the only line a CDN reads. */
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable'
/** Keep the copy, but never use it without asking first. Storing it is what avoids the unstyled frame. */
const REVALIDATE = 'no-cache'

/** A year and immutable for a digest-bearing URL, revalidate-always for a stable one. */
export function cacheControlFor(asset: Asset): string {
  return cacheControl(asset.immutable)
}

/**
 * The same decision, for a caller holding the fact rather than the asset. Nothing may assume
 * immutability from a path: `public/` is also served at the name its author wrote.
 */
export function cacheControl(immutable: boolean): string {
  return immutable ? IMMUTABLE : REVALIDATE
}

/** A route pattern as a filename component, so a per-route bundle has a readable name. */
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

/** A content type from an extension. Unknown extensions are octet-stream rather than guessed. */
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

/**
 * `app/assets/`, revved: nothing in it is reachable at the path it was written at, and every file is
 * published once under a digest of its own contents. The two directories are
 * `spec/kernel/static.md`; `rewriteUrls` is the other half of this.
 */
export interface RevvedAssets {
  /** Every file, by the URL it is published at. */
  files: Map<string, Asset>
  /** Absolute path on disk to that URL, which is what a `url()` rewrite resolves through. */
  byPath: Map<string, string>
  /** The path an author writes to its URL, for `asset()`. */
  byName: Map<string, string>
  /** Original path to revved href, for the build manifest. */
  manifest: Record<string, string>
}

/** Walk it, hash each file, and mount every one under its own digest. */
export async function revAssets(dir: string, revved: boolean): Promise<RevvedAssets> {
  const files = new Map<string, Asset>()
  const byPath = new Map<string, string>()
  const byName = new Map<string, string>()
  const manifest: Record<string, string> = {}
  for (const file of await walk(dir)) {
    const name = relative(dir, file).split(sep).join('/')
    const body = await readFile(file)
    // A directory segment rather than a mangled filename, so `inter.woff2` is still `inter.woff2`
    // in the network panel and in a stack trace.
    const href = revved ? `${ASSET_ROOT}/${digestOf(body)}/${name}` : `${ASSET_ROOT}/${name}`
    files.set(href, { body, type: typeOf(file), immutable: revved })
    // Absolute, because `rewriteUrls` resolves against the sheet's own directory, which always is.
    // A caller passing a relative root filled this with relative keys and every lookup missed —
    // `E_NO_ASSET` naming a file sitting exactly where it said it was not.
    byPath.set(resolve(file), href)
    byName.set(name, href)
    manifest[name] = href
  }
  return { files, byPath, byName, manifest }
}

/**
 * Every `url()` in a stylesheet that names a file in `app/assets/`, pointed at its revved URL.
 * Resolved against the sheet's own directory; anything not relative is left exactly as written, and
 * a relative one that resolves to nothing is `E_NO_ASSET`. See `spec/kernel/static.md`.
 */
export function rewriteUrls(css: string, fromDir: string, byPath: ReadonlyMap<string, string>): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote: string, raw: string) => {
    const target = raw.trim()
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) {
      return whole
    }
    // A fragment or query on the end belongs to the URL, not to the file it names.
    const [path = ''] = target.split(/[?#]/)
    const resolved = resolve(fromDir, path)
    const href = byPath.get(resolved)
    if (!href) {
      throw new Error(
        `E_NO_ASSET: a stylesheet asks for url(${target}), which resolves to ${resolved}, and no file ` +
          `in app/assets/ is there. Only app/assets/ is rewritten — a file that must keep the URL it ` +
          `is written at belongs in public/, named from the site root.`,
      )
    }
    return `url(${quote}${href}${target.slice(path.length)}${quote})`
  })
}

/** What the asset build needs: what each route links, and where the framework's own files are. */
export interface AssetInput {
  /**
   * One bundle per route, in cascade order: framework, application, layout, then every fragment the
   * page renders. Content-addressed, so two pages whose CSS is identical share a cache entry.
   */
  pageCss: Map<string, string>
  /** `public/`, copied: every file at the path it was written at, and nothing else. */
  publicDir: string
  /** `app/assets/`, processed: every file under a digest, and reachable no other way. */
  assetsDir?: string
  runtime: ModuleTree
  warp: ModuleTree
  client: ModuleTree
  /** `app/client.ts` and anything beside it: the application's own browser code. */
  app?: ModuleTree
  /** `app/assets/`, already walked — the caller needs it first, to rewrite `url()` before concatenating. */
  assets?: RevvedAssets
  /** `false` in dev: stable names, never stored. */
  revved: boolean
}

/** Bundle the stylesheets, walk the modules, and rev every URL by its own contents. */
export async function buildAssets(input: AssetInput): Promise<AssetTable> {
  const files = new Map<string, Asset>()
  const trees = new Map<string, ModuleTree>()
  const manifest: Record<string, string> = {}
  const { revved } = input

  const pages = new Map<string, string>()
  for (const [pattern, css] of input.pageCss) {
    const href = revved ? `${STYLE_ROOT}/${digestOf(css)}.css` : `${STYLE_ROOT}/${slugOf(pattern)}.css`
    files.set(href, { body: css, type: TYPES['.css'] as string, immutable: revved })
    manifest[`css/${slugOf(pattern)}.css`] = href
    pages.set(pattern, href)
  }

  // `public/`, copied: one URL, the path the author wrote, and never immutable.
  for (const file of await walk(input.publicDir)) {
    const rel = `/${relative(input.publicDir, file).split(sep).join('/')}`
    files.set(rel, { body: await readFile(file), type: typeOf(file), immutable: false })
  }

  // `app/assets/`, processed. Already walked by the caller when a stylesheet needed rewriting
  // against it, because the rewrite has to happen before the sheets are concatenated.
  const revvedAssets =
    input.assets ?? (await revAssets(input.assetsDir ?? join(input.publicDir, '..', 'assets'), revved))
  for (const [href, asset] of revvedAssets.files) files.set(href, asset)
  Object.assign(manifest, revvedAssets.manifest)
  const assetFiles = revvedAssets.byName

  const digest = revved
    ? await treeDigest([input.client, input.runtime, input.warp, ...(input.app ? [input.app] : [])])
    : 'dev'
  const prefix = `${MODULE_ROOT}/${digest}`
  trees.set(`${prefix}/client/`, input.client)
  trees.set(`${prefix}/runtime/`, input.runtime)
  trees.set(`${prefix}/warp/`, input.warp)
  if (input.app) trees.set(`${prefix}/app/`, input.app)
  const boot = `${prefix}/client/boot.js`
  manifest['client/boot.js'] = boot
  const app = input.app ? `${prefix}/app/client.js` : undefined
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
      const key = path.replace(/^\//, '')
      const href = assetFiles.get(key)
      if (!href) {
        throw new Error(
          `E_NO_ASSET: ${key} is not in app/assets/. Known: ${[...assetFiles.keys()].join(', ') || 'nothing'}. ` +
            `A file in public/ is reached by the path it is written at and needs no lookup.`,
        )
      }
      return href
    },
    manifest,
    revved,
  }
}

/**
 * The bare specifiers the front door rewrites, and the module tree each one resolves into. Exported,
 * and the only statement of this anywhere — `measureClientJs` walks the same pair, and the two have
 * drifted before. See `spec/kernel/static.md`.
 */
export const REWRITTEN_SPECIFIERS: Record<string, string> = {
  '@weftjs/client': 'runtime',
  '@weftjs/warp': 'warp',
}

/**
 * A client module on its way to the browser: types stripped, and every specifier — bare or relative
 * — rewritten to the URL it is served at, which always ends in `.js`. That is the whole of it, and
 * it is the alternative to a bundler. See `spec/kernel/static.md`.
 */
export function browserModule(
  source: string,
  tree: ModuleTree,
  mountedAt: string,
  options: { comments?: 'keep' | 'strip' } = {},
): string {
  // The prose comes out before the types do, on the original source, which is the one form the
  // parser is guaranteed to accept. Kept in dev. See `spec/kernel/static.md`.
  const said = options.comments === 'strip' ? stripComments(`module${tree.ext}`, source).code : source
  const stripped = tree.ext === '.ts' ? stripTypeScriptTypes(said, { mode: 'strip' }) : said
  const root = mountedAt.replace(/\/[a-z]+\/$/, '')
  let out = stripped
  for (const [specifier, name] of Object.entries(REWRITTEN_SPECIFIERS)) {
    const quoted = new RegExp(`(['"])${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\1`, 'g')
    out = out.replace(quoted, `'${root}/${name}/index.js'`)
  }
  return out.replace(/(['"])(\.{1,2}\/[^'"]*)\.ts\1/g, '$1$2.js$1')
}

function importsOf(source: string): string[] {
  const out: string[] = []
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push(match[1] as string)
  }
  return out
}

/**
 * Every module a page will fetch, in the order the browser will discover them. Walked rather than
 * declared, and `import()` is deliberately not followed.
 *
 * One implementation, two callers — the byte budget measures this set and the document preloads it.
 * See `spec/kernel/static.md`.
 */
export async function moduleGraph(assets: AssetTable, appClient?: string): Promise<string[]> {
  const trees = [...assets.trees.entries()]
  const treeFor = (href: string): { prefix: string; tree: ModuleTree } | undefined => {
    const found = trees.find(([prefix]) => href.startsWith(prefix))
    return found ? { prefix: found[0], tree: found[1] } : undefined
  }

  const seen = new Set<string>()
  const order: string[] = []
  const queue = [assets.boot, ...(appClient ? [appClient] : [])]

  while (queue.length) {
    const href = queue.shift() as string
    if (seen.has(href)) continue
    seen.add(href)
    const located = treeFor(href)
    if (!located) continue
    order.push(href)
    const name = href.slice(located.prefix.length)
    let source: string
    try {
      source = await readFile(join(located.tree.dir, moduleFileName(name, located.tree)), 'utf8')
    } catch {
      throw new Error(
        `E_MODULE_UNREADABLE: ${href} is in the module graph and could not be read from ` +
          `${located.tree.dir}. A page would 404 on it.`,
      )
    }
    for (const specifier of importsOf(source)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        // The served name, not the source's: a `modulepreload` naming `.ts` preloads a URL nothing
        // requests, and the module is then downloaded twice.
        const resolved = new URL(specifier, `file:///${href.replace(/^\//, '')}`).pathname
        queue.push(resolved.endsWith('.ts') ? `${resolved.slice(0, -'.ts'.length)}.js` : resolved)
        continue
      }
      const tree = REWRITTEN_SPECIFIERS[specifier]
      if (!tree) continue
      const target = trees.find(([prefix]) => prefix.endsWith(`/${tree}/`))
      if (target) queue.push(`${target[0]}index.js`)
    }
  }
  return order
}

/**
 * The graph as `<link rel="modulepreload">`, for the head of a document — the whole fix for the
 * waterfall, and it needs no 103. The boot module is left out: it is already a `<script src>` in
 * the same head.
 */
export function modulePreloads(graph: readonly string[], boot: string): string {
  return graph
    .filter((href) => href !== boot)
    .map((href) => `<link rel="modulepreload" href="${href}">`)
    .join('')
}

/**
 * Every module file the deployment can be asked for, at the URL it answers on: every direct child of
 * every mounted tree, deliberately not the reachable import graph. `prelude` is prepended to the
 * boot module for the same reason the server prepends it there. See `spec/kernel/static.md`.
 */
export async function moduleFiles(assets: AssetTable, prelude = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const [mountedAt, tree] of assets.trees) {
    for (const name of (await readdir(tree.dir)).sort()) {
      if (!name.endsWith(tree.ext)) continue
      const href = `${mountedAt}${servedModuleName(name, tree)}`
      // `weft build` is production output by definition.
      const body = browserModule(await readFile(join(tree.dir, name), 'utf8'), tree, mountedAt, {
        comments: 'strip',
      })
      out.set(href, href === assets.boot ? prelude + body : body)
    }
  }
  return out
}

/** Whether the path is a directory. False for anything that cannot be read, including absent. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * What a route needs before it has been rendered, which is the whole of what 103 is for. Asked
 * while the envelope is still open, so answering costs a map lookup rather than a render, and only
 * what is *critical* goes in. See `spec/kernel/lifecycle.md`.
 */
export function weftAssets(table: () => AssetTable): AssetPort {
  return {
    name: 'weft',
    criticalFor(route) {
      const assets = table()
      const links: PreloadLink[] = [
        { href: assets.pageCss(route), as: 'style', rel: 'preload' },
        { href: assets.boot, as: 'script', rel: 'modulepreload' },
      ]
      // Imported by the runtime after adoption, so without a hint it is one round trip later.
      if (assets.app) links.push({ href: assets.app, as: 'script', rel: 'modulepreload' })
      return links
    },
    chunksFor(route) {
      const assets = table()
      return [assets.pageCss(route), assets.boot, ...(assets.app ? [assets.app] : [])]
    },
  }
}
