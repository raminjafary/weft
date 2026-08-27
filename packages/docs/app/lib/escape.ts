/**
 * The escaper, from where the rest of the site has always imported it.
 *
 * It moved to `app/escape.ts` so `app/hl.ts` can reach it without a subdirectory — see the note
 * there. Nothing that imports it from here had to change.
 */
export { escapeHtml } from '../escape.ts'
