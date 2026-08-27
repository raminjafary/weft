import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { typeOf } from './assets.ts'
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
      })
    }
  } catch {
    // A build with no L0 documents has no manifest, which is not an error.
  }

  const root = join(dir, 'assets')
  for (const file of await walk(root)) {
    const path = relative(root, file).split(sep).join('/')
    // The manifests describe the set; they are not in it. Publishing the static one would put a
    // listing of every page at a URL nobody asked for.
    if (path === 'manifest.json') continue
    const href = `/${path}`
    if (claimed.has(href)) continue
    out.push({
      href,
      file,
      path,
      headers: {
        'content-type': typeOf(href),
        // Every asset URL carries a digest of its contents, which is the whole reason it may be
        // held for a year. A path without one never reaches here: the build only writes revved
        // assets.
        'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
      },
      immutable: true,
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
}

/**
 * The build, laid out as a directory a static host can serve.
 *
 * The counterpart to `weft upload` for every host that takes a folder rather than a key space —
 * a CDN's origin, an object store synced from disk, a platform's build output. What comes out
 * needs no rules applied to it: the documents are at the paths they answer and every URL they
 * reference resolves beside them.
 */
export async function writeSite(dir: string, out: string): Promise<SiteReport> {
  const objects = await siteObjects(dir)
  let bytes = 0
  for (const object of objects) {
    const target = join(out, object.path)
    await mkdir(dirname(target), { recursive: true })
    await cp(object.file, target)
    bytes += (await stat(object.file)).size
  }
  return {
    out,
    documents: objects.filter((object) => !object.immutable).length,
    assets: objects.filter((object) => object.immutable).length,
    bytes,
  }
}
