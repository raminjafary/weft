/**
 * The surgical path plus the rung that needs no projectable values.
 *
 * Its own entry, and the encoder arrives through `SurgicalInput.patch` rather than through an
 * import in `refresh.ts`, for one measured reason: written into the refresh path it cost every
 * entry that carries that path ~600 B of brotli and took four watermarks past their ceilings —
 * including two that a deployment composing regions pays and never uses. A capability whose
 * growth is charged to somebody else's headroom is the mistake the byte budgets exist to catch,
 * so this is where the rung is measured and where a deployment that wants it opts in.
 *
 * A deployment that does not pass the encoder has a ladder with the rung missing, and
 * `selectForm` names that rather than falling silently to markup.
 */
export * from './entry-channel.ts'
export { payloadKey } from './refresh.ts'
export type { PatchEncoder } from './refresh.ts'
export { patchPayload } from '@weftjs/ir'
export type { PatchPayload, PatchWrite, PatchOp } from '@weftjs/ir'
