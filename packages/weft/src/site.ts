import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { cacheControl, typeOf } from './assets.ts'
import { STATIC_DIR, type StaticManifest } from './static.ts'

/**
 * What a deployment is, to anything that is not a weft server.
 *
 * The build writes documents under `static/` and revved files under `assets/`, and neither
 * directory is the site: one holds the pages and the other holds everything they link, and the
 * two manifests beside them describe the set rather than belong to it. Working that out is not
 * something every application should have to do again, and getting it wrong is quiet — a missing
 * overlay is a site that serves without its stylesheets, and an uploaded `manifest.json` is a
 * listing of every page published at a URL nobody meant to publish.
 *
 * So it is written down once, here, and it has two destinations that must not disagree:
 * `weft upload` sends it to an object store, `weft site` writes it to a directory. Both ask this.
 */
export interface SiteObject {
  /** The URL it answers. */
  href: string
  /** Where it is in the build. */
  file: string
  /**
   * Where it goes under a site root, for a host that serves a directory rather than a key space.
   *
   * Not derived from `href`: a document answers `/guide` and lives at `guide/index.html`, and the
   * mapping between the two is the build's rather than a rule about trailing slashes. The static
   * manifest already recorded it, so this is read rather than guessed.
   */
  path: string
  /** What it must be served with. For a document, exactly what the build proved it may carry. */
  headers: Record<string, string>
  /** A document is not: it answers a URL a reader typed, and the next build may answer it differently. */
  immutable: boolean
  /**
   * A page this build resolved, as opposed to a file it copied.
   *
   * Stated rather than inferred from `immutable`, because a file in `public/` is mutable too — a
   * favicon is served at the name its author wrote. Inferring it counted `robots.txt` and
   * `logo.svg` as documents in the report, and, worse, listed them in the sitemap, which the
   * sitemap's own rule says is for pages only.
   */
  document: boolean
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else out.push(path)
  }
  return out
}

/** Every object a build publishes, by the URL it answers. */
export async function siteObjects(dir: string): Promise<SiteObject[]> {
  const out: SiteObject[] = []
  const claimed = new Set<string>()

  /**
   * The documents, read from the manifest rather than re-derived.
   *
   * The build already decided which document answers which path and what headers it may carry;
   * deriving that a second time is how a file and an origin come to disagree about a
   * `Cache-Control` that one of them proved and the other assumed.
   */
  try {
    const manifest = JSON.parse(
      await readFile(join(dir, STATIC_DIR, 'manifest.json'), 'utf8'),
    ) as StaticManifest
    for (const document of manifest.documents) {
      claimed.add(document.path)
      out.push({
        href: document.path,
        file: join(dir, STATIC_DIR, document.file),
        path: document.file,
        headers: document.headers,
        immutable: false,
        document: true,
      })
    }
  } catch {
    // A build with no L0 documents has no manifest, which is not an error.
  }

  /**
   * Which asset URLs name their own contents, asked of the build rather than assumed.
   *
   * Not every one does. A file in `public/` is served at the name its author wrote as well as at a
   * revved one — a favicon is linked as `/mark.svg`, because that is what a page says — and the
   * build records the difference. Reading it back is the only way a directory walk can know: the
   * alternative was to assume a digest and serve a stable URL immutable for a year, which for the
   * one asset on this site that has no digest meant the old icon until the browser cache was
   * cleared. Unknown counts as mutable, because being asked again is a cost and being wrong is not.
   */
  const revved = new Map<string, boolean>()
  try {
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
      assets?: { href: string; immutable: boolean }[]
    }
    for (const asset of report.assets ?? []) revved.set(asset.href, asset.immutable)
  } catch {
    // No report is a build nobody can ask, and every asset is then revalidated.
  }

  const root = join(dir, 'assets')
  for (const file of await walk(root)) {
    const path = relative(root, file).split(sep).join('/')
    // The manifests describe the set; they are not in it. Publishing the static one would put a
    // listing of every page at a URL nobody asked for.
    if (path === 'manifest.json') continue
    const href = `/${path}`
    if (claimed.has(href)) continue
    const immutable = revved.get(href) ?? false
    out.push({
      href,
      file,
      path,
      headers: { 'content-type': typeOf(href), 'cache-control': cacheControl(immutable) },
      immutable,
      document: false,
    })
  }

  return out
}

/** What `weft site` wrote: where it went, and how much of it there is. */
export interface SiteReport {
  out: string
  documents: number
  assets: number
  bytes: number
  /** Whether a sitemap was written, and how many URLs it names. Absent when no origin was given. */
  sitemap?: { urls: number }
}

/**
 * Every document this build answers, as a sitemap.
 *
 * The route table is the framework's, and so is the set of URLs a build actually wrote — which is
 * why a hand-maintained sitemap in `public/` is a list that is wrong the first time somebody adds
 * a page. This is generated from the objects that were published, so it cannot name a URL that does
 * not exist or miss one that does.
 *
 * Documents only. An asset is not a page and listing revved bundles would be telling a crawler to
 * index the contents of a cache.
 *
 * It needs an origin because a sitemap's entries are absolute by specification, and an origin is
 * the one thing a build genuinely cannot know: the same output is served from a preview URL, a
 * staging host and a domain. So it is `site.origin` in the config, and without it no sitemap is
 * written rather than one full of guesses.
 */
export function sitemapFor(objects: readonly SiteObject[], origin: string): string {
  const base = origin.replace(/\/+$/, '')
  const urls = objects
    .filter((object) => object.document)
    .map((object) => `${base}${object.href}`)
    .sort()
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((url) => `  <url><loc>${url.replace(/&/g, '&amp;')}</loc></url>\n`).join('') +
    `</urlset>\n`
  )
}

/**
 * The build, laid out as a directory a static host can serve.
 *
 * The counterpart to `weft upload` for every host that takes a folder rather than a key space —
 * a CDN's origin, an object store synced from disk, a platform's build output. What comes out
 * needs no rules applied to it: the documents are at the paths they answer and every URL they
 * reference resolves beside them.
 */
export async function writeSite(
  dir: string,
  out: string,
  options: { origin?: string } = {},
): Promise<SiteReport> {
  const objects = await siteObjects(dir)
  // Emptied first, and the directory is the one the caller named. A page deleted from an
  // application is a file left behind here otherwise — still reachable, still linked from
  // whatever cached copy of a nav mentions it, and correct in every build report.
  await rm(out, { recursive: true, force: true })
  let bytes = 0
  for (const object of objects) {
    const target = join(out, object.path)
    await mkdir(dirname(target), { recursive: true })
    await cp(object.file, target)
    bytes += (await stat(object.file)).size
  }
  let sitemap: { urls: number } | undefined
  if (options.origin) {
    const xml = sitemapFor(objects, options.origin)
    await writeFile(join(out, 'sitemap.xml'), xml, 'utf8')
    bytes += Buffer.byteLength(xml)
    sitemap = { urls: objects.filter((object) => object.document).length }
  }

  return {
    out,
    documents: objects.filter((object) => object.document).length,
    assets: objects.filter((object) => !object.document).length,
    bytes,
    ...(sitemap ? { sitemap } : {}),
  }
}
