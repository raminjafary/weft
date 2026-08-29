/**
 * A route staged over the channel, and nothing else — `WARM at=`. Its own entry: written into the
 * channel it took the transport 108 bytes past its watermark. See `spec/kernel/budgets.md`.
 */
export * from './entry-transport.ts'
export { createStager } from './stage.ts'
export type { StagedRoute, StageRequest, StageOptions, RouteStager } from './stage.ts'
