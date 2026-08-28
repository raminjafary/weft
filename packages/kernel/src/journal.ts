import type { StorePort } from './ports.ts'

/**
 * What a binding with no downstream is told when it next asks.
 *
 * `hub.notify` reaches connections this process is holding, which is every binding except the one
 * that holds nothing: a turn has no connection between requests, so an invalidation that happens
 * while nobody is asking has nowhere to go and, on the three held bindings, would simply have been
 * pushed. The journal is where it waits instead — a durable record of *which keys are known wrong*,
 * read on the next turn and answered as the `STALE` frames that turn would have received.
 *
 * One entry per key rather than a list of them, and that is the design rather than an encoding
 * detail. A list is read-modify-write, so two instances invalidating at once lose one of the two
 * entries against any store without a compare-and-swap — and `StorePort` has none, on purpose. One
 * key per entry has no such race: each writer writes its own key, each reader reads exactly the keys
 * it cares about, and the store's own TTL does the trimming that a list would need code for.
 *
 * What it deliberately does not do is decide *when* a client has already dealt with something. The
 * entry carries the instant it was written and the client keeps the last one it acted on, so a
 * client that turns ten times inside the window is told the same thing ten times and acts once. Put
 * the other way round, this is a record and not a queue: it has no notion of a reader, so nothing
 * here can be consumed, missed by a reader that never came back, or delivered twice.
 */
/** One recorded invalidation: when the key was dropped, and what dropped it. */
export interface StaleEntry {
  /** When the key was dropped, by the clock of whichever instance dropped it. */
  at: number
  reason: string
}

/**
 * A record of which keys are known wrong, readable by whoever asks next.
 *
 * Not a queue, and the difference decides the shape: reading does not consume, so two clients on
 * one page are both told and one client asking twice is told twice. What separates a second
 * telling from a second write is the instant on the entry, which the client sends back as `since`.
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
  /**
   * How long an entry is worth keeping.
   *
   * The window a client may be away for and still be told. Long enough that an ordinary reader
   * coming back to a tab hears about the write; short enough that the record does not become a
   * second copy of the invalidation history. A client away for longer gets the ordinary answer —
   * it asks, and is told what is there now — which is the same floor every other path degrades to.
   */
  windowMs?: number
}

const utf8 = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The journal over whatever store the deployment already bound.
 *
 * On a shared store this is cross-instance on its own, with no broker: instance A writes the key
 * and instance B reads it. On a process-scoped store it is per-instance, which is the same thing
 * `E_TAGS_PROCESS_SCOPED` refuses at build time for the same reason — so a deployment that gets
 * this wrong is told at build time rather than by a region that never updates.
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
          // `shared`, because the whole point is that another instance reads it. A private class
          // would refuse the write on a tiered store, which is the store telling the truth.
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
            // A journal entry that will not parse is a journal entry that is not there. It is a
            // record of something already dropped, so the worst a skipped one costs is a client
            // told on its next turn instead of this one.
          }
        }),
      )
      return out
    },
  }
}
