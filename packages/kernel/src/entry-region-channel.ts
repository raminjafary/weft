/**
 * A region on another deployment, refreshed over a live channel — transport plus composition, the
 * one combination neither of their own entries covers. See `spec/kernel/budgets.md`.
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
