import type { StorePort } from '@weftjs/kernel'

/** Several stores composed as one `StorePort`. See `spec/kernel/ports.md`. */
const CONSISTENCY_ORDER = { eventual: 0, strong: 1 } as const
const SCOPE_ORDER = { shared: 0, process: 1 } as const
const COHERENCE_ORDER = { ttl: 0, generation: 1, warp: 2, pubsub: 3, tracking: 4 } as const

function weakest<T extends string>(values: T[], order: Record<T, number>): T {
  return values.reduce((worst, value) => (order[value] < order[worst] ? value : worst), values[0] as T)
}

/** Several stores as one, nearest first. Reports the weakest tier's coherence, not the nearest. */
export function tieredStore(tiers: readonly StorePort[], name = 'tiered'): StorePort {
  if (!tiers.length) throw new Error('E_NO_TIERS: a tiered store needs at least one tier')
  const ordered = [...tiers]

  return {
    name,
    consistency: weakest(
      ordered.map((t) => t.consistency),
      CONSISTENCY_ORDER,
    ),
    coherence: weakest(
      ordered.map((t) => t.coherence),
      COHERENCE_ORDER,
    ),
    scope: weakest(
      ordered.map((t) => t.scope),
      SCOPE_ORDER,
    ),
    maxValueBytes: Math.min(...ordered.map((t) => t.maxValueBytes)),

    async get(key, options) {
      for (let i = 0; i < ordered.length; i++) {
        const tier = ordered[i] as StorePort
        const entry = await tier.get(key, options)
        if (!entry) continue
        // A stale read does not promote — the tier above would end up serving expired bytes to a reader who never asked for them.
        if (options?.stale) return entry
        for (let j = 0; j < i; j++) {
          const { storedAt: _storedAt, ...meta } = entry.meta
          await (ordered[j] as StorePort).set(key, entry.value, meta)
        }
        return entry
      }
      return null
    },

    async set(key, value, meta) {
      const bytes = value instanceof Uint8Array ? value : await new Response(value).bytes()
      // Filtered on the write, not the read: an entry that never left cannot reach the wrong person.
      const targets = meta.class === 'private' ? ordered.filter((t) => t.scope === 'process') : ordered
      await Promise.all(targets.map((tier) => tier.set(key, bytes, meta)))
    },

    async invalidate(tags) {
      const dropped = await Promise.all(ordered.map((tier) => tier.invalidate(tags)))
      return [...new Set(dropped.flat())].sort()
    },

    /** The outermost tier holds the lease: a lease that only the fastest tier knows about is not one. */
    lease(key, ttlMs) {
      return (ordered[ordered.length - 1] as StorePort).lease(key, ttlMs)
    },

    revalidateAfterResponse(task) {
      ;(ordered[0] as StorePort).revalidateAfterResponse(task)
    },
  }
}
