/**
 * Authority: who may run an intent, and whether this deployment issued the call at all.
 *
 * The intent path plus the two things phase 7 owes it. A capability model behind the
 * `CapabilityCheck` seam, which until now refused everything that declared a capability — honest,
 * and not an implementation. And signed intents: an expiring token bound to the intent, the reader
 * and the payload, verified against a pinned public key bundle, single-use.
 *
 * Its own entry, and not because the intent path has no room. Because this is the tier the design
 * says is separable: "small, security-sensitive, deliberately separable so it can be audited and
 * rate-limited on its own". An entry it can be measured and reviewed as is the byte-budget form of
 * that sentence, and a deployment whose intents declare no authority never imports any of it.
 */
export * from './entry-intent.ts'
export { covers, createCapabilityModel, grantsOf, roleGrants, AuthorityError } from './authority.ts'
export { canonical, createIntentSigner, createIntentVerifier, digest, TokenError } from './token.ts'
