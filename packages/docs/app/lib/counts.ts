import { errorCodes } from './errors.ts'
import { PAGES } from './pages.ts'
import { STEPS } from './tutorial.ts'
import { surface } from './surface.ts'

/**
 * What this site amounts to, counted off the registries it serves from.
 *
 * It lives here rather than in `pages.ts` because it needs four of them, and `pages.ts` is imported
 * by almost everything: pulling the tutorial, the API surface and the error scan into it made a
 * cycle that only showed up as `groupOf is not defined` at import time, which is a long way from
 * the change that caused it. The registry stays a leaf; the arithmetic over registries lives here.
 */

/**
 * How many of this site's routes `weft build` writes out as files.
 *
 * Counted rather than read out of `.weft/static/` — that directory is a build artifact, so a page
 * quoting it would say nothing during `weft dev` and something stale after a route was removed.
 * Every param route contributes its declared set; the two routes that declare `static: false` are
 * the whole of the subtraction, and they say why on the page.
 */
export function staticPages(): number {
  // `/`, `/quick-start`, `/guide`, `/tutorial`, `/examples`, `/api`, `/glossary`, `/errors`.
  const fixed = 8
  return fixed + PAGES.length + STEPS.length + surface().length + errorCodes().length
}
