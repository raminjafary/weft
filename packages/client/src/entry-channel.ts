/** What a route on a live channel needs on top of an app route: somewhere for arriving frames to land. See `spec/kernel/budgets.md`. */
export * from './entry-app.ts'
export { createChannelClient } from './channel.ts'
export type { Region, ChannelFrame, Applied } from './channel.ts'
