import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leaseCoalescer } from '../src/coalesce.ts'
import { memoryStore } from '@weft/adapters'

/**
 * Two concurrent misses on one key. The lease was implemented and tested a session ago and
 * nothing took one, so the behaviour a cache exists to provide — one render, N deliveries —
 * had never been asserted.
 */
const utf8 = new TextEncoder()

test('two concurrent misses render once, and the loser is handed the winner result', async () => {
  const store = memoryStore()
  const coalesce = leaseCoalescer(store, { pollMs: 2 })
  let renders = 0

  const render = async (): Promise<Uint8Array> => {
    renders++
    await new Promise((resolve) => setTimeout(resolve, 20))
    const bytes = utf8.encode('rendered')
    await store.set('k', bytes, { class: 'shared' })
    return bytes
  }

  const [a, b] = await Promise.all([coalesce('k', render), coalesce('k', render)])
  assert.equal(renders, 1, 'the expensive part happened once')
  assert.equal(a?.waited === true || b?.waited === true, true, 'one of them waited')
  assert.equal(a?.waited === false || b?.waited === false, true, 'and one of them rendered')
  assert.deepEqual(new TextDecoder().decode(a?.bytes), 'rendered')
  assert.deepEqual(new TextDecoder().decode(b?.bytes), 'rendered')
})

test('a waiter whose wait expires renders too, rather than hanging behind a dead renderer', async () => {
  const store = memoryStore()
  // Somebody holds the lease and will never fill it: a renderer that crashed, or a process
  // that was evicted mid-render.
  await store.lease('k', 60_000)
  const coalesce = leaseCoalescer(store, { waitMs: 30, pollMs: 5 })
  let renders = 0

  const result = await coalesce('k', async () => {
    renders++
    return utf8.encode('mine')
  })
  assert.equal(renders, 1, 'a duplicated render beats a request that never answers')
  assert.equal(result.waited, false)
  assert.equal(new TextDecoder().decode(result.bytes), 'mine')
})

test('a render that throws releases the lease, so the TTL is only a backstop for a dead process', async () => {
  const store = memoryStore()
  const coalesce = leaseCoalescer(store, { leaseMs: 60_000, pollMs: 2 })
  await assert.rejects(() =>
    coalesce('k', async () => {
      throw new Error('the upstream is down')
    }),
  )
  // Held leases are invisible except through their effect: the next caller gets one.
  const next = await store.lease('k', 1_000)
  assert.notEqual(next, null, 'a thrown render did not leave the key locked for a minute')
})

test('a waiter that finds the fill immediately does not pay the whole poll interval', async () => {
  const store = memoryStore()
  await store.lease('k', 60_000)
  await store.set('k', utf8.encode('already there'), { class: 'shared' })
  const coalesce = leaseCoalescer(store, { waitMs: 5_000, pollMs: 5 })
  const started = Date.now()
  const result = await coalesce('k', async () => utf8.encode('should not run'))
  assert.equal(result.waited, true)
  assert.equal(new TextDecoder().decode(result.bytes), 'already there')
  assert.ok(Date.now() - started < 1_000, 'one poll, not the full wait')
})
