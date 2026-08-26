/**
 * The document request path, plus a document made of nested layouts.
 *
 * Its own entry for the reason every other one here has its own: a deployment whose layouts are
 * flat should not import the splice that assembles a chain. `entry-request.ts` is the entry the
 * design's "under 8 KB server-side" claim is about and it had 74 bytes of headroom; a chain walk
 * written into `splitAtSlots` cost 83. So the capability became a seam — the third time the byte
 * budget has done that, and the third time the seam was the better architecture.
 */
export * from './entry-request.ts'
export { chainSplitter, type ShellLink } from './split-chain.ts'
