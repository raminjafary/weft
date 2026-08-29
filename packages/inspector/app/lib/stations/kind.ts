import type { RenderContext } from '@weftjs/core'
import type { PageParts } from '../pages.ts'

/** A station handler. Receives the render context — a control is a query param read via `ctx.query()`, tainting `route:<key>`. Called once per request. */
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
