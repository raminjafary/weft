import { access } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHandler, type Handler } from '@weftjs/core/server'

/**
 * The documentation site, as a Vercel function. `weft start` with the listening taken out:
 * `startHandler` loads the build `weft build` wrote and returns the same handler the CLI would put
 * on a port — no compiler runs here, only sealed templates. Booting is a module-level promise so a
 * reused instance pays the cost once; a cold start costs about a quarter second for this app.
 *
 * Answers only what the CDN can't — `/play`, `/search`, the `/_weft/i/` intents, and a 404 — since
 * every prerendered document and revved asset is served from the edge as a file.
 *
 * Named `serve`, not `index` or `_serve`: `/api` and `/api/adapters`..`/api/weft-server` are pages
 * this site's own build writes, and a function at `/api` would lose to that static file with no
 * error anywhere, silently taking `/play`, `/search` and every intent down with it. `_serve` would
 * have Vercel skip the file entirely (it ignores underscore-prefixed names under `api/`).
 */

/** Where the application is, checked rather than assumed: a bundler decides where this file ends up, so both plausible bases are tried. */
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
