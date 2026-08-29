import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lease, StorePort } from '@weftjs/kernel'

/**
 * Leases that more than one process agrees about, over a directory: single-use per **machine**,
 * via an exclusive create in a shared directory. Not single-use across a load balancer — that
 * needs something networked, which is what `redisLeases` is for. See `spec/kernel/authority.md`.
 */
export interface SharedLeaseOptions {
  /**
   * Where the leases live. A tmpfs is fine — a lease is not data. A network filesystem whose
   * `O_EXCL` is advisory is not: a lease two callers can both take is not a lease.
   */
  dir: string
  clock?: () => number
  name?: string
}

/**
 * A key becomes a filename by SHA-256. A nonce is the thing being leased, so two keys colliding
 * is one refused as a replay it never made — a short hash is wrong here.
 */
function filename(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/** Leases over any store that can do a conditional write, for deployments with no Redis. */
export function sharedLeases(base: StorePort, options: SharedLeaseOptions): StorePort {
  const clock = options.clock ?? ((): number => Date.now())
  // Synchronous, once, at construction: a missing directory should not fail the first lease.
  mkdirSync(options.dir, { recursive: true })

  return {
    ...base,
    name: options.name ?? `${base.name}+shared-leases`,
    // Deliberately not touched: only who agrees about a lease changes.
    scope: base.scope,
    leaseScope: 'shared',

    async lease(key, ttlMs): Promise<Lease | null> {
      const path = join(options.dir, filename(key))
      const expiry = clock() + ttlMs

      const take = async (): Promise<Lease | null> => {
        let handle
        try {
          // `wx` is `O_CREAT | O_EXCL`, atomic on a local filesystem: one caller creates it, the
          // rest get EEXIST.
          handle = await open(path, 'wx')
        } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') throw error
          return null
        }
        try {
          await handle.writeFile(String(expiry))
        } finally {
          await handle.close()
        }
        return { key, release: () => void unlink(path).catch(() => {}) }
      }

      const taken = await take()
      if (taken) return taken

      // Held — or held by somebody who left an expired marker. Stealing has to be safe against
      // two processes stealing at once: `unlink` succeeds for exactly one caller, and the rest
      // get ENOENT.
      const held = Number(await readFile(path, 'utf8').catch(() => '0'))
      if (held > clock()) return null
      try {
        await unlink(path)
      } catch {
        return null
      }
      return take()
    },
  }
}
