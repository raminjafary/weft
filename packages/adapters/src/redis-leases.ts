import { randomUUID } from 'node:crypto'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type { Lease, StorePort } from '@weft/kernel'

/**
 * Leases a whole deployment agrees about, over a socket.
 *
 * This is the bottom row of the table in `spec/kernel/authority.md`, and it is the row that was
 * described rather than shipped. `sharedLeases` makes a nonce single-use per **machine** by creating
 * a file nobody else can create; two machines do not share that directory, so behind a load balancer
 * it is single-use per instance and the deployment is told so. What that needs is somewhere outside
 * both processes that can answer "did anybody already take this", and `SET key value NX PX ttl` is
 * exactly that answer: one round trip, atomic, expiring on its own.
 *
 * **Why this is in the framework at all**, given that the port exists so a deployment can bring its
 * own. Because the port existing is not the same as the answer existing: `W_REPLAY_PROCESS_LOCAL`
 * named a fix nobody could apply without writing a Redis client first, and a fix that costs a day is
 * a fix most deployments will decide they do not need. The client below is a hundred lines because
 * the subset it needs is small — this speaks RESP to Redis, Valkey, KeyDB or anything else that
 * answers the same four verbs, and it is not a general-purpose Redis client and does not want to be.
 *
 * **What it does not touch.** `scope`, again. Where an entry may travel is unchanged by this; a
 * process-local cache with networked leases is a perfectly ordinary arrangement and is what most
 * deployments should want, because a shared cache is a much larger decision made for reasons that
 * have nothing to do with replay.
 *
 * **What a failure means.** A store that cannot be reached does not return "free" — it throws, and
 * `verifyIntent` turns that into `E_REPLAY_UNKNOWN`. A signed intent that proceeds on a maybe is a
 * signed intent that can be replayed for the length of an outage, which is the window an attacker
 * would choose. Refusing during an outage is the weaker product and the stronger property.
 */
export interface RedisLeaseOptions {
  /**
   * `redis://[user:password@]host[:port][/db]`, or `rediss://` for TLS.
   *
   * A URL rather than a bag of fields because it is the string a platform hands you, and the one a
   * deployment already has in an environment variable.
   */
  url?: string
  host?: string
  port?: number
  password?: string
  username?: string
  db?: number
  tls?: boolean
  /**
   * Prepended to every lease key. Empty by default: the keys arriving here are already namespaced by
   * whoever asked (`weft:intent-nonce:…`, `render:/feed`), and a second prefix is only worth having
   * when one server holds more than one deployment's leases.
   */
  prefix?: string
  /** How long to wait for the connection itself. */
  connectTimeoutMs?: number
  /**
   * How long to wait for a reply before treating the connection as gone.
   *
   * This is on the request path — a lease is taken while somebody is waiting for an answer — so it
   * is short by default. A timeout destroys the socket rather than abandoning one reply, because
   * replies are matched to commands by order and a reply nobody is waiting for would be handed to
   * the next caller: the wrong nonce answered by the wrong lease.
   */
  timeoutMs?: number
  name?: string
}

/**
 * Release without stealing, which is the one place this needs more than a single verb.
 *
 * `DEL` would be wrong. A lease that expired and was taken by somebody else is somebody else's, and
 * a late release deleting it hands the same nonce out twice — the exact failure the lease exists to
 * prevent, arriving from the cleanup path. So the value is a token this caller generated and the
 * delete is conditional on it, which is the standard Redis lock idiom and is standard for a reason.
 */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`

export type LeasedStore = StorePort & {
  /** Close the connection. A socket outlives a request by design, so something has to end it. */
  close(): void
}

export function redisLeases(base: StorePort, options: RedisLeaseOptions = {}): LeasedStore {
  const target = resolve(options)
  const prefix = options.prefix ?? ''
  const connection = client(target)

  return {
    ...base,
    name: options.name ?? `${base.name}+redis-leases`,
    // Deliberately untouched, exactly as `sharedLeases` leaves it. Only who agrees about a lease has
    // changed, and a tiered store still refuses to write a private entry to a shared tier.
    scope: base.scope,
    leaseScope: 'shared',

    async lease(key, ttlMs): Promise<Lease | null> {
      const name = `${prefix}${key}`
      const token = randomUUID()
      const px = String(Math.max(1, Math.ceil(ttlMs)))
      const reply = await connection.command(['SET', name, token, 'NX', 'PX', px])
      // `+OK` means this caller created it. A nil bulk means somebody else holds it, which for a
      // nonce is the answer rather than an error: this token has already been used.
      if (reply === null) return null
      return {
        key,
        release: () => {
          // Fire and forget, like every other release here: nothing waits on it, and a release that
          // never lands leaves a lease to expire on its own, which is what the TTL is for.
          void connection.command(['EVAL', RELEASE, '1', name, token]).catch(() => {})
        },
      }
    },

    close(): void {
      connection.close()
    },
  }
}

interface Target {
  host: string
  port: number
  tls: boolean
  username?: string
  password?: string
  db?: number
  connectTimeoutMs: number
  timeoutMs: number
}

function resolve(options: RedisLeaseOptions): Target {
  const url = options.url ? new URL(options.url) : undefined
  const db = url?.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : options.db
  return {
    host: options.host ?? url?.hostname ?? '127.0.0.1',
    port: options.port ?? (url?.port ? Number(url.port) : 6379),
    tls: options.tls ?? url?.protocol === 'rediss:',
    ...((options.username ?? (url?.username || undefined))
      ? { username: options.username ?? decodeURIComponent(url?.username ?? '') }
      : {}),
    ...((options.password ?? (url?.password || undefined))
      ? { password: options.password ?? decodeURIComponent(url?.password ?? '') }
      : {}),
    ...(db !== undefined && Number.isFinite(db) ? { db } : {}),
    connectTimeoutMs: options.connectTimeoutMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 1_000,
  }
}

type Reply = string | number | null | Reply[]

interface Waiter {
  resolve(reply: Reply): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * As much of a Redis client as a lease needs, and no more.
 *
 * Replies arrive in the order commands were sent — that is a protocol guarantee and it is why this
 * can be a queue rather than a correlation table. Everything hard about a real client (pub/sub,
 * pipelining policy, cluster redirects, RESP3 push messages) is absent because a lease needs none of
 * it, and pretending otherwise would be a worse trade than the fifty lines below.
 */
function client(target: Target): { command(args: readonly string[]): Promise<Reply>; close(): void } {
  let socket: Socket | null = null
  let opening: Promise<Socket> | null = null
  let buffer: Buffer = Buffer.alloc(0)
  let closed = false
  const waiting: Waiter[] = []

  const fail = (error: Error): void => {
    const dead = socket
    socket = null
    opening = null
    buffer = Buffer.alloc(0)
    while (waiting.length) {
      const waiter = waiting.shift() as Waiter
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    dead?.destroy()
  }

  const receive = (chunk: Buffer): void => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      let parsed: Parsed | null
      try {
        parsed = parse(buffer, 0)
      } catch (error) {
        fail(new Error(`E_LEASE_PROTOCOL: ${(error as Error).message}`))
        return
      }
      if (!parsed) return
      buffer = buffer.subarray(parsed.at)
      const waiter = waiting.shift()
      if (!waiter) continue
      clearTimeout(waiter.timer)
      if (parsed.error) waiter.reject(new Error(`E_LEASE_REFUSED: ${parsed.error}`))
      else waiter.resolve(parsed.value)
    }
  }

  const send = (on: Socket, args: readonly string[]): Promise<Reply> =>
    new Promise<Reply>((resolve_, reject) => {
      const timer = setTimeout(() => {
        // The socket goes with it. See `timeoutMs`: an abandoned reply would be handed to whoever
        // asked next, and for a nonce that is one token answering for another.
        fail(new Error(`E_LEASE_TIMEOUT: ${args[0]} to ${target.host}:${target.port} did not answer`))
      }, target.timeoutMs)
      waiting.push({ resolve: resolve_, reject, timer })
      on.write(encode(args))
    })

  const open = (): Promise<Socket> => {
    if (closed) return Promise.reject(new Error('E_LEASE_CLOSED: this store has been closed'))
    if (socket && !socket.destroyed) return Promise.resolve(socket)
    if (opening) return opening
    opening = new Promise<Socket>((resolve_, reject) => {
      const s = target.tls
        ? connectTls({ host: target.host, port: target.port, servername: target.host })
        : connectTcp({ host: target.host, port: target.port })
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error(`E_LEASE_UNREACHABLE: ${target.host}:${target.port} did not accept a connection`))
      }, target.connectTimeoutMs)
      s.setNoDelay(true)
      s.on('data', receive)
      s.on('error', (error: Error) => {
        clearTimeout(timer)
        const unreachable = new Error(`E_LEASE_UNREACHABLE: ${error.message}`)
        fail(unreachable)
        reject(unreachable)
      })
      s.on('close', () => {
        clearTimeout(timer)
        fail(new Error(`E_LEASE_UNREACHABLE: the connection to ${target.host}:${target.port} closed`))
      })
      s.once(target.tls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer)
        socket = s
        // Handshake on the socket rather than through `command`, so it cannot be overtaken by a
        // lease queued while the connection was still opening.
        const handshake: Promise<Reply>[] = []
        if (target.password !== undefined) {
          handshake.push(
            send(s, target.username ? ['AUTH', target.username, target.password] : ['AUTH', target.password]),
          )
        }
        if (target.db !== undefined) handshake.push(send(s, ['SELECT', String(target.db)]))
        Promise.all(handshake).then(
          () => resolve_(s),
          (error: Error) => reject(error),
        )
      })
    })
    const attempt = opening
    attempt.then(
      () => {
        if (opening === attempt) opening = null
      },
      () => {
        if (opening === attempt) opening = null
      },
    )
    return attempt
  }

  return {
    async command(args): Promise<Reply> {
      const on = await open()
      return send(on, args)
    },
    close(): void {
      closed = true
      fail(new Error('E_LEASE_CLOSED: this store has been closed'))
    },
  }
}

function encode(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')]
  for (const arg of args) {
    parts.push(Buffer.from(`$${Buffer.byteLength(arg)}\r\n${arg}\r\n`, 'utf8'))
  }
  return Buffer.concat(parts)
}

interface Parsed {
  value: Reply
  error?: string
  /** Where the next reply starts. */
  at: number
}

/**
 * RESP2, in the five forms a lease can receive. Returns null when the buffer holds a partial reply,
 * which is the ordinary case on a socket and not an error.
 */
function parse(buffer: Buffer, from: number): Parsed | null {
  if (from >= buffer.length) return null
  const end = buffer.indexOf('\r\n', from)
  if (end === -1) return null
  const marker = buffer[from]
  const head = buffer.toString('utf8', from + 1, end)
  const after = end + 2

  if (marker === 0x2b) return { value: head, at: after }
  if (marker === 0x2d) return { value: null, error: head, at: after }
  if (marker === 0x3a) return { value: Number(head), at: after }
  if (marker === 0x24) {
    const length = Number(head)
    if (length === -1) return { value: null, at: after }
    if (buffer.length < after + length + 2) return null
    return { value: buffer.toString('utf8', after, after + length), at: after + length + 2 }
  }
  if (marker === 0x2a) {
    const count = Number(head)
    if (count === -1) return { value: null, at: after }
    const items: Reply[] = []
    let at = after
    for (let i = 0; i < count; i++) {
      const item = parse(buffer, at)
      if (!item) return null
      items.push(item.value)
      at = item.at
    }
    return { value: items, at }
  }
  throw new Error(`unexpected reply type '${String.fromCharCode(marker ?? 0)}'`)
}
