import assert from 'node:assert/strict'
import { test } from 'node:test'
import { digest, heldBy, isHeld, openResident } from '../src/resident.ts'

const A = 'a1b2c3d4'.repeat(4)
const B = 'f0f0f0f0'.repeat(4)

test('a digest is a sorted list of prefixes, not the versions themselves', () => {
  const value = digest([B, A])
  assert.equal(value, `${A.slice(0, 8)},${B.slice(0, 8)}`)
  assert.equal(value.includes(A), false, 'a full version must not travel')
})

test('a digest round-trips through the held set', () => {
  const held = heldBy(digest([A, B]))
  assert.equal(isHeld(held, A), true)
  assert.equal(isHeld(held, B), true)
  assert.equal(isHeld(held, 'c'.repeat(32)), false)
})

test('an empty digest holds nothing, so every visit is a first visit', () => {
  const held = heldBy('')
  assert.equal(held.size, 0)
  assert.equal(isHeld(held, A), false)
})

test('without IndexedDB the store degrades to memory rather than failing', async () => {
  const store = await openResident()
  assert.equal(store.durable, false, 'there is no IndexedDB in node')
  assert.deepEqual(await store.all(), {})
  await store.put({ version: A, holes: [], wiring: [] })
  assert.deepEqual(Object.keys(await store.all()), [A])
})
