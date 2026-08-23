/**
 * Lazy plan extension, over a live channel.
 *
 * `PLAN` was a declared frame code with nothing behind it: the whole route table was resolved at
 * construction and a client learned about a route by asking the server to render it. This is the
 * other half — the part of the plan a client does not have, asked for by prefix or handed over
 * unprompted when a channel opens.
 *
 * Its own entry for the reason route staging got one: a deployment that never extends a plan should
 * not carry the frame that would have, and a new capability argues with a number of its own rather
 * than spending the transport's headroom.
 */
export * from './entry-stage.ts'
export { createExtender, planFrame, DISCOVER_MAX } from './discover.ts'
