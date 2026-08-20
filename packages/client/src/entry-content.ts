/**
 * What a content route needs: adopt the server's render and bind whatever is interactive.
 * No update path, no persistence — a page that reads does not need to patch itself.
 */
export { adopt } from './adopt.ts'
export { signal, batch } from './signal.ts'
export type { ClientTemplate, Resident } from './template.ts'
