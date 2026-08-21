/**
 * The channel: a live Warp frame stream to one client, and the state that makes the frames
 * in `entry-channel.ts` reachable from outside a test — negotiation, what the client holds,
 * staged epochs, and push invalidation going the other way.
 *
 * Its own entry because it is its own capability with its own cost, and because the
 * alternative is charging it to a figure that was set before it existed. The bindings that
 * move the bytes are in `@weft/adapters`; nothing here knows whether it is talking to a
 * streamed response, an SSE stream or a socket.
 */
export * from './entry-channel.ts'
export { createHub, serverCapabilities, ackFrame, ChannelError, errorFrame } from './channel.ts'
