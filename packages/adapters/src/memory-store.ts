import type { EntryMeta, Lease, StoreEntry, StorePort } from '@weft/kernel'

/**
 * L1: isolate-local memory. Byte-bounded and LRU-evicted, never an unbounded Map — inside a
 * 128 MB Workers isolate an unbounded cache is not a cache, it is an outage waiting for
 * traffic.
 *
 * Its coherence is `generation`, and saying so is the point of putting coherence in the
 * port interface at all. A process-local tier cannot be addressed from outside, so it
 * cannot be told that something it holds is now wrong. Bounded TTL plus a generation
 * counter is the honest maximum here; a Redis adapter would say `tracking` and mean it.
 *
 * It also holds in-flight leases, so concurrent identical renders coalesce in-process
 * before any distributed lease is taken.
 */
export interface MemoryStoreOptions {
  maxBytes?: number
  name?: string
  clock?: () => number
}

interface Slot {
  entry: StoreEntry
  bytes: number
}

export interface MemoryStore extends StorePort {
  /**
   * Runs the tasks handed to `revalidateAfterResponse`. On Workers this is `waitUntil`; on
   * Node it is a task queue somebody has to drain, and pretending otherwise would mean
   * revalidation silently never happening.
   */
  drain(): Promise<void>
}

export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const clock = options.clock ?? (() => Date.now())
  const entries = new Map<string, Slot>()
  const tags = new Map<string, Set<string>>()
  const leases = new Map<string, number>()
  const after: (() => Promise<void>)[] = []
  let bytes = 0
  let generation = 0

  const drop = (key: string): void => {
    const slot = entries.get(key)
    if (!slot) return
    bytes -= slot.bytes
    entries.delete(key)
    for (const tag of slot.entry.meta.tags ?? []) tags.get(tag)?.delete(key)
  }

  const evict = (): void => {
    // Map iterates in insertion order, and a hit reinserts, so the first key is the LRU.
    for (;;) {
      if (bytes <= maxBytes) return
      const oldest = entries.keys().next().value
      if (oldest === undefined) return
      drop(oldest)
    }
  }

  return {
    name: options.name ?? 'memory',
    consistency: 'strong',
    maxValueBytes: maxBytes,
    coherence: 'generation',
    scope: 'process',

    async get(key) {
      const slot = entries.get(key)
      if (!slot) return null
      const { ttlMs, storedAt } = slot.entry.meta
      if (ttlMs !== undefined && clock() - storedAt > ttlMs) {
        drop(key)
        return null
      }
      entries.delete(key)
      entries.set(key, slot)
      return slot.entry
    },

    async set(key, value, meta) {
      const bytesValue = value instanceof Uint8Array ? value : await collect(value)
      if (bytesValue.length > maxBytes) {
        throw new Error(`E_VALUE_TOO_LARGE: ${bytesValue.length} bytes exceeds the ${maxBytes} byte ceiling`)
      }
      drop(key)
      const entry: StoreEntry = {
        value: bytesValue,
        meta: { ...meta, storedAt: clock(), generation } as EntryMeta,
      }
      entries.set(key, { entry, bytes: bytesValue.length })
      bytes += bytesValue.length
      for (const tag of meta.tags ?? []) {
        let set = tags.get(tag)
        if (!set) {
          set = new Set()
          tags.set(tag, set)
        }
        set.add(key)
      }
      evict()
    },

    async invalidate(dropTags) {
      generation++
      const dropped: string[] = []
      for (const tag of dropTags) {
        for (const key of tags.get(tag) ?? []) {
          if (entries.has(key)) dropped.push(key)
          drop(key)
        }
        tags.delete(tag)
      }
      return dropped.sort()
    },

    async lease(key, ttlMs) {
      const held = leases.get(key)
      if (held !== undefined && held > clock()) return null
      leases.set(key, clock() + ttlMs)
      const lease: Lease = { key, release: () => leases.delete(key) }
      return lease
    },

    revalidateAfterResponse(task) {
      after.push(task)
    },

    async drain() {
      const tasks = after.splice(0, after.length)
      await Promise.all(tasks.map((task) => task()))
    },
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
