/**
 * A region on another deployment, refreshed over a live channel.
 *
 * The transport plus composition, which is the one combination neither of their entries covers: a
 * deployment can serve composed documents with no channel at all, and can serve a channel with no
 * region in sight. This entry is what a gateway that does both actually imports, and it is measured
 * as such rather than having its cost charged to whichever of the two happened to be written first.
 */
export * from './entry-transport.ts'
export {
  createComposer,
  readRegion,
  readsFor,
  announceRegion,
  regionStream,
  regionEffects,
  RegionError,
} from './region.ts'
export { channelRegions } from './region-channel.ts'
export type { ChannelRegions, ChannelRegionOptions } from './region-channel.ts'
export type {
  Composer,
  ComposeOptions,
  RegionAnnouncement,
  RegionFrames,
  RegionOutcome,
  RegionRequest,
  RegionSpec,
} from './region.ts'
