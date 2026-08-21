/**
 * Mutations, on top of the document request path. The only thing in this framework allowed to
 * write, and therefore the thing every capability that depends on a write was waiting for:
 * invalidation, `revalidateTag`, an optimistic epoch driven by a real mutation, and a route
 * that can answer a POST.
 *
 * Its own entry because a deployment that serves documents and nothing else should not carry
 * dispatch, capability checks or method-aware routing — and because the document request path
 * has 193 bytes of headroom, which is not where a new capability goes.
 */
export * from './entry-request.ts'
export { createIntentDispatch, defineIntent, IntentError } from './intent.ts'
export { createIntentRouter, serveIntent } from './intent-http.ts'
