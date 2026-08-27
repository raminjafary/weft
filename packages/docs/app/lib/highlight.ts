/**
 * The highlighter, from where the browser can also reach it.
 *
 * It lives at `app/hl.ts` because `app/client.ts` imports it and the framework serves that tree to
 * the browser. Everything server-side imports it from here, which is where it has always been.
 */
export { highlight } from '../hl.ts'
