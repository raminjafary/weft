/**
 * A page assembled out of regions that live somewhere else, on top of the document request path.
 *
 * The design's phase 9, and its claim is that this needs no new runtime: a region resolves through
 * the registry port, runs on the executor the registry named, and comes back as the frames every
 * other render already produces. What this entry actually adds is the check — a region may write
 * into its own hole and nowhere else — and the resolution that makes rolling a region a registry
 * write rather than a shell redeploy.
 *
 * Its own entry on the rule route staging established. A deployment that composes nothing never
 * imports it and its request path is the size it was; a gateway that composes five regions pays
 * for it once and can be measured against a number of its own.
 */
export * from './entry-request.ts'
export { createComposer, readRegion, announceRegion, regionStream, RegionError } from './region.ts'
export type {
  Composer,
  ComposeOptions,
  RegionAnnouncement,
  RegionFrames,
  RegionOutcome,
  RegionRequest,
  RegionSpec,
} from './region.ts'
