/**
 * What an invalidation does when there is nobody connected to tell — a turn holds nothing between
 * requests. Its own entry: the hub takes only an `onInvalidated` hook and does not know what is on
 * the other end. See `spec/kernel/transport.md`.
 */
export * from './entry-transport.ts'
export { storeJournal } from './journal.ts'
export type { StaleJournal, StaleEntry, StoreJournalOptions } from './journal.ts'
