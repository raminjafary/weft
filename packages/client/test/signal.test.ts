import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batch, signal } from '../src/signal.ts'

test('a read returns the value and a write notifies subscribers', () => {
  const count = signal(1)
  const seen: number[] = []
  count.subscribe(() => seen.push(count()))
  count.set(2)
  count.set(3)
  assert.equal(count(), 3)
  assert.deepEqual(seen, [2, 3])
})

test('writing the same value notifies nobody', () => {
  const count = signal(1)
  let runs = 0
  count.subscribe(() => runs++)
  count.set(1)
  assert.equal(runs, 0)
})

test('a batch collapses two writes into one notification', () => {
  const count = signal(0)
  let runs = 0
  count.subscribe(() => runs++)
  batch(() => {
    count.set(1)
    count.set(2)
  })
  assert.equal(runs, 1)
  assert.equal(count(), 2)
})

test('a batch that throws still flushes what it changed', () => {
  const count = signal(0)
  let runs = 0
  count.subscribe(() => runs++)
  assert.throws(() =>
    batch(() => {
      count.set(1)
      throw new Error('boom')
    }),
  )
  assert.equal(runs, 1)
})

test('unsubscribing stops the writes', () => {
  const count = signal(0)
  let runs = 0
  const stop = count.subscribe(() => runs++)
  count.set(1)
  stop()
  count.set(2)
  assert.equal(runs, 1)
})

test('nested batches flush once, at the outermost exit', () => {
  const count = signal(0)
  const runs: number[] = []
  count.subscribe(() => runs.push(count()))
  batch(() => {
    count.set(1)
    batch(() => count.set(2))
    assert.deepEqual(runs, [], 'the inner batch must not flush')
  })
  assert.deepEqual(runs, [2])
})
