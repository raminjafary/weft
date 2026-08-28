/**
 * What an invalidation does when there is nobody connected to tell, and nothing else.
 *
 * The three held bindings need none of this. They are connected by definition, so `notify` has
 * somewhere to put a `STALE` the moment the write happens, and a deployment made only of sockets
 * should not carry a line of what is below. A turn holds nothing between requests: an invalidation
 * that happens in that gap is not delivered late, it is not delivered at all, unless something
 * wrote it down for the next request to find.
 *
 * Its own entry on the rule the transport and the stager both established — a new capability
 * argues with its own number rather than spending somebody else's headroom — and here that rule
 * has a second edge. The hub does not import this at all: it takes an `onInvalidated` hook and
 * does not know whether what is on the other end is a journal, a fanout, both, or nothing. So
 * without an entry of its own this module would be reachable from nowhere, gated by nothing, and
 * invisible to every ceiling in the repository.
 */
export * from './entry-transport.ts'
export { storeJournal } from './journal.ts'
export type { StaleJournal, StaleEntry, StoreJournalOptions } from './journal.ts'
