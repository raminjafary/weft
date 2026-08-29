/** Navigation plus what the client knows about routes it has not been to. See `spec/kernel/budgets.md`. */
export * from './entry-nav.ts'
export { createKnown, discoverFrame, planFrames, rankOf } from './discover.ts'
export type { Known, KnownRoute, PlanArrival } from './discover.ts'
