import type { Lifecycle } from './request.ts'
import type { PreloadLink, TransportPort } from './ports.ts'

/**
 * 103 Early Hints, and the reason the whole envelope design hangs off it: send it with the
 * shell's critical links at effectively zero milliseconds, and the envelope stays open for phase
 * A to finish. H2/H3 only. See `spec/kernel/lifecycle.md`.
 */
export function linkValue(link: PreloadLink): string {
  const parts = [`<${link.href}>`, `rel=${link.rel}`]
  if (link.rel === 'preload') parts.push(`as=${link.as}`)
  if (link.crossOrigin) parts.push('crossorigin')
  return parts.join('; ')
}

/** One `Link` header value. The per-link form is exported too: Node's `writeEarlyHints` wants an array, not a joined string. */
export function linkHeader(links: readonly PreloadLink[]): string {
  return links.map(linkValue).join(', ')
}

/** Whether a 103 went out, and what it pointed at. */
export interface HintResult {
  sent: boolean
  links: readonly PreloadLink[]
  reason?: string
}

/** Send a 103 for a route's critical links, before the envelope settles. */
export async function sendEarlyHints(
  life: Lifecycle,
  transport: TransportPort | undefined,
  links: readonly PreloadLink[],
): Promise<HintResult> {
  life.mustBe(['received', 'envelope'], 'early hints', 'E_HINTS_AFTER_COMMIT')
  if (!links.length) return { sent: false, links, reason: 'nothing critical to hint' }
  if (!transport?.earlyHints) {
    return {
      sent: false,
      links,
      reason: 'transport does not implement 103, so the hints ride on the final response',
    }
  }
  const sent = await transport.earlyHints([...links])
  return {
    sent,
    links,
    ...(sent ? {} : { reason: 'transport declined: HTTP/1.1, or a client that does not accept 103' }),
  }
}
