import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kvStore, workersHandler, type KvNamespace } from '../src/workers.ts'
import { memoryStore } from '../src/memory-store.ts'

const utf8 = new TextEncoder()

/**
 * A key-value namespace of the shape every edge store has, in memory.
 *
 * Not a mock of one provider's client: the interface is `get`, `put`, `delete` and a prefix `list`,
 * which is Workers KV, Deno KV's flat mode, an R2 bucket used as a map and a REST proxy in front of
 * anything. That the adapter is written against this shape rather than against an import is the
 * whole point — a framework that constructed a client would be a framework that had chosen.
 */
function namespace(): KvNamespace & { size: number } {
  const held = new Map<string, Uint8Array>()
  return {
    get size() {
      return held.size
    },
    async get(key) {
      const value = held.get(key)
      if (!value) return null
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
    },
    async put(key, value) {
      const bytes =
        typeof value === 'string'
          ? utf8.encode(value)
          : value instanceof Uint8Array
            ? value
            : new Uint8Array(value)
      held.set(key, bytes)
    },
    async delete(key) {
      held.delete(key)
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      return { keys: [...held.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })) }
    },
  }
}

test('an entry round-trips through a key-value namespace with its metadata intact', async () => {
  const kv = namespace()
  const store = kvStore(kv)
  await store.set('k', utf8.encode('bytes'), { class: 'shared', ttlMs: 60_000, tags: ['prices'] })

  const held = await store.get('k')
  assert.ok(held)
  assert.equal(new TextDecoder().decode(held.value), 'bytes')
  assert.equal(held.meta.class, 'shared')
  assert.equal(held.meta.ttlMs, 60_000)
  assert.deepEqual(held.meta.tags, ['prices'])
  assert.ok(held.meta.storedAt > 0, 'and the record carries when it was stored, which is what expiry needs')
})

test('a tag is an index of one entry per key, because an eventual store loses a read-modify-write', async () => {
  const kv = namespace()
  const store = kvStore(kv)
  await store.set('a', utf8.encode('1'), { class: 'shared', tags: ['cart', 'prices'] })
  await store.set('b', utf8.encode('2'), { class: 'shared', tags: ['cart'] })
  await store.set('c', utf8.encode('3'), { class: 'shared', tags: ['other'] })

  assert.deepEqual(await store.invalidate(['cart']), ['a', 'b'])
  assert.equal(await store.get('a'), null)
  assert.equal(await store.get('b'), null)
  assert.ok(await store.get('c'), 'a tag nobody invalidated keeps its entry')
})

test('an expired entry is invisible, and readable by the one caller entitled to ask', async () => {
  let now = 1_000
  const store = kvStore(namespace(), { clock: () => now })
  await store.set('k', utf8.encode('last good render'), { class: 'shared', ttlMs: 1_000 })
  now += 5_000

  assert.equal(await store.get('k'), null)
  const stale = await store.get('k', { stale: true })
  assert.equal(new TextDecoder().decode(stale?.value as Uint8Array), 'last good render')
})

test('a lease is refused by name, because an approximated one is a replay guard that lies', async () => {
  const store = kvStore(namespace())
  await assert.rejects(() => store.lease('nonce', 1_000), /E_NO_ATOMIC_LEASE/)
  await assert.rejects(() => store.lease('nonce', 1_000), /Bind `leases`/)
})

test('a bound lease provider is used, and its scope is what the store reports', async () => {
  // Any store with an atomic lease will do, which is the point of the seam: the KV holds the
  // entries and something that can compare-and-set holds the leases.
  const leases = memoryStore()
  const store = kvStore(namespace(), { leases })
  const taken = await store.lease('nonce', 1_000)
  assert.ok(taken, 'the first caller takes it')
  assert.equal(await store.lease('nonce', 1_000), null, 'and the second is told somebody has')
})

/**
 * The whole reason a Workers adapter exists as more than a store.
 *
 * An isolate is torn down when its response settles, so a revalidation queued and not handed to the
 * platform is a revalidation that never happens. Both halves are asserted: that the promise reaches
 * `waitUntil`, and that the work in it actually ran.
 */
test('a queued revalidation is handed to the platform, and the platform’s promise is the work', async () => {
  const kv = namespace()
  const store = kvStore(kv)
  let ran = 0
  const waited: Promise<unknown>[] = []

  const handler = workersHandler({
    serve: async () => {
      store.revalidateAfterResponse(async () => {
        // Slow on purpose: what has to be true is that the response did not wait for this.
        await new Promise((resolve) => setTimeout(resolve, 50))
        ran++
        await store.set('warm', utf8.encode('rendered after the response'), { class: 'shared' })
      })
      return new Response('the page')
    },
    store,
  })

  const response = await handler.fetch(
    new Request('https://example.test/'),
    {},
    {
      waitUntil: (promise) => waited.push(promise),
    },
  )

  assert.equal(await response.text(), 'the page')
  assert.equal(waited.length, 1, 'exactly one promise, which is the drain')
  assert.equal(ran, 0, 'the response did not wait for it')
  assert.equal(await store.get('warm'), null)

  // And the promise the platform was handed is the work: this is the line that would fail if
  // `waitUntil` had been given something already settled, which is how this silently never runs.
  await Promise.all(waited)
  assert.equal(ran, 1)
  assert.ok(await store.get('warm'), 'the work the platform waited for is the work that happened')
})

test('no execution context drains inline and says so, rather than losing the work', async () => {
  const store = kvStore(namespace())
  let ran = 0
  const orphaned: string[] = []
  const handler = workersHandler({
    serve: async () => {
      store.revalidateAfterResponse(async () => {
        ran++
      })
      return new Response('ok')
    },
    store,
    onOrphaned: (reason) => orphaned.push(reason),
  })

  await handler.fetch(new Request('https://example.test/'))
  assert.equal(ran, 1, 'work that cannot be handed to a platform is done rather than dropped')
  assert.match(orphaned[0] ?? '', /drained inline/)
})

test('one failing revalidation does not abandon the others', async () => {
  const store = kvStore(namespace())
  const ran: string[] = []
  store.revalidateAfterResponse(async () => {
    ran.push('first')
    throw new Error('upstream down')
  })
  store.revalidateAfterResponse(async () => {
    ran.push('second')
  })
  await store.drain?.()
  assert.deepEqual(ran.sort(), ['first', 'second'])
})

test('the adapter reaches for no host runtime, which is what makes it the Workers one', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/workers.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string)
  assert.deepEqual(
    imports.filter((specifier) => specifier.startsWith('node:')),
    [],
    'a Workers adapter that imported node: would be an adapter for Node',
  )
  assert.deepEqual(imports, ['@weftjs/kernel'], 'and the only thing it needs is the port it implements')
})
