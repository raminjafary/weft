import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Adopted } from '../src/adopt.ts'
import { createEpochs } from '../src/epoch.ts'
import type { ClientTemplate, Json } from '../src/template.ts'

const template: ClientTemplate = { version: 'a'.repeat(32), holes: [], wiring: [] }

interface Stub extends Adopted {
  written: [string, Json][]
}

function stub(): Stub {
  const written: [string, Json][] = []
  const node: Stub = {
    template,
    instances: {},
    rows: [],
    written,
    target: () => undefined,
    targets: () => [],
    write: (binding, value) => {
      written.push([binding, value])
    },
  }
  return node
}

const delta = (changed: Record<string, Json>) => ({ tpl: template.version, base: 'b', changed })

test('a staged epoch paints nothing', async () => {
  const epochs = createEpochs()
  const region = stub()
  epochs.stage('e7', { slot: 's12', adopted: region, delta: delta({ total: '12,400' }) })
  assert.deepEqual(region.written, [])
  assert.deepEqual(epochs.staged('e7'), ['s12'])
})

test('a commit flips every slot in the epoch at once', async () => {
  const epochs = createEpochs()
  const prices = stub()
  const cart = stub()
  epochs.stage('e7', { slot: 'prices', adopted: prices, delta: delta({ total: '12,400' }) })
  epochs.stage('e7', { slot: 'cart', adopted: cart, delta: delta({ count: 3 }) })

  const result = await epochs.commit('e7')
  assert.equal(result.writes, 2)
  assert.deepEqual(result.slots, ['prices', 'cart'])
  assert.deepEqual(prices.written, [['total', '12,400']])
  assert.deepEqual(cart.written, [['count', 3]])
  assert.deepEqual(epochs.open, [])
})

test('prefetching into another epoch cannot disturb the one being looked at', async () => {
  const epochs = createEpochs()
  const region = stub()
  epochs.stage('live-ish', { slot: 's', adopted: region, delta: delta({ total: 1 }) })
  epochs.stage('next', { slot: 's', adopted: region, delta: delta({ total: 999 }) })

  await epochs.commit('live-ish')
  assert.deepEqual(region.written, [['total', 1]])
  assert.deepEqual(epochs.open, ['next'])
})

test('a later frame for the same slot supersedes the earlier one rather than queueing a write', async () => {
  const epochs = createEpochs()
  const region = stub()
  epochs.stage('e7', { slot: 's', adopted: region, delta: delta({ total: 1 }) })
  epochs.stage('e7', { slot: 's', adopted: region, delta: delta({ total: 2 }) })
  const result = await epochs.commit('e7')
  assert.equal(result.writes, 1)
  assert.deepEqual(region.written, [['total', 2]])
})

test('a rollback is discarding the epoch, with nothing to reconstruct', async () => {
  const epochs = createEpochs()
  const region = stub()
  epochs.stage('optimistic', { slot: 's', adopted: region, delta: delta({ total: 1 }) })
  assert.equal(epochs.discard('optimistic'), 1)
  const result = await epochs.commit('optimistic')
  assert.equal(result.writes, 0)
  assert.deepEqual(region.written, [])
})

test('a view transition wraps the commit where the engine has one', async () => {
  let wrapped = false
  const host = {
    startViewTransition(callback: () => void) {
      wrapped = true
      callback()
      return { finished: Promise.resolve() }
    },
  }
  const epochs = createEpochs(host)
  const region = stub()
  epochs.stage('e7', { slot: 's', adopted: region, delta: delta({ total: 1 }) })
  const result = await epochs.commit('e7', { transition: true })
  assert.equal(wrapped, true)
  assert.equal(result.animated, true)
  assert.deepEqual(region.written, [['total', 1]])
})

test('without view transitions the commit still happens, it is just instant', async () => {
  const epochs = createEpochs({})
  const region = stub()
  epochs.stage('e7', { slot: 's', adopted: region, delta: delta({ total: 1 }) })
  const result = await epochs.commit('e7', { transition: true })
  assert.equal(result.animated, false)
  assert.deepEqual(region.written, [['total', 1]])
})
