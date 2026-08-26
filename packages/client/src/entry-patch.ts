/**
 * A channel route plus the rung of the surgical ladder that needs no template.
 *
 * Its own entry on the rule the channel, navigation and the exposed table established: a page
 * whose regions are all projectable never receives a `PATCH`, and should not carry the applier.
 * The routing goes through `onFrame`, which already exists, so the possibility costs nothing.
 */
export * from './entry-channel.ts'
export { applyPatch, patchFrames, patchApplies } from './patch.ts'
export type { PatchPayload, PatchWrite, PatchOp, PatchTarget } from './patch.ts'
