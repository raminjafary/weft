/**
 * Surgical updates on top of the request path: a client naming the base render it holds, a
 * form chosen for it, a delta memoized by its transition, epochs staged and committed, and
 * the registry that turns an invalidation into a list of connections to tell.
 *
 * None of it needs a long-lived connection. A client can POST what it holds and get a delta
 * back in the response, which is a real deployment and the one every phase 6 test used before
 * a channel existed — so this stays a separate entry from `entry-transport.ts`, and a
 * deployment serving documents only carries neither.
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
