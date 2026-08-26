import type { EntryMeta, Lease, StoreEntry, StorePort } from '@weft/kernel'

/**
 * The host the kernel was written for, and the one it had no adapter for.
 *
 * "The kernel imports nothing but the WinterTC Minimum Common Web API" is the rule that makes
 * "runs on Workers" a property rather than a porting exercise — and this repository had no way to
 * demonstrate it. Everything in here is that demonstration: no `node:` imports, `Request` and
 * `Response` and `crypto` and nothing else, and it runs in Node too, which is how it is tested.
 *
 * Two things a Workers deployment needs that a Node one does not.
 *
 * **`waitUntil` is the only reason work outlives a response.** An isolate is torn down when its
 * response settles, so a revalidation queued and not handed to the platform is a revalidation that
 * never happens. `StorePort.revalidateAfterResponse` collected tasks and `drain` runs them; here the
 * promise goes to `ctx.waitUntil`, which is the platform's own contract for exactly this.
 *
 * **A store with no atomic operation cannot pretend to have one.** `kvStore` refuses `lease` by name
 * rather than approximating it, because a lease that is not atomic is a stampede guard that does not
 * guard and — much worse — a replay guard that reports every nonce fresh. That is the one place in
 * this design where an approximation is a security bug, so the refusal is the implementation.
 */

/**
 * The shape of an edge key-value namespace, which is deliberately not one provider's client.
 *
 * Workers KV, Deno KV's flat mode, an R2 bucket used as a map, a Redis REST proxy: all of them are
 * this. A binding is passed in rather than constructed, because a framework that constructed one
 * would be a framework that had chosen a provider.
 */
export interface KvNamespace {
  get(key: string, options?: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[]
    list_complete?: boolean
    cursor?: string
  }>
}

/** What a KV-backed store needs to know about the namespace it was handed. */
export interface KvStoreOptions {
  name?: string
  /**
   * Where a lease is taken, when this deployment needs one.
   *
   * Not optional in spirit: an unbound lease is `E_NO_ATOMIC_LEASE` and every caller that needs one
   * is refused by name. `redisLeases` is the implementation that exists; a Durable Object or a
   * Postgres advisory lock are the other honest answers.
   */
  leases?: Pick<StorePort, 'lease' | 'leaseScope'>
  /** Bytes a single entry may be, from the platform's own limit. */
  maxValueBytes?: number
  clock?(): number
}

const TAG_PREFIX = 'weft:tag:'

/** What a tag index entry is called. Prefix-listable, because KV has no secondary index. */
function tagKey(tag: string, key: string): string {
  return `${TAG_PREFIX}${tag}:${key}`
}

/** A store over Workers KV. Eventually consistent, and it declares that rather than hoping. */
export function kvStore(namespace: KvNamespace, options: KvStoreOptions = {}): StorePort {
  const clock = options.clock ?? ((): number => Date.now())
  const queued: (() => Promise<void>)[] = []

  return {
    name: options.name ?? 'kv',
    // Stated rather than assumed: an edge KV is a read-through cache of a write that has not
    // finished propagating. Every consumer of this port that cares reads `consistency`.
    consistency: 'eventual',
    coherence: 'ttl',
    scope: 'shared',
    maxValueBytes: options.maxValueBytes ?? 25 * 1024 * 1024,
    ...(options.leases?.leaseScope ? { leaseScope: options.leases.leaseScope } : {}),

    async get(key, read) {
      const held = await namespace.get(key, { type: 'arrayBuffer' })
      if (!held) return null
      const decoded = decode(held)
      if (!decoded) return null
      const { meta, value } = decoded
      if (meta.ttlMs !== undefined && clock() - meta.storedAt > meta.ttlMs && !read?.stale) return null
      return { value, meta }
    },

    async set(key, value, meta) {
      const bytes = value instanceof Uint8Array ? value : await collect(value)
      const full: EntryMeta = { ...meta, storedAt: clock() }
      /**
       * The TTL goes to the platform *and* into the record.
       *
       * `expirationTtl` is what makes the entry go away without anybody sweeping, and the stored
       * `storedAt` is what makes `get(key, { stale: true })` possible — serving the last good render
       * on an error needs an entry the platform has not reclaimed yet but this store considers
       * expired. Two clocks for two questions, and the platform's is the longer one.
       */
      const ttlSeconds = full.ttlMs === undefined ? undefined : Math.max(60, Math.ceil(full.ttlMs / 1000) * 2)
      await namespace.put(
        key,
        encode(full, bytes),
        ttlSeconds === undefined ? undefined : { expirationTtl: ttlSeconds },
      )
      // One index entry per tag, listable by prefix. A tag list stored as one value would be a
      // read-modify-write on every set, which on an eventually consistent store loses writes.
      for (const tag of meta.tags ?? []) await namespace.put(tagKey(tag, key), '1')
    },

    async invalidate(tags) {
      const dropped = new Set<string>()
      for (const tag of tags) {
        let cursor: string | undefined
        do {
          const page = await namespace.list({
            prefix: `${TAG_PREFIX}${tag}:`,
            ...(cursor ? { cursor } : {}),
          })
          for (const entry of page.keys) {
            const key = entry.name.slice(`${TAG_PREFIX}${tag}:`.length)
            dropped.add(key)
            await namespace.delete(key)
            await namespace.delete(entry.name)
          }
          cursor = page.list_complete === false ? page.cursor : undefined
        } while (cursor)
      }
      return [...dropped].sort()
    },

    async lease(key, ttlMs): Promise<Lease | null> {
      if (!options.leases) {
        throw new Error(
          'E_NO_ATOMIC_LEASE: an edge key-value store has no atomic compare-and-set, so a lease ' +
            'taken here would be a stampede guard that does not guard and a replay guard that ' +
            'reports every nonce fresh. Bind `leases` — redisLeases, a Durable Object, an advisory ' +
            'lock — or do not declare anything that needs one',
        )
      }
      return options.leases.lease(key, ttlMs)
    },

    revalidateAfterResponse(task) {
      queued.push(task)
    },

    async drain() {
      const tasks = queued.splice(0, queued.length)
      // Settled rather than raced: one failing revalidation must not abandon the others, and
      // `waitUntil` cares only that the promise finishes.
      await Promise.allSettled(tasks.map((task) => task()))
    },
  }
}

/**
 * A record is its metadata and then its bytes, in one value.
 *
 * KV metadata exists and is limited to about a kilobyte and is not returned by every
 * implementation of this shape, so the record carries its own: a length-prefixed JSON head and the
 * body after it. The same arrangement the template fingerprint uses, for the same reason — one
 * value, self-describing, no second round trip.
 */
function encode(meta: EntryMeta, value: Uint8Array): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + head.length + value.length)
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  out.set(value, 4 + head.length)
  return out.buffer
}

function decode(held: ArrayBuffer): StoreEntry | null {
  const bytes = new Uint8Array(held)
  if (bytes.length < 4) return null
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
  if (bytes.length < 4 + length) return null
  try {
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as EntryMeta
    return { meta, value: bytes.subarray(4 + length) }
  } catch {
    return null
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
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** What a Workers runtime hands a fetch handler. Structural, so no platform types are imported. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

/** What the Workers entry needs, including the `waitUntil` that lets work outlive a response. */
export interface WorkersHandlerOptions {
  /** Anything that answers a Request. `createKernel(...).serve` is the one this exists for. */
  serve(request: Request): Promise<Response>
  /** The store whose after-response queue the platform is asked to wait for. */
  store: Pick<StorePort, 'drain'>
  /** Told when a revalidation queue could not be handed to the platform, which is a silent failure. */
  onOrphaned?(reason: string): void
}

/**
 * `export default workersHandler({ serve, store })` and nothing else.
 *
 * The whole adapter is this shape: an isolate is torn down when its response settles, so the one
 * thing a host has to be told is what to stay alive for. A deployment that forgets is not slower,
 * it is a deployment whose revalidation never runs — so an absent `ctx` is reported rather than
 * ignored, and the drain still happens inline where it can.
 */
export function workersHandler(options: WorkersHandlerOptions): {
  fetch(request: Request, env?: unknown, ctx?: ExecutionContext): Promise<Response>
} {
  return {
    async fetch(request, _env, ctx) {
      const response = await options.serve(request)
      const drain = options.store.drain?.bind(options.store)
      if (!drain) return response
      if (ctx?.waitUntil) {
        ctx.waitUntil(drain())
        return response
      }
      /**
       * No `ctx`, which happens in a test, behind a shim, or on a host whose signature differs.
       *
       * Draining inline delays the response by whatever the revalidation costs, which is the wrong
       * trade — but it is the *stated* wrong trade, and the alternative is work that vanishes. So it
       * is done and it is reported.
       */
      options.onOrphaned?.('no execution context: the revalidation queue was drained inline')
      await drain()
      return response
    },
  }
}
