/**
 * Mutations, on top of the document request path — the only thing in this framework allowed to
 * write. Its own entry: a document-only deployment should not carry dispatch or method-aware
 * routing. See `spec/kernel/budgets.md`.
 */
export * from './entry-request.ts'
export { createIntentDispatch, defineIntent, IntentError } from './intent.ts'
export { createIntentRouter, serveIntent } from './intent-http.ts'
