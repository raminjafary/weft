import type { StorePort } from '../../kernel/src/ports.ts'

/**
 * Cache is a topology, not a boolean. "Store it on the server or hook up an external store"
 * should not be a fork in the codebase, so a tiered store is one `StorePort` composed of
 * others rather than a different mechanism.
 *
 * The composite's consistency is the weakest of its tiers, and its coherence is the weakest
 * too. Reporting the strongest would be the comfortable lie: an L1 that cannot be
 * invalidated from outside puts a ceiling on what the whole stack can promise, and the plan
 * refuses a strong-consistency policy against an eventual store at build time on the
 * strength of exactly this number.
 */
const CONSISTENCY_ORDER = { eventual: 0, strong: 1 } as const
const COHERENCE_ORDER = { ttl: 0, generation: 1, warp: 2, pubsub: 3, tracking: 4 } as const

function weakest<T extends string>(values: T[], order: Record<T, number>): T {
  return values.reduce((worst, value) => (order[value] < order[worst] ? value : worst), values[0] as T)
}

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
    maxValueBytes: Math.min(...ordered.map((t) => t.maxValueBytes)),

    async get(key) {
      for (let i = 0; i < ordered.length; i++) {
        const tier = ordered[i] as StorePort
        const entry = await tier.get(key)
        if (!entry) continue
        // A hit deep in the stack fills every tier above it, so the second reader is fast.
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
      await Promise.all(ordered.map((tier) => tier.set(key, bytes, meta)))
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
