import type { AssetPort, PreloadLink } from '@weftjs/kernel'
import { readFile, readdir, stat } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { stripComments } from '@weftjs/compiler'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fastHash, short } from '@weftjs/ir'

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

/** The client modules a page pulls in, walked from its boot module. */
export interface ModuleTree {
  dir: string
  /** `.ts` means the source still has its types and they are stripped on the way out. */
  ext: '.js' | '.ts'
}

/**
 * The URL a client module is served at, which always ends in `.js`.
 *
 * The bytes are JavaScript by the time anybody receives them — types are stripped on the way out —
 * so the extension in the URL is about who is doing the serving, and a `.ts` URL is only ever a
 * liability. weft's own server knows `.ts` means JavaScript because `TYPES` says so; a static host
 * consults the extension and nothing else, and every one of them reads `.ts` as an MPEG transport
 * stream. `video/mp2t` fails strict MIME checking, so the browser refuses the module.
 *
 * That was not hypothetical either. An application's own client module is `app/client.ts`, always
 * source and never built, so it was served at a `.ts` URL for every weft application ever deployed
 * to a host that serves files rather than proxying to weft — which took out the theme toggle, the
 * search panel, the tab strips and the intent buttons on this project's own documentation site, with
 * one console error naming a video codec.
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

/**
 * Where each kind of generated URL is mounted, by its own initial.
 *
 * `a` used to be the stylesheets and `p` used to be `public/`, which stopped being true the moment
 * `public/` became a directory that is copied rather than revved — it was `app/assets/` mounted at
 * a letter standing for a directory it no longer holds. The initials say what is behind them now:
 * assets, styles, modules.
 *
 * A stylesheet is `a/<digest>.css` and an asset is `a/<digest>/<name>`, sharing a root without
 * colliding: one is a file and the other is a directory segment, and a served file is matched by
 * its whole path rather than by a prefix.
 */
const ASSET_ROOT = '/_weft/a'
const STYLE_ROOT = '/_weft/s'
const MODULE_ROOT = '/_weft/m'

/**
 * The three roots, exported for the one question that has to be asked about a URL nothing matched.
 *
 * A path under one of these is content-addressed, which is what earns it a year. The corollary is
 * the part that had no code: a *miss* under one of them must be stored by nobody. A digest is not a
 * promise that the file exists — it is a promise about what the file contains if it does — and a
 * build that removes a module, or a rollback to one that has it again, is a URL whose answer
 * changes from 404 to 200. A 404 held for a year at that URL is a client that cannot load the
 * runtime until the cache expires, and the deploy most likely to produce it is a rollback.
 */
export const IMMUTABLE_ROOTS = [ASSET_ROOT, STYLE_ROOT, MODULE_ROOT] as const

/** Whether a path is under a root whose URLs name their own contents. */
export function addressedByDigest(path: string): boolean {
  return IMMUTABLE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
}

/**
 * What a miss under one of those roots answers with.
 *
 * `no-store` rather than `no-cache`: there is nothing here to revalidate, and the whole risk is a
 * copy being kept. It is also the one header on this page that has to survive a platform's own
 * caching rules, which are written per path and cannot see a status.
 */
export const MISS = 'no-store'
/**
 * A year, and a shared cache may answer with it too.
 *
 * `s-maxage` is not a second opinion about the year — it is the only line a CDN in front of a
 * deployment reads. Several treat a bare `max-age` on a generated response as the browser's
 * business and decline to hold anything themselves, which is how a build that revs every URL and
 * calls it immutable still served every module from the origin, once per reader. The measurement
 * that found it: twenty-four asset requests for one page of the documentation site, every one of
 * them a cache miss with an age of zero.
 *
 * Unconditional, unlike the policy on a document, and for a reason that is not a judgement call:
 * the URL carries a digest of the bytes it answers with. There is no deploy that changes what this
 * URL means, so there is no purge for a cache to have missed.
 */
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable'
/**
 * Keep the copy, but never use it without asking first.
 *
 * `no-store` was the obvious reading of "a stylesheet you just edited must not be served stale",
 * and it is stronger than that sentence needs. It forbids the client from *holding* the bytes, so
 * every reload re-downloads the stylesheet, and the document begins parsing before it lands — one
 * unstyled frame per refresh, which is the flicker. Worse when the page is scrolled, because scroll
 * is restored against the unstyled layout and then jumps when the real one arrives.
 *
 * `no-cache` keeps the promise and drops the cost: the client stores the response and revalidates
 * it on every use, so an edited stylesheet still cannot be served from cache — the server answers
 * 200 with new bytes the moment they differ, and 304 with none when they do not.
 */
const REVALIDATE = 'no-cache'

/**
 * A year and immutable for a digest-bearing URL, revalidate-always for a stable one.
 *
 * `weft dev` serves the same bytes at stable names, because a stylesheet you just edited served as
 * immutable is a framework that lies to you for a year. The validator, not the storage ban, is what
 * keeps that honest — see `REVALIDATE`.
 */
export function cacheControlFor(asset: Asset): string {
  return cacheControl(asset.immutable)
}

/**
 * The same decision, for a caller holding the fact rather than the asset.
 *
 * A URL that names its own contents may be held for a year; one that does not may be held and must
 * be asked about. Nothing may assume the first from a path: `public/` is served at the name its
 * author wrote as well as at a revved one, and a favicon linked as `/mark.svg` served immutable is
 * a year of the old icon for everyone who has already seen it.
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
 * `app/assets/`, revved.
 *
 * The processed half of the two directories an application has, and the distinction between them
 * is what each is *for* rather than what is in it. `public/` is copied: a file goes out at the path
 * it was written at, byte for byte, because `robots.txt` and a verification file have to be at a
 * fixed URL and a fixed URL can never be immutable. `app/assets/` is the opposite promise — nothing
 * in it is reachable at the path it was written at, every file is published once under a digest of
 * its own contents, and every one of them may be held for a year.
 *
 * A font is why it exists. A font is referenced from a stylesheet, and a stylesheet's `url()` was
 * a string nothing rewrote — so the one asset that most wants to be immutable was the one asset
 * that could not be, whichever directory it was put in. `rewriteUrls` is the other half of this.
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
    // Revved by a directory segment rather than by mangling the filename, so an author who wrote
    // `fonts/inter.woff2` still sees `inter.woff2` in the network panel and in a stack trace.
    const href = revved ? `${ASSET_ROOT}/${digestOf(body)}/${name}` : `${ASSET_ROOT}/${name}`
    files.set(href, { body, type: typeOf(file), immutable: revved })
    // Absolute, because that is what this map says it holds and what `rewriteUrls` looks up: it
    // resolves a stylesheet's relative `url()` against the sheet's own directory, which is always
    // absolute. A caller that passed a relative root — every embedder of `build()` except the CLI,
    // which resolves it at the door — filled this with relative keys, and every lookup missed. The
    // symptom was `E_NO_ASSET` naming a file that was sitting exactly where it said it was not.
    byPath.set(resolve(file), href)
    byName.set(name, href)
    manifest[name] = href
  }
  return { files, byPath, byName, manifest }
}

/**
 * Every `url()` in a stylesheet that names a file in `app/assets/`, pointed at its revved URL.
 *
 * Resolved against the directory the stylesheet is in, because that is what a relative URL in CSS
 * means and an author should not have to learn a second spelling. Everything that is not relative
 * is left exactly as written: an absolute path is the author naming a URL rather than a file, a
 * scheme belongs to somebody else, `data:` is already the bytes, and `#blur` is a reference into
 * the document being styled.
 *
 * A relative `url()` that resolves to nothing is refused rather than passed through. Passing it
 * through is a request for a path that does not exist, discovered by a reader whose page is missing
 * a font — and the build knew, at the moment it copied the sheet, that the file was not there.
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
   * One bundle per route: the framework's stylesheet, the application's, the layout's, and the
   * one belonging to every fragment that page renders — in that cascade order.
   *
   * One request rather than several, and content-addressed rather than named, so two pages whose
   * CSS is identical share a URL and therefore a cache entry. A page still links only the
   * stylesheets of the components on it, which is the property worth having; paying a request per
   * component to prove it is not.
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
  /**
   * `app/assets/`, already walked.
   *
   * Supplied rather than found when the caller needed it first: a stylesheet's `url()` is rewritten
   * against these before the sheets are concatenated, and walking the directory twice is two
   * answers to one question.
   */
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

  /**
   * `public/`, copied.
   *
   * One URL, the path the author wrote, and never immutable — that URL does not name its contents,
   * so a promise to hold it is a promise the next build cannot keep. It used to be published twice,
   * here and again under a digest, and the second URL was only reachable by asking the framework
   * for a path nobody had written. A file that wants a digest goes in `app/assets/`, which is the
   * whole of the difference between the two directories.
   */
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
 * The bare specifiers the front door rewrites, and the module tree each one resolves into.
 *
 * Exported, and the only statement of this anywhere. `measureClientJs` needs the same pair to walk
 * the graph a page downloads, and while it held its own copy the two could drift — which they did,
 * silently, when the scope moved from `@weft` to `@weftjs`. A stale copy here is an unresolvable
 * import in the browser; a stale copy there is a byte figure that stops following two thirds of the
 * runtime and reports a smaller number than the truth. In a repository whose claims are measurements
 * the second failure is the worse one, because nothing about it looks broken.
 */
export const REWRITTEN_SPECIFIERS: Record<string, string> = {
  '@weftjs/client': 'runtime',
  '@weftjs/warp': 'warp',
}

/**
 * A client module on its way to the browser: types stripped, and bare specifiers rewritten to
 * the paths those packages are mounted at. That is the whole of it. The alternative is a
 * bundler, and the alternative to a bundler is two replacements.
 *
 * Every rewritten specifier ends in `.js`, because every URL a module is served at does — see
 * `servedModuleName`. That used to be the importing tree's own extension, which was wrong in both
 * directions and produced 404s on the runtime from pages that otherwise looked fine.
 *
 * A relative specifier is rewritten too. A `.ts` source may import `./hint.ts`, and the browser
 * resolves that against the URL it is reading, so the specifier has to name the neighbour's URL
 * rather than the neighbour's filename.
 */
export function browserModule(
  source: string,
  tree: ModuleTree,
  mountedAt: string,
  options: { comments?: 'keep' | 'strip' } = {},
): string {
  /**
   * The prose comes out before the types do, and only outside `weft dev`.
   *
   * `stripTypeScriptTypes` keeps comments by design, which is right for a source map and wrong for
   * a payload: this framework explains itself at length in its own modules and every byte of that
   * was reaching browsers that cannot read it. Removing it is exact rather than approximate —
   * `stripComments` parses — and it happens first, on the original source, because that is the one
   * form the parser is guaranteed to accept.
   *
   * Kept in dev, where a reader who opens the module in devtools is the whole point of it being
   * legible in the first place.
   */
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
 * Every module a page will fetch, in the order the browser will discover them.
 *
 * There is no bundler, so a browser finds this graph by *following imports*: it cannot ask for
 * anything at depth three until the module at depth two has arrived and been parsed. That is a
 * serial chain of round trips rather than a set of parallel fetches, and it is the cost of having
 * no bundler — worth paying, and worth not paying twice.
 *
 * Walked here rather than declared because a declaration would drift. `import()` is deliberately
 * not followed: a dynamic import is the code a page decided *not* to need yet, and preloading it
 * would undo the reason it was written that way.
 *
 * One implementation, two callers. The byte budget measures exactly this set and the document
 * preloads exactly this set; when they were two walks the first drifted from what the second
 * served, which is the mistake this function exists to make impossible.
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
        /**
         * Normalised to the URL the browser will actually ask for.
         *
         * A `.ts` source imports `./infer.ts`, and `browserModule` rewrites that to `./infer.js`
         * before it leaves — so the graph has to carry the served name, not the source's. It read
         * the same file either way, which is why the byte figure was right and the preload list was
         * not: a `<link rel="modulepreload">` naming `.ts` preloads a URL nothing requests, and the
         * browser then downloads the module a second time under the name it actually imports.
         */
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
 * The graph as `<link rel="modulepreload">`, for the head of a document.
 *
 * This is the whole fix for the waterfall: the browser is told the entire set at once, in the head,
 * and fetches them in parallel instead of discovering them one hop at a time. It needs no 103 —
 * which is worth saying because 103 Early Hints does not survive every proxy, and this does not
 * depend on it.
 *
 * The boot module itself is left out: it is already a `<script src>` in the same head, and a
 * preload for something the parser is about to request anyway is a duplicate line for no gain.
 */
export function modulePreloads(graph: readonly string[], boot: string): string {
  return graph
    .filter((href) => href !== boot)
    .map((href) => `<link rel="modulepreload" href="${href}">`)
    .join('')
}

/**
 * Every module file the deployment can be asked for, at the URL it answers on.
 *
 * `files` holds what the build already had in memory — the stylesheets, the public directory —
 * and the module trees were never in it: they are mounted directories, read from the package's own
 * `dist` when a request arrives. That was invisible while a server answered every request, and
 * wrong the moment anything else did. A build output whose manifest lists `/_weft/m` URLs with no
 * files behind them is a site that can be handed to a CDN and will serve every page, every
 * stylesheet, and no JavaScript.
 *
 * The set is every direct child of every mounted tree with that tree's extension, which is exactly
 * what the server will answer and deliberately not the reachable import graph. A graph walk finds
 * what is imported statically and misses `import()`, so the first thing to 404 would be whatever
 * an application loads lazily — which is the code most likely to be lazy because it is big.
 *
 * `prelude` is prepended to the boot module for the same reason the server prepends it there.
 */
export async function moduleFiles(assets: AssetTable, prelude = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const [mountedAt, tree] of assets.trees) {
    for (const name of (await readdir(tree.dir)).sort()) {
      if (!name.endsWith(tree.ext)) continue
      const href = `${mountedAt}${servedModuleName(name, tree)}`
      // Written by `weft build`, which is production output by definition — there is no reader of
      // these files who is also reading the source.
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
 * What a route needs before it has been rendered, which is the whole of what 103 is for.
 *
 * The kernel asks this while the envelope is still open and the plan has not run: the browser
 * starts fetching the stylesheet and the runtime at effectively zero milliseconds, and the
 * response stays open for phase A to finish. Everything here is known at build time — a page
 * links one stylesheet and one module — so answering costs a map lookup rather than a render.
 *
 * Only what is *critical* goes in. A 103 listing every asset a page might use is a 103 that
 * delays the ones it needs, so the fonts and images a fragment happens to reference are not
 * here: they are discovered from the shell, which by then has already been flushed.
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
      // The application's own client module, when it has one: it is imported by the runtime
      // after adoption, so without a hint it is discovered one round trip later than it could be.
      if (assets.app) links.push({ href: assets.app, as: 'script', rel: 'modulepreload' })
      return links
    },
    chunksFor(route) {
      const assets = table()
      return [assets.pageCss(route), assets.boot, ...(assets.app ? [assets.app] : [])]
    },
  }
}
