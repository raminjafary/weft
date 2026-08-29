/**
 * A page assembled out of regions that live somewhere else, on top of the document request path.
 * Needs no new runtime — a region resolves through the registry and runs on the executor it named.
 * See `spec/kernel/composition.md` and `spec/kernel/budgets.md`.
 */
export * from './entry-request.ts'
export { createComposer, readRegion, readsFor, announceRegion, regionStream, RegionError } from './region.ts'
export type {
  Composer,
  ComposeOptions,
  RegionAnnouncement,
  RegionFrames,
  RegionOutcome,
  RegionRequest,
  RegionSpec,
} from './region.ts'
