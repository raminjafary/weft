import type { Lifecycle } from './request.ts'
import type { PreloadLink, TransportPort } from './ports.ts'

/**
 * 103 Early Hints, and the reason the whole envelope design hangs off it.
 *
 * The pressure to flush early is almost entirely about subresource discovery. HTTP already
 * separates that from committing the envelope and almost nobody uses it: send 103 with the
 * shell's CSS, fonts and critical chunks at effectively zero milliseconds, the browser
 * starts fetching, and the envelope stays open for phase A to finish.
 *
 * The caveat is real and is not smoothed over: 103 is H2/H3 only, so an HTTP/1.1 client
 * simply waits for the final response, and Firefox has an implementation that is off by
 * default. `sendEarlyHints` reports whether the hints actually went out rather than
 * returning void, so a caller can tell the difference between sent and silently skipped.
 */
export function linkValue(link: PreloadLink): string {
  const parts = [`<${link.href}>`, `rel=${link.rel}`]
  if (link.rel === 'preload') parts.push(`as=${link.as}`)
  if (link.crossOrigin) parts.push('crossorigin')
  return parts.join('; ')
}

/**
 * One `Link` header value. Note that a transport may need the values *separately* rather than
 * joined — Node's `writeEarlyHints` rejects a comma-joined string and wants an array — so the
 * per-link form is exported too rather than being an internal detail of this function.
 */
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
