import { access } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHandler, type Handler } from '@weft/core/server'

/**
 * The documentation site, as a Vercel function.
 *
 * Vercel owns the socket, so this is `weft start` with the listening taken out: `startHandler`
 * loads the build that `weft build` wrote and returns the same request handler the CLI would have
 * put on a port. No compiler runs here — the templates are the sealed ones from the build, which
 * is the whole reason `weft start` is a separate command from `weft dev`.
 *
 * The boot is a module-level promise rather than per-request work. Reading the sealed templates and
 * the prerendered documents has a fixed answer, so an instance that is reused pays for it once and
 * every request after that is served from memory. A cold start pays it again, which is the honest
 * cost of a platform that scales to zero — it is about a quarter of a second for this application.
 *
 * It answers what the CDN cannot: `/play` and `/search`, whose bodies are functions of a query the
 * build cannot invent, the intent endpoints under `/_weft/i/`, and a 404 for anything else. Every
 * prerendered document and every revved asset is served from the edge as a file — `weft site`
 * writes them — so the common path does not reach a function at all.
 *
 * `serve` rather than `index`, because Vercel puts functions under `/api` and `/api` is a page on
 * this site: `/api`, and `/api/adapters` through `/api/weft-server`, are documents the build wrote.
 * A function at `/api` and a document at `/api` are two answers to one URL, and the static file
 * wins — which would take `/play`, `/search` and every intent down without an error anywhere.
 *
 * Not `_serve` either: Vercel skips anything under `api/` whose name begins with an underscore, so
 * that spelling is a deployment with no function at all. `/api/:module` is one segment and its
 * values are this repository's package names, so `serve` is a path no page can take.
 */

/**
 * Where the application is, checked rather than assumed.
 *
 * A bundler decides where this file ends up and the answer is not ours to make, so both plausible
 * bases are tried and the one holding a build wins. Failing by name beats booting against a
 * directory with no templates in it, where the first symptom is a 500 on every route.
 */
async function docsRoot(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('../packages/docs/', import.meta.url)),
    join(process.cwd(), 'packages/docs'),
  ]
  for (const dir of candidates) {
    try {
      await access(join(dir, '.weft', 'ir', 'manifest.json'))
      return dir
    } catch {
      continue
    }
  }
  throw new Error(
    `E_NO_BUILD: no .weft/ir/manifest.json under ${candidates.join(' or ')}. The function bundle is ` +
      `missing the build — check \`includeFiles\` in vercel.json, and that \`pnpm docs:build\` ran.`,
  )
}

let booting: Promise<Handler> | undefined

export const config = { supportsResponseStreaming: true }

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  booting ??= docsRoot().then((root) => startHandler(root))
  ;(await booting).handle(req, res)
}
