/** A channel route plus the rung of the surgical ladder that needs no template. See `spec/kernel/budgets.md`. */
export * from './entry-channel.ts'
export { applyPatch, patchFrames, patchApplies } from './patch.ts'
export type { PatchPayload, PatchWrite, PatchOp, PatchTarget } from './patch.ts'
