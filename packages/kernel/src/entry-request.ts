/**
 * The document request path, and nothing else: own the lifecycle, resolve the plan,
 * execute it against ports, own the stream. This is the entry the design's "under 8 KB
 * server-side" claim is about, so it is the one with a ceiling on it.
 *
 * The Warp channel path — surgical refresh, staged epochs, form negotiation — is a second
 * entry, because a deployment serving documents and nothing else should not pay for it.
 */
export { createKernel } from './kernel.ts'
export { splitAtSlots, anchorFor } from './split.ts'
export { streamRoute } from './stream.ts'
export { FILLER, fillerBytes } from './filler.ts'
export { requestFacts } from './ports.ts'
