import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { STATIC_DIR, type StaticManifest } from './static.ts'
import { typeOf } from './assets.ts'

/**
 * The build directory, uploaded — over HTTP and nothing else.
 *
 * The spec said "the directory is uploadable; the framework does not upload it", and the reason it
 * stayed that way is that uploading normally means choosing a provider. So this does not: every
 * object store worth using accepts an authenticated `PUT` at a URL, and the authentication is a
 * header the deployment already knows how to produce. `--to` is where, `--header` is who, and there
 * is no SDK, no credential chain and no provider-shaped configuration anywhere in it.
 *
 * What that buys is not only smallness. A framework that took a dependency on one provider's client
 * would have to take one on the next, and the thing being uploaded is a directory of files with
 * paths and headers — which is exactly what HTTP is for.
 *
 * Three properties this has to have, and each one is a decision rather than a detail:
 *
 * **Immutable objects are skipped, not re-sent.** Every asset URL carries a digest of its contents,
 * so a URL that already exists already has the right bytes. A HEAD per object is cheaper than a PUT
 * per object by roughly the size of the object.
 *
 * **Documents are never skipped.** An L0 path is a stable URL whose contents change with every
 * build, which is the exact inverse, so those are always written.
 *
 * **A failure is reported per object and does not stop the upload.** A half-uploaded deployment is
 * bad; a half-uploaded deployment nobody can enumerate is worse.
 */
export interface UploadOptions {
  /** The build directory: `<root>/<outDir>`. */
  dir: string
  /** Base URL every object is PUT under. Trailing slashes are irrelevant. */
  to: string
  /** Headers on every request, which is where authentication goes. */
  headers?: Record<string, string>
  concurrency?: number
  /** Say what would happen and send nothing. */
  dryRun?: boolean
  /** Injected so a test can be a real end-to-end test rather than a mock of one. */
  fetch?: typeof globalThis.fetch
}

export interface UploadedObject {
  /** The URL path, which for an asset is the path it is served from. */
  href: string
  bytes: number
  status: 'uploaded' | 'skipped' | 'failed'
  /** Why it was skipped, or how it failed. */
  detail?: string
}

export interface UploadReport {
  to: string
  objects: UploadedObject[]
  uploaded: number
  skipped: number
  failed: number
  /** Bytes actually sent, which is the number a deployment is charged for. */
  sent: number
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

/** What an object is served with. An asset's headers are its path's; a document's are the build's. */
function headersFor(href: string, documents: Map<string, Record<string, string>>): Record<string, string> {
  const held = documents.get(href)
  if (held) return held
  return {
    'content-type': typeOf(href),
    // Every asset URL carries a digest of its contents, which is the whole reason it may be held
    // for a year. A path without one never reaches here: the build only writes revved assets.
    'cache-control': 'public, max-age=31536000, immutable',
  }
}

export async function uploadBuild(options: UploadOptions): Promise<UploadReport> {
  const send = options.fetch ?? globalThis.fetch
  const base = options.to.replace(/\/+$/, '')
  const objects: UploadedObject[] = []

  /**
   * L0 documents, by the URL each one answers, with the headers the build proved they may carry.
   *
   * Read from the manifest rather than re-derived: the build already decided that a document proved
   * invariant may be held, and deriving it twice is how the file and the origin come to disagree
   * about a `Cache-Control`.
   */
  const documents = new Map<string, Record<string, string>>()
  const files = new Map<string, string>()
  try {
    const manifest = JSON.parse(
      await readFile(join(options.dir, STATIC_DIR, 'manifest.json'), 'utf8'),
    ) as StaticManifest
    for (const document of manifest.documents) {
      documents.set(document.path, document.headers)
      files.set(document.path, join(options.dir, STATIC_DIR, document.file))
    }
  } catch {
    // A build with no L0 documents has no manifest, which is not an error.
  }

  const assets = await walk(join(options.dir, 'assets'))
  for (const path of assets) {
    const href = `/${relative(join(options.dir, 'assets'), path).split(sep).join('/')}`
    // The asset manifest describes the others; it is not itself served.
    if (href === '/manifest.json') continue
    files.set(href, path)
  }

  const queue = [...files.entries()]
  const limit = Math.max(1, options.concurrency ?? 8)

  const one = async ([href, path]: [string, string]): Promise<void> => {
    const bytes = (await stat(path)).size
    const target = `${base}${href}`
    const headers = headersFor(href, documents)
    const immutable = !documents.has(href)

    if (options.dryRun) {
      objects.push({ href, bytes, status: 'skipped', detail: 'dry run' })
      return
    }
    if (immutable) {
      try {
        const head = await send(target, { method: 'HEAD' })
        if (head.ok) {
          objects.push({
            href,
            bytes,
            status: 'skipped',
            detail: 'already there, and its URL names its contents',
          })
          return
        }
      } catch {
        // A HEAD that cannot be made is not a reason not to PUT.
      }
    }
    try {
      const response = await send(target, {
        method: 'PUT',
        headers: { ...headers, ...options.headers },
        body: await readFile(path),
      })
      if (!response.ok) {
        objects.push({ href, bytes, status: 'failed', detail: `PUT answered ${response.status}` })
        return
      }
      objects.push({ href, bytes, status: 'uploaded' })
    } catch (error) {
      objects.push({ href, bytes, status: 'failed', detail: (error as Error).message })
    }
  }

  // Bounded rather than all at once: a thousand parallel PUTs is a way to be rate-limited by
  // every provider at once.
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift()
      if (!next) return
      await one(next)
    }
  })
  await Promise.all(workers)

  objects.sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0))
  return {
    to: base,
    objects,
    uploaded: objects.filter((o) => o.status === 'uploaded').length,
    skipped: objects.filter((o) => o.status === 'skipped').length,
    failed: objects.filter((o) => o.status === 'failed').length,
    sent: objects.filter((o) => o.status === 'uploaded').reduce((sum, o) => sum + o.bytes, 0),
  }
}
