/**
 * What an app route needs on top of a content route: surgical updates and a resident set
 * that survives the visit.
 */
export { adopt } from './adopt.ts'
export { signal, computed, batch, effect, untrack } from './signal.ts'
export { applyDelta, baseMatches } from './delta.ts'
export { openResident, digest, heldBy, isHeld } from './resident.ts'
export type { ClientTemplate, Resident } from './template.ts'
