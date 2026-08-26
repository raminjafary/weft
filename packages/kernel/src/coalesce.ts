import type { Coalescer, Lease, StorePort } from './ports.ts'

/**
 * A stampede lease, and the reason it is here rather than in the request path.
 *
 * A miss under load is where a cache stops helping: N concurrent requests all miss the same
 * key, all render, and the render is the expensive part. One renderer takes the lease and the
 * rest wait for its result. That much is universal.
 *
 * How they wait is not. This polls, because an isolate-local map cannot tell anybody that a
 * key was filled. A store with pub/sub would subscribe and pay one round trip instead of
 * `waitMs / pollMs` of them, and the store is the only thing that knows which it is — which is
 * why the kernel names the seam and this supplies the policy.
 *
 * Two properties are not negotiable and are enforced here rather than documented. The wait is
 * **bounded**: on expiry the waiter renders too, because a duplicated render is worse than a
 * hit and very much better than a request hanging behind a renderer that crashed. And the
 * lease is released in a `finally`, so a render that throws does not hold it — the TTL is the
 * backstop for a process that dies, not for an exception.
 */
export interface CoalesceOptions {
  /** How long the winner holds the right to fill. Longer than a render, shorter than a page load. */
  leaseMs?: number
  /** How long a loser waits before rendering anyway. */
  waitMs?: number
  pollMs?: number
}

/**
 * One render per cold key, using the store's lease.
 *
 * Opt-in because the good version is store-specific and the kernel should not have a favourite —
 * and a seam, because a coalescer written into the request path would be one every deployment pays
 * for. What it prevents is the thing that turns a cold cache into an incident.
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
