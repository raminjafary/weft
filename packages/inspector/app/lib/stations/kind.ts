import type { RenderContext } from '@weftjs/core'
import type { PageParts } from '../pages.ts'

/**
 * A station handler.
 *
 * It receives the render context, because a control on a server-rendered page is a query parameter
 * and the framework's way to read one is `ctx.query()`. Reading it there rather than parsing a URL
 * in the server is the point: the read taints `route:<key>`, so a station's own controls land in
 * its own cache key exactly the way an application's would.
 *
 * It is called once per request, from inside the page's body slot — so a handler that measures
 * something expensive measures it once.
 */
export type StationHandler = (ctx: RenderContext) => Promise<PageParts>

/** What a handler reads its controls through. Narrowed so a station cannot reach for anything else. */
export interface Controls {
  query(key: string): string | undefined
}

export function control(ctx: Controls, key: string, fallback: string): string {
  return ctx.query(key) ?? fallback
}

export function numeric(ctx: Controls, key: string, fallback: number, min: number, max: number): number {
  const raw = Number(ctx.query(key) ?? fallback)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}
