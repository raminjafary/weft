/** What instant navigation costs on top of a channel route. See `spec/kernel/budgets.md`. */
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
