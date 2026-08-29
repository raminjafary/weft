/**
 * The document request path, and nothing else — the entry the design's "under 8 KB server-side"
 * claim is about. See `spec/kernel/budgets.md`.
 */
export { createKernel } from './kernel.ts'
// A kernel whose `serve` has nothing to match is not a kernel, so the matcher is measured too.
export { createRouter } from './router.ts'
export { splitAtSlots, anchorFor, type Splitter } from './split.ts'
export { streamRoute } from './stream.ts'
export { FILLER, fillerBytes } from './filler.ts'
export { requestFacts } from './ports.ts'
