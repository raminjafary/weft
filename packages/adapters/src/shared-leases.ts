import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lease, StorePort } from '@weft/kernel'

/**
 * Leases that more than one process agrees about, over a directory.
 *
 * This exists because of one sentence in the authority spec: replay protection is exactly as strong
 * as the store's lease, and until now every store this framework shipped was process-scoped — so
 * `W_REPLAY_PROCESS_LOCAL` was a warning no deployment could act on. A warning nobody can act on is
 * a warning that teaches you to ignore warnings.
 *
 * **What it fixes, exactly.** A nonce is spent by taking a lease nobody releases. Two `weft start`
 * processes behind a local proxy, or a Node cluster, share a filesystem — so an exclusive create in a
 * shared directory is a spent nonce every one of them can see. That is single-use per *machine*, and
 * it is the deployment shape most Node applications actually have.
 *
 * **What it does not fix, equally exactly.** Two machines do not share this directory, so this is not
 * single-use per deployment across a load balancer. That needs something networked, and the port is
 * where it plugs in — `lease` over Redis `SET NX PX`, over a Durable Object, over a Postgres advisory
 * lock. What this closes is the framework's half: there is now a real answer for the common case and a
 * clear shape for the rest, rather than one warning and no path.
 *
 * It wraps rather than replaces, and only `lease` changes. A cache is where it was — process-local,
 * byte-bounded, evicted — and `scope` still says so, because a tiered store refuses to write a private
 * entry to a shared tier on the strength of that field and this does not make the cache shared. What
 * it sets is `leaseScope`, which is the field the verifier reads.
 */
export interface SharedLeaseOptions {
  /**
   * Where the leases live. One directory, on a filesystem every process that has to agree can see.
   *
   * A tmpfs is fine and arguably right: a lease is not data, and a machine that has restarted has no
   * in-flight requests whose nonces could be replayed. What is not fine is a network filesystem whose
   * `O_EXCL` is advisory — NFS without locking has never guaranteed it, and a lease that two callers
   * can both take is not a lease.
   */
  dir: string
  clock?: () => number
  name?: string
}

/**
 * A key becomes a filename by SHA-256, and the hash matters more here than it looks.
 *
 * A nonce is the thing being leased, so two keys colliding is two different tokens sharing a spent
 * marker — one of them refused as a replay it never made. A short non-cryptographic hash is right for
 * a cache key, where a collision costs a miss; it is wrong for this, where a collision costs a
 * refusal somebody cannot explain.
 */
function filename(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function sharedLeases(base: StorePort, options: SharedLeaseOptions): StorePort {
  const clock = options.clock ?? ((): number => Date.now())
  // Synchronous, once, at construction: a store that might not have its directory yet is a store
  // whose first lease fails for a reason unrelated to whether anybody holds it.
  mkdirSync(options.dir, { recursive: true })

  return {
    ...base,
    name: options.name ?? `${base.name}+shared-leases`,
    // Deliberately not touched. Where entries may travel is unchanged by this; only who agrees about
    // a lease is, and that is what the field below is for.
    scope: base.scope,
    leaseScope: 'shared',

    async lease(key, ttlMs): Promise<Lease | null> {
      const path = join(options.dir, filename(key))
      const expiry = clock() + ttlMs

      const take = async (): Promise<Lease | null> => {
        let handle
        try {
          // `wx` is `O_CREAT | O_EXCL`, which is atomic on a local filesystem: exactly one caller
          // creates the file and every other gets EEXIST. That is the whole mechanism.
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

      /**
       * Held — or held by somebody who has gone away and left an expired marker behind.
       *
       * Stealing an expired one has to be safe against two processes stealing it at once, and
       * `unlink` is what makes it: exactly one caller's unlink succeeds and the rest get ENOENT, so
       * only the winner goes on to attempt the create. A third process that was mid-`open` can still
       * win the create between our unlink and ours, in which case we get EEXIST and report held,
       * which is the correct answer.
       *
       * Worth being exact about what a spurious "held" costs, because this path can produce one. For
       * a nonce it costs nothing reachable: the lease's lifetime *is* the token's, so a token whose
       * lease has expired is a token the verifier has already refused on `x`. For a stampede lease it
       * means wait or serve stale, which is what a contended lease means anyway.
       */
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
