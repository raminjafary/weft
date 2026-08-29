import type { LimitDecision, LimitPort, LimitRequest, StorePort } from '@weftjs/kernel'

/**
 * A rate limiter, and the shape of the one decision the kernel refused to make: `counted` is the
 * whole port, since *whose* traffic this is differs per deployment. See `spec/kernel/authority.md`.
 */
export interface CountingLimitOptions {
  /** Where counts live. A single-process store means a limit per process. */
  store: StorePort
  /**
   * What a call is counted against, or null for a call this deployment does not limit — an intent
   * with an internal caller (a queue worker, a migration) needs to say "not this one".
   */
  counted(request: LimitRequest): Promise<string | null> | string | null
  /** For a test that needs a clock it controls. */
  now?(): number
}

/** Counted against the caller's address, which behind any real proxy is a header. */
export function byAddress(header = 'x-forwarded-for'): CountingLimitOptions['counted'] {
  return (request) => {
    const value = request.header(header)
    // The left-most entry is the client; the rest are proxies.
    return value ? (value.split(',')[0] as string).trim() || null : null
  }
}

/** Counted against the session, which is where an unauthenticated caller still has an identity. */
export function bySession(cookie = 'sid'): CountingLimitOptions['counted'] {
  return (request) => request.cookie(cookie) ?? null
}

/** Counted against the subject, and unlimited before anybody signs in — no silent address fallback. */
export function bySubject(): CountingLimitOptions['counted'] {
  return (request) => request.subject
}

const utf8 = new TextEncoder()

/**
 * A fixed-window counter, and it says fixed on purpose: `StorePort` has a lease, not a counter, so
 * a sliding window is not available here. See `spec/kernel/authority.md`.
 */
export function countingLimits(options: CountingLimitOptions): LimitPort {
  const now = options.now ?? (() => Date.now())

  return {
    name: `counting(${options.store.name})`,
    async check(request): Promise<LimitDecision> {
      const against = await options.counted(request)
      if (against === null) return { ok: true }

      // The window is part of the key, so a bucket expires by being a different key: nothing has
      // to sweep, at the cost of a boundary burst up to twice the limit.
      const window_ = Math.floor(now() / request.limit.windowMs)
      const key = `weft:limit:${request.id}:${against}:${window_}`
      const held = await options.store.get(key)
      const count = held ? Number(new TextDecoder().decode(held.value)) || 0 : 0

      if (count >= request.limit.max) {
        return {
          ok: false,
          counted: against,
          retryAfterMs: (window_ + 1) * request.limit.windowMs - now(),
        }
      }
      await options.store.set(key, utf8.encode(String(count + 1)), {
        class: 'private',
        // Two windows, so a bucket outlives the window it counts.
        ttlMs: request.limit.windowMs * 2,
        tags: [],
      })
      return { ok: true, remaining: request.limit.max - count - 1 }
    },
  }
}
