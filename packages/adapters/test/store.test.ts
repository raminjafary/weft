import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore, tieredStore } from '../src/index.ts'
import { permutations, staticFlags } from '../src/flags.ts'
import { cookieSession } from '../src/session.ts'
import { requestFacts } from '@weftjs/kernel'

const utf8 = new TextEncoder()
const shared = { class: 'shared' } as const

test('the store names its own coherence, because an L1 cannot be invalidated from outside', () => {
  const store = memoryStore()
  assert.equal(store.coherence, 'generation')
  assert.equal(store.consistency, 'strong')
  assert.equal(store.scope, 'process')
})

test('a value round-trips', async () => {
  const store = memoryStore()
  await store.set('k', utf8.encode('hello'), shared)
  assert.equal(new TextDecoder().decode((await store.get('k'))?.value), 'hello')
  assert.equal(await store.get('missing'), null)
})

test('a stream can be stored, so a fragment is cacheable while it streams to the first reader', async () => {
  const store = memoryStore()
  await store.set(
    'k',
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8.encode('ab'))
        controller.enqueue(utf8.encode('cd'))
        controller.close()
      },
    }),
    shared,
  )
  assert.equal(new TextDecoder().decode((await store.get('k'))?.value), 'abcd')
})

test('a ttl expires without anybody sweeping', async () => {
  let now = 1000
  const store = memoryStore({ clock: () => now })
  await store.set('k', utf8.encode('v'), { ...shared, ttlMs: 50 })
  now = 1040
  assert.notEqual(await store.get('k'), null)
  now = 1100
  assert.equal(await store.get('k'), null)
})

test('the ceiling is bytes and the eviction is least-recently-used', async () => {
  const store = memoryStore({ maxBytes: 10 })
  await store.set('a', utf8.encode('12345'), shared)
  await store.set('b', utf8.encode('12345'), shared)
  await store.get('a')
  await store.set('c', utf8.encode('12345'), shared)
  assert.equal(await store.get('b'), null)
  assert.notEqual(await store.get('a'), null)
  assert.notEqual(await store.get('c'), null)
})

test('a value larger than the ceiling is refused rather than evicting everything', async () => {
  const store = memoryStore({ maxBytes: 4 })
  await assert.rejects(() => store.set('k', utf8.encode('toolong'), shared), /E_VALUE_TOO_LARGE/)
})

test('invalidation names the keys it dropped, which is what a STALE push needs', async () => {
  const store = memoryStore()
  await store.set('a', utf8.encode('1'), { ...shared, tags: ['cart:42', 'all'] })
  await store.set('b', utf8.encode('1'), { ...shared, tags: ['all'] })
  assert.deepEqual(await store.invalidate(['cart:42']), ['a'])
  assert.equal(await store.get('a'), null)
  assert.notEqual(await store.get('b'), null)
})

test('a lease is held by one caller, so identical renders coalesce', async () => {
  const store = memoryStore({ clock: () => 0 })
  const first = await store.lease('k', 100)
  assert.notEqual(first, null)
  assert.equal(await store.lease('k', 100), null)
  first?.release()
  assert.notEqual(await store.lease('k', 100), null)
})

test('an expired lease does not wedge the key forever', async () => {
  let now = 0
  const store = memoryStore({ clock: () => now })
  await store.lease('k', 100)
  now = 200
  assert.notEqual(await store.lease('k', 100), null)
})

test('revalidation after the response has to be drained by somebody, and is', async () => {
  const store = memoryStore()
  let ran = false
  store.revalidateAfterResponse(async () => {
    ran = true
  })
  assert.equal(ran, false)
  await store.drain()
  assert.equal(ran, true)
})

test('a tiered store reports the weakest tier, not the most comfortable one', () => {
  const l1 = memoryStore({ name: 'l1' })
  const l2: typeof l1 = {
    ...memoryStore({ name: 'l2' }),
    consistency: 'eventual',
    coherence: 'ttl',
    scope: 'shared',
  }
  const tiered = tieredStore([l1, l2])
  assert.equal(tiered.consistency, 'eventual')
  assert.equal(tiered.coherence, 'ttl')
  assert.equal(tiered.scope, 'shared', 'one shared tier makes the whole stack shared')
})

test('a private entry never reaches a tier somebody else can read', async () => {
  const l1 = memoryStore({ name: 'l1' })
  const l2: typeof l1 = { ...memoryStore({ name: 'l2' }), scope: 'shared' }
  const tiered = tieredStore([l1, l2])

  await tiered.set('private-key', utf8.encode('one user'), { class: 'private' })
  assert.notEqual(await l1.get('private-key'), null, 'a process-local tier may hold it')
  assert.equal(await l2.get('private-key'), null, 'a shared tier may not')

  await tiered.set('shared-key', utf8.encode('everyone'), { class: 'shared' })
  assert.notEqual(await l2.get('shared-key'), null)
})

test('a hit deep in the stack fills the tiers above it', async () => {
  const l1 = memoryStore({ name: 'l1' })
  const l2 = memoryStore({ name: 'l2' })
  await l2.set('k', utf8.encode('v'), shared)
  const tiered = tieredStore([l1, l2])
  assert.equal(await l1.get('k'), null)
  assert.notEqual(await tiered.get('k'), null)
  assert.notEqual(await l1.get('k'), null)
})

test('a write reaches every tier and invalidation clears every tier', async () => {
  const l1 = memoryStore({ name: 'l1' })
  const l2 = memoryStore({ name: 'l2' })
  const tiered = tieredStore([l1, l2])
  await tiered.set('k', utf8.encode('v'), { ...shared, tags: ['t'] })
  assert.notEqual(await l1.get('k'), null)
  assert.notEqual(await l2.get('k'), null)
  assert.deepEqual(await tiered.invalidate(['t']), ['k'])
  assert.equal(await l1.get('k'), null)
  assert.equal(await l2.get('k'), null)
})

test('a flag resolver that cannot enumerate its values is refused', () => {
  const flags = staticFlags({ axes: { 'new-cart': ['off', 'on'] } })
  const facts = requestFacts(new Request('https://example.test/'))
  assert.equal(flags.resolve('new-cart', facts), 'off')
  assert.throws(() => flags.resolve('unknown', facts), /E_UNKNOWN_FLAG/)
})

test('a bucket that returns a value off the declared axis is refused', () => {
  const flags = staticFlags({ axes: { tier: ['free', 'paid'] }, bucket: () => 'enterprise' })
  assert.throws(() => flags.resolve('tier', requestFacts(new Request('https://x.test/'))), /E_FLAG_OFF_AXIS/)
})

test('the reachable permutations are enumerable, which is what makes an axis not an explosion', () => {
  assert.deepEqual(permutations({ locale: ['en', 'ar'], tier: ['free', 'paid'] }), [
    { locale: 'en', tier: 'free' },
    { locale: 'en', tier: 'paid' },
    { locale: 'ar', tier: 'free' },
    { locale: 'ar', tier: 'paid' },
  ])
})

test('a session rotates only when it is stale, and only in phase A', async () => {
  const session = cookieSession({ cookie: 'sid', rotateAfterMs: 1000, clock: () => 10_000 })
  const fresh = requestFacts(new Request('https://x.test/', { headers: { cookie: 'sid=u1.9500' } }))
  assert.deepEqual(await session.rotateIfStale?.(fresh), [])

  const stale = requestFacts(new Request('https://x.test/', { headers: { cookie: 'sid=u1.100' } }))
  const rotated = await session.rotateIfStale?.(stale)
  assert.equal(rotated?.length, 1)
  assert.equal(rotated?.[0]?.value, 'u1.10000')
  assert.equal(rotated?.[0]?.httpOnly, true)
})

test('identity comes from the session port and nothing about caching depends on which one', async () => {
  const session = cookieSession({ cookie: 'sid', identify: (t) => `user:${t}` })
  const facts = requestFacts(new Request('https://x.test/', { headers: { cookie: 'sid=abc' } }))
  assert.equal(await session.identity(facts), 'user:abc')
  assert.equal(await session.identity(requestFacts(new Request('https://x.test/'))), null)
})
