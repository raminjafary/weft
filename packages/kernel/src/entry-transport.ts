/**
 * The channel: a live Warp frame stream to one client — negotiation, what it holds, staged epochs,
 * push invalidation. Its own entry, own cost. See `spec/kernel/budgets.md`.
 */
export * from './entry-channel.ts'
export { createHub, serverCapabilities, ackFrame, ChannelError, errorFrame } from './channel.ts'
