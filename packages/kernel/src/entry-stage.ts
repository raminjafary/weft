/**
 * A route staged over the channel, and nothing else.
 *
 * The design's frame table says `WARM` means "stage data for a route, do not paint", and this is
 * the half of it that is about a route rather than a template. Its own entry for the reason the
 * transport got one: written into the channel it took a watermark set before it existed 108 bytes
 * past that watermark, and a new capability argues with its own number rather than spending
 * somebody else's headroom.
 *
 * A deployment that never stages a route never imports this, and its channel is the size it was.
 */
export * from './entry-transport.ts'
export { createStager } from './stage.ts'
export type { StagedRoute, StageRequest, StageOptions, RouteStager } from './stage.ts'
