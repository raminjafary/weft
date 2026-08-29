import type { Coalescer, Lease, StorePort } from './ports.ts'

/**
 * A stampede lease. One renderer takes the lease; the rest wait for its result. This polls,
 * because an isolate-local map cannot tell anybody a key was filled — a store with pub/sub would
 * subscribe instead, which is why the kernel names the seam and this supplies the policy.
 *
 * Two properties enforced rather than documented: the wait is **bounded** — on expiry the waiter
 * renders too, since a duplicated render beats a hanging request — and the lease is released in a
 * `finally`, so a render that throws does not hold it.
 */
export interface CoalesceOptions {
  /** How long the winner holds the right to fill. Longer than a render, shorter than a page load. */
  leaseMs?: number
  /** How long a loser waits before rendering anyway. */
  waitMs?: number
  pollMs?: number
}

/**
 * One render per cold key, using the store's lease. Opt-in: the good version is store-specific,
 * and a coalescer written into the request path would be one every deployment pays for.
 */
export function leaseCoalescer(store: StorePort, options: CoalesceOptions = {}): Coalescer {
  const leaseMs = options.leaseMs ?? 5_000
  const waitMs = options.waitMs ?? 1_000
  const pollMs = options.pollMs ?? 10

  return async (key, render) => {
    let lease: Lease | null = null
    try {
      lease = await store.lease(key, leaseMs)
      if (!lease) {
        for (let waited = 0; waited < waitMs; waited += pollMs) {
          await new Promise((resolve) => setTimeout(resolve, pollMs))
          const entry = await store.get(key)
          if (entry) return { bytes: entry.value, waited: true }
        }
      }
      return { bytes: await render(), waited: false }
    } finally {
      lease?.release()
    }
  }
}
