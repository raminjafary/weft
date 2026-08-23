/**
 * What instant navigation costs on top of a channel route: routes staged and unpainted, and the
 * two decisions about a click the framework is not entitled to take on its own.
 *
 * Its own entry for the reason every other entry here has one. A page that never links anywhere
 * should not carry the staging model, and a capability with no ceiling of its own is one whose
 * growth is charged to somebody else's headroom.
 */
export * from './entry-channel.ts'
export {
  createStaging,
  navFrames,
  navigable,
  plainClick,
  stagingKey,
  warmFrame,
  DEFAULT_STAGING,
} from './navigate.ts'
export type {
  Staging,
  StagingOptions,
  StageState,
  Claimed,
  LinkFacts,
  ClickFacts,
  StagedNav,
} from './navigate.ts'
