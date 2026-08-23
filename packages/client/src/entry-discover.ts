/**
 * Navigation plus what the client knows about routes it has not been to.
 *
 * Its own entry, on the rule every other entry here follows: a page that never asks about a subtree
 * should not carry the registry, and the thing this buys is a *saved* request rather than a feature
 * — so it had better cost less than the request it saves.
 */
export * from './entry-nav.ts'
export { createKnown, discoverFrame, planFrames, rankOf } from './discover.ts'
export type { Known, KnownRoute, PlanArrival } from './discover.ts'
