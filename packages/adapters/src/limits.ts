import type { LimitDecision, LimitPort, LimitRequest, StorePort } from '@weft/kernel'

/**
 * A rate limiter, and the shape of the one decision the kernel refused to make.
 *
 * `counted` is the whole port. Everything else here — a fixed window, a counter per bucket, a
 * refusal that says when to try again — is arithmetic, and arithmetic is not what made rate limiting
 * the last unimplemented piece of the authority tier. What made it that is the question of *whose*
 * traffic this is, and the answer is different for a public API behind a CDN, a session-based
 * application, and a service where every caller has a subject. So it is a function a deployment
 * writes, and the three things it can be written against are the three the port hands it.
 *
 * `byAddress`, `bySession` and `bySubject` below are the three written out, because a port whose
 * only documentation is its type is a port everybody implements slightly wrong the first time.
 */
export interface CountingLimitOptions {
  /**
   * Where counts live. A single-process store means a limit per process, and this adapter says so
   * at construction rather than leaving it to be discovered — the same argument the nonce store
   * makes about replay, and the same fix: bind a shared one.
   */
  store: StorePort
  /**
   * What a call is counted against, or null for a call this deployment does not limit.
   *
   * Null is not a mistake and not a hole: a limit on an intent that also has an internal caller —
   * a queue worker, a migration — has to be able to say "not this one", and the honest place for
   * that decision is here rather than a second declaration on the intent.
   */
  counted(request: LimitRequest): Promise<string | null> | string | null
  /** For a test that needs a clock it controls. */
  now?(): number
}

/** Counted against the caller's address, which behind any real proxy is a header. */
export function byAddress(header = 'x-forwarded-for'): CountingLimitOptions['counted'] {
  return (request) => {
    const value = request.header(header)
    // The left-most entry is the client; everything after it is the proxies. A limiter counting
    // the whole list would give every caller behind a different proxy chain its own budget.
    return value ? (value.split(',')[0] as string).trim() || null : null
  }
}

/** Counted against the session, which is where an unauthenticated caller still has an identity. */
export function bySession(cookie = 'sid'): CountingLimitOptions['counted'] {
  return (request) => request.cookie(cookie) ?? null
}

/**
 * Counted against the subject, and unlimited before anybody signs in.
 *
 * Stated rather than silently combined with an address fallback: a limiter that quietly counted
 * anonymous callers by IP would be a different policy from the one that was asked for, and the
 * deployment that wants both can compose the two functions itself.
 */
export function bySubject(): CountingLimitOptions['counted'] {
  return (request) => request.subject
}

const utf8 = new TextEncoder()

export function countingLimits(options: CountingLimitOptions): LimitPort {
  const now = options.now ?? (() => Date.now())

  return {
    name: `counting(${options.store.name})`,
    async check(request): Promise<LimitDecision> {
      const against = await options.counted(request)
      if (against === null) return { ok: true }

      /**
       * A fixed window, named as one.
       *
       * The window is part of the key, so a bucket expires by being a different key rather than by
       * being cleaned up. What that buys is that nothing has to sweep; what it costs is the boundary
       * burst a fixed window always costs — twice the limit across two adjacent windows. A sliding
       * window needs a read-modify-write per call against a store that can do one atomically, and
       * `StorePort` deliberately cannot: it has a lease and not a counter. So this is the honest
       * limiter for the port that exists, and a deployment that needs a sliding window binds one
       * against something that can count.
       */
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
        // Two windows, so a bucket outlives the window it counts and a clock that drifts backwards
        // by less than one window does not hand out a fresh budget.
        ttlMs: request.limit.windowMs * 2,
        tags: [],
      })
      return { ok: true, remaining: request.limit.max - count - 1 }
    },
  }
}
