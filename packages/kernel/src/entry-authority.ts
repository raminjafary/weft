/**
 * Authority: who may run an intent, and whether this deployment issued the call at all — a
 * capability model and signed intents, on top of the intent path. Its own entry: the design says
 * this tier is separable. See `spec/kernel/budgets.md`.
 */
export * from './entry-intent.ts'
export { covers, createCapabilityModel, grantsOf, roleGrants, AuthorityError } from './authority.ts'
export { canonical, createIntentSigner, createIntentVerifier, digest, TokenError } from './token.ts'
