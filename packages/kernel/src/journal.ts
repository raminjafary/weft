import type { StorePort } from './ports.ts'

/**
 * What a binding with no downstream is told when it next asks — a turn has no connection between
 * requests, so the journal is where an invalidation waits instead. One entry per key, not a list:
 * `StorePort` has no compare-and-swap. See `spec/kernel/transport.md`.
 */
/** One recorded invalidation: when the key was dropped, and what dropped it. */
export interface StaleEntry {
  /** When the key was dropped, by the clock of whichever instance dropped it. */
  at: number
  reason: string
}

/**
 * A record of which keys are known wrong, readable by whoever asks next. Not a queue: reading does
 * not consume, and the instant on the entry — sent back as `since` — separates a retelling from a
 * rewrite.
 */
export interface StaleJournal {
  readonly name: string
  /** Record that these keys are known wrong. Called by `invalidate`, after the store has dropped them. */
  record(keys: readonly string[], reason: string): Promise<void>
  /** Which of these keys are known wrong, and when each was dropped. */
  lookup(keys: readonly string[]): Promise<Map<string, StaleEntry>>
}

const PREFIX = 'weft:stale:'

/** How long a written-down invalidation is worth keeping. */
export interface StoreJournalOptions {
  /** How long an entry is worth keeping: long enough for an ordinary reader coming back to a tab,
   * short enough not to become a second invalidation history. */
  windowMs?: number
}

const utf8 = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The journal over whatever store the deployment already bound. Cross-instance on a shared store,
 * with no broker. A process-scoped store is refused at build time: `E_TAGS_PROCESS_SCOPED`.
 */
export function storeJournal(store: StorePort, options: StoreJournalOptions = {}): StaleJournal {
  const ttlMs = options.windowMs ?? 5 * 60_000
  return {
    name: `journal(${store.name})`,
    async record(keys, reason) {
      const at = Date.now()
      const entry = utf8.encode(JSON.stringify({ at, reason }))
      await Promise.all(
        keys.map((key) =>
          // `shared`: the whole point is that another instance reads it.
          store.set(`${PREFIX}${key}`, entry, { class: 'shared', ttlMs }),
        ),
      )
    },
    async lookup(keys) {
      const out = new Map<string, StaleEntry>()
      await Promise.all(
        keys.map(async (key) => {
          const found = await store.get(`${PREFIX}${key}`)
          if (!found) return
          try {
            const said = JSON.parse(decoder.decode(found.value)) as StaleEntry
            if (typeof said.at === 'number') out.set(key, said)
          } catch {
            // A journal entry that will not parse is a journal entry that is not there.
          }
        }),
      )
      return out
    },
  }
}
