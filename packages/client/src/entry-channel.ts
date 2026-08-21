/**
 * What a route on a live channel needs on top of an app route: somewhere for arriving frames
 * to land. Its own entry because a page that only reads should not carry frame routing, and
 * because a capability with no ceiling of its own ends up charged to someone else's.
 */
export * from './entry-app.ts'
export { createChannelClient } from './channel.ts'
export type { Region, ChannelFrame, Applied } from './channel.ts'
