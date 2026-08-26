/**
 * An entity tag, and the one property it has to have.
 *
 * A strong `ETag` is a promise that two responses carrying the same tag are the same bytes, and a
 * client acts on that promise by not asking for the body again. So a collision is not a slow page,
 * it is the wrong page — which rules out the cheap hash the base-render id uses, where a collision
 * costs a wire form and nothing else. SHA-256 truncated to 128 bits, the same digest a template
 * version is.
 */
export async function entityTag(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  const out = new Uint8Array(digest).subarray(0, 16)
  let hex = ''
  for (const byte of out) hex += byte.toString(16).padStart(2, '0')
  return `"${hex}"`
}

/**
 * Whether a conditional request is asking about the tag this response carries.
 *
 * `If-None-Match: *` means "if you have any representation at all", which for a response that
 * exists is a match. A list is matched member by member, because a client holding three variants
 * sends three tags, and a weak comparison prefix is stripped rather than refused — this side only
 * ever emits strong tags, so a `W/` arriving means an intermediary weakened it in transit and the
 * comparison it is asking for is still the one that can be answered.
 */
export function matchesTag(header: string | undefined, tag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(tag)
}
