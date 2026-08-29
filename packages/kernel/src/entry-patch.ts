/**
 * The surgical path plus the rung that needs no projectable values. The encoder arrives through
 * `SurgicalInput.patch` rather than an import in `refresh.ts`: written in, it cost every entry on
 * the refresh path ~600 B. See `spec/kernel/budgets.md`.
 */
export * from './entry-channel.ts'
export { payloadKey } from './refresh.ts'
export type { PatchEncoder } from './refresh.ts'
export { patchPayload } from '@weftjs/ir'
export type { PatchPayload, PatchWrite, PatchOp } from '@weftjs/ir'
