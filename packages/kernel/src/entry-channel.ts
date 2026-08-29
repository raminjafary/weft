/**
 * Surgical updates on top of the request path — none of it needs a long-lived connection, so this
 * stays separate from `entry-transport.ts`. See `spec/kernel/budgets.md`.
 */
export * from './entry-request.ts'
export {
  surgicalRefresh,
  selectForm,
  parseHeld,
  heldFrame,
  recordBase,
  recoverBase,
  createStaleRegistry,
} from './refresh.ts'
export { createEpochs } from './epoch.ts'
