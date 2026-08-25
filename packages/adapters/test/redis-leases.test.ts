import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { memoryStore } from '../src/memory-store.ts'
import { redisLeases } from '../src/redis-leases.ts'

/**
 * A lease a whole deployment agrees about, and what a test can honestly say about one.
 *
 * What is being tested is the **client**: the four verbs, the ordering, the conditional release, and
 * what happens when the server is not there. So the server here is a stand-in that speaks RESP and
 * implements `SET NX PX`, `GET`, `DEL` and the release script — not Redis, and it is not pretending
 * to be. What it does prove is the part that matters and that `sharedLeases` could not have: the
 * agreement lives **outside every process taking part**, so a second process with no shared
 * filesystem and no shared heap is told the nonce is spent.
 *
 * Set `WEFT_REDIS_URL` and these run against the real server instead, which is the only thing that
 * can say Redis behaves as this client assumes. That is a switch rather than a default because a
 * test suite that needs a daemon running is a test suite people stop running.
 */
const run = promisify(execFile)
const HERE = fileURLToPath(new URL('../src/', import.meta.url))
const REAL = process.env['WEFT_REDIS_URL']

const servers: Server[] = []
const closers: (() => void)[] = []
after(async () => {
  for (const close of closers) close()
  for (const listener of servers) await new Promise((resolve) => listener.close(resolve))
})

/** One namespace per test, so a real server run does not have to be started empty. */
let run_ = 0
function ns(): string {
  run_ += 1
  return `weft-test:${process.pid}:${run_}:`
}

async function server(): Promise<string> {
  if (REAL) return REAL
  const entries = new Map<string, { value: string; expires: number }>()

  const live = (key: string): { value: string; expires: number } | undefined => {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) {
      entries.delete(key)
      return undefined
    }
    return entry
  }

  const answer = (args: string[]): string => {
    const verb = (args[0] ?? '').toUpperCase()
    if (verb === 'PING') return '+PONG\r\n'
    if (verb === 'AUTH' || verb === 'SELECT') return '+OK\r\n'
    if (verb === 'SET') {
      const [, key = '', value = '', ...rest] = args
      const nx = rest.some((flag) => flag.toUpperCase() === 'NX')
      const px = rest.findIndex((flag) => flag.toUpperCase() === 'PX')
      const ttl = px === -1 ? 60_000 : Number(rest[px + 1])
      if (nx && live(key)) return '$-1\r\n'
      entries.set(key, { value, expires: Date.now() + ttl })
      return '+OK\r\n'
    }
    if (verb === 'GET') {
      const entry = live(args[1] ?? '')
      return entry ? `$${Buffer.byteLength(entry.value)}\r\n${entry.value}\r\n` : '$-1\r\n'
    }
    if (verb === 'DEL') return `:${entries.delete(args[1] ?? '') ? 1 : 0}\r\n`
    if (verb === 'EVAL') {
      // Only the one script this adapter sends: get, compare, delete. A stand-in that interpreted
      // Lua would be a worse test than one that refuses everything it was not written for.
      const key = args[3] ?? ''
      const token = args[4] ?? ''
      const entry = live(key)
      if (entry && entry.value === token) {
        entries.delete(key)
        return ':1\r\n'
      }
      return ':0\r\n'
    }
    return `-ERR unknown command '${verb}'\r\n`
  }

  const listener = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const parsed = command(buffer)
        if (!parsed) return
        buffer = buffer.subarray(parsed.at)
        socket.write(answer(parsed.args))
      }
    })
    socket.on('error', () => socket.destroy())
  })
  servers.push(listener)
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `redis://127.0.0.1:${port}`
}

/** The inverse of the client's encoder, and only the array-of-bulk-strings form a command takes. */
function command(buffer: Buffer): { args: string[]; at: number } | null {
  if (!buffer.length || buffer[0] !== 0x2a) return null
  let end = buffer.indexOf('\r\n')
  if (end === -1) return null
  const count = Number(buffer.toString('utf8', 1, end))
  let at = end + 2
  const args: string[] = []
  for (let i = 0; i < count; i++) {
    if (buffer[at] !== 0x24) return null
    end = buffer.indexOf('\r\n', at)
    if (end === -1) return null
    const length = Number(buffer.toString('utf8', at + 1, end))
    if (buffer.length < end + 2 + length + 2) return null
    args.push(buffer.toString('utf8', end + 2, end + 2 + length))
    at = end + 2 + length + 2
  }
  return { args, at }
}

function leases(url: string): ReturnType<typeof redisLeases> {
  const store = redisLeases(memoryStore(), { url })
  closers.push(() => store.close())
  return store
}

/**
 * Takes a lease in a child process. A child and not a worker, for the reason the shared-lease test
 * gives — and here it is stronger: this child shares no heap *and no filesystem* with the parent, so
 * the only thing that can tell it the nonce is spent is the server both of them are talking to.
 */
async function inAnotherProcess(url: string, key: string): Promise<boolean> {
  const script = `
    import { memoryStore } from '${HERE}memory-store.ts'
    import { redisLeases } from '${HERE}redis-leases.ts'
    const store = redisLeases(memoryStore(), { url: ${JSON.stringify(url)} })
    const lease = await store.lease(${JSON.stringify(key)}, 60_000)
    process.stdout.write(lease ? 'took' : 'held')
    store.close()
  `
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script])
  return stdout.trim() === 'took'
}

test('a lease taken here is held as far as another machine would be concerned', async () => {
  const url = await server()
  const key = `${ns()}n-1`
  const store = leases(url)

  assert.ok(await store.lease(key, 60_000), 'this process took it')
  assert.equal(
    await inAnotherProcess(url, key),
    false,
    'and a process sharing neither a heap nor a filesystem is told it is spent',
  )
})

test('a different nonce is a different lease, so one spent token does not refuse every other', async () => {
  const url = await server()
  const prefix = ns()
  const store = leases(url)
  assert.ok(await store.lease(`${prefix}n-1`, 60_000))
  assert.equal(await inAnotherProcess(url, `${prefix}n-2`), true)
})

test('exactly one of two concurrent takers gets it, and neither is privileged', async () => {
  const url = await server()
  const key = `${ns()}race`
  const [first, second] = await Promise.all([inAnotherProcess(url, key), inAnotherProcess(url, key)])
  assert.equal([first, second].filter(Boolean).length, 1)
})

test('releasing it lets the next caller have it, which is what a stampede lease is for', async () => {
  const url = await server()
  const key = `${ns()}render:/feed`
  const store = leases(url)
  const held = await store.lease(key, 60_000)
  assert.ok(held)
  assert.equal(await inAnotherProcess(url, key), false)
  held.release()
  // Fire and forget by design, so give the release a tick to land before asking again.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await inAnotherProcess(url, key), true)
})

test('a lease that expired and was taken by somebody else survives the first holder releasing', async () => {
  // The reason release is a compare-and-delete rather than a DEL. A late release deleting a lease it
  // no longer owns would hand the same nonce out twice, arriving from the cleanup path.
  const url = await server()
  const key = `${ns()}expiring`
  const store = leases(url)

  const brief = await store.lease(key, 60)
  assert.ok(brief)
  await new Promise((resolve) => setTimeout(resolve, 120))

  const next = await store.lease(key, 60_000)
  assert.ok(next, 'expired, so the next caller takes it')
  brief.release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(await inAnotherProcess(url, key), false, 'and the second holder still holds it')
})

test('a store that cannot be reached refuses rather than reporting the nonce fresh', async () => {
  // Nothing is listening on this port. The answer has to be a throw: `verifyIntent` turns it into
  // E_REPLAY_UNKNOWN, and a signed intent that proceeded on a maybe would be replayable for the
  // length of an outage.
  const store = redisLeases(memoryStore(), {
    url: 'redis://127.0.0.1:1',
    connectTimeoutMs: 200,
  })
  closers.push(() => store.close())
  await assert.rejects(() => store.lease('weft:intent-nonce:n', 60_000), /E_LEASE_UNREACHABLE/)
})

test('only the lease is networked: the cache is where it was, and the store says so', async () => {
  const url = await server()
  const base = memoryStore()
  const store = leases(url)
  assert.equal(store.scope, 'process', 'entries live exactly where they did')
  assert.equal(store.leaseScope, 'shared', 'and only the agreement about leases is wider')
  assert.equal(base.leaseScope, undefined, 'an unwrapped store has one answer for both, so it says one')

  await store.set('k', new TextEncoder().encode('v'), { class: 'shared', tags: ['t'] })
  assert.equal(new TextDecoder().decode((await store.get('k'))?.value), 'v')
  assert.deepEqual(await store.invalidate(['t']), ['k'])
})

/**
 * The end of the claim, with the verifier in it rather than the store alone.
 *
 * Every assertion above is about a lease. This one is about what a lease is *for*: a signed intent
 * spent on one instance is refused on another, which is the property `replayScope: 'shared'` reports
 * and the reason any of this exists. The second verifier is a second process holding the public key
 * and the connection string and nothing else — no heap, no filesystem, no cache.
 */
test('a token spent on one instance is E_INTENT_REPLAYED on another', async () => {
  const { createIntentSigner, createIntentVerifier } = await import('@weft/kernel')
  const url = await server()
  const prefix = ns()
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')

  const store = redisLeases(memoryStore(), { url, prefix })
  closers.push(() => store.close())
  const verifier = createIntentVerifier({ keys: { k1: pair.publicKey }, store })
  assert.equal(verifier.replayScope, 'shared', 'and it says so, which is what a deployment reads')

  const signer = createIntentSigner({ kid: 'k1', key: pair.privateKey })
  const payload = { sku: 'RICE-5K', qty: 2 }
  const token = await signer.mint({ intent: 'c1', subject: 'u42', payload })
  const first = await verifier.verify({ id: 'c1', token, raw: payload, subject: 'u42' })
  assert.equal(first.ok, true)

  const kernel = fileURLToPath(new URL('../../kernel/src/', import.meta.url))
  const script = `
    import { createIntentVerifier } from '${kernel}token.ts'
    import { memoryStore } from '${HERE}memory-store.ts'
    import { redisLeases } from '${HERE}redis-leases.ts'
    const key = await crypto.subtle.importKey('spki', Buffer.from(${JSON.stringify(spki)}, 'base64'),
      { name: 'Ed25519' }, false, ['verify'])
    const store = redisLeases(memoryStore(), { url: ${JSON.stringify(url)}, prefix: ${JSON.stringify(prefix)} })
    const verifier = createIntentVerifier({ keys: { k1: key }, store })
    const out = await verifier.verify({
      id: 'c1', token: ${JSON.stringify(token)},
      raw: ${JSON.stringify(payload)}, subject: 'u42',
    })
    process.stdout.write(out.ok ? 'ok' : out.code)
    store.close()
  `
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script])
  assert.equal(stdout.trim(), 'E_INTENT_REPLAYED')
})

test('a verifier whose lease store is unreachable refuses the call rather than allowing it', async () => {
  const { createIntentSigner, createIntentVerifier } = await import('@weft/kernel')
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const store = redisLeases(memoryStore(), { url: 'redis://127.0.0.1:1', connectTimeoutMs: 200 })
  closers.push(() => store.close())
  const verifier = createIntentVerifier({ keys: { k1: pair.publicKey }, store })
  const signer = createIntentSigner({ kid: 'k1', key: pair.privateKey })
  const token = await signer.mint({ intent: 'c1', subject: 'u42', payload: { a: 1 } })

  const outcome = await verifier.verify({ id: 'c1', token, raw: { a: 1 }, subject: 'u42' })
  assert.equal(outcome.ok, false)
  // Not `ok` with a note in a log. An outage is when a replay is worth attempting.
  assert.equal(outcome.ok === false ? outcome.code : '', 'E_REPLAY_UNKNOWN')
})
