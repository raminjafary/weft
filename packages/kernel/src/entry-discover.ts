/**
 * Lazy plan extension, over a live channel — the part of the plan a client does not have yet.
 * Its own entry: a deployment that never extends a plan should not carry it. See `spec/kernel/budgets.md`.
 */
export * from './entry-stage.ts'
export { createExtender, planFrame, DISCOVER_MAX } from './discover.ts'
