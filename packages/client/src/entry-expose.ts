/**
 * A shell signal reaching a region's client code, and nothing else.
 *
 * Its own entry on the rule the channel and navigation established: a page that composes no region
 * should not carry the table, and the channel entry it would otherwise land in has fifteen bytes of
 * headroom. The routing goes through `onFrame`, which already exists, so a page that never sees a
 * `SIGNAL` pays nothing for the possibility.
 */
export * from './entry-channel.ts'
export { createExposure, exposedFrames } from './exposed.ts'
export type { Exposure } from './exposed.ts'
