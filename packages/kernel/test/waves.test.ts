import assert from 'node:assert/strict'
import { test } from 'node:test'
import { criticalPath, degrade, dispatch, inlineExecutor, schedule, type DagNode } from '../src/index.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/** The design's own example: existence dependency is not declared, data dependency is. */
const PAGE: DagNode[] = [
  { name: 'shell', ms: 0.2 },
  { name: 'header', ms: 0.3 },
  { name: 'breadcrumbs', ms: 1.1 },
  { name: 'product-core', ms: 28.4 },
  { name: 'reviews', ms: 31.2 },
  { name: 'recommendations', ms: 44.8, optional: true },
  { name: 'price-box', needs: ['product-core'], ms: 12.1 },
  { name: 'review-summary', needs: ['reviews'], ms: 3 },
  { name: 'buy-panel', needs: ['price-box'], ms: 2.2 },
]

test('independent slots land in one wave, not one after another', () => {
  const { waves, width } = schedule(PAGE)
  assert.equal(waves.length, 3)
  assert.deepEqual(waves[0], ['breadcrumbs', 'header', 'product-core', 'recommendations', 'reviews', 'shell'])
  assert.equal(width, 6)
})

test('priority decides order inside a wave, never which wave', () => {
  const { waves } = schedule([
    { name: 'a', prio: 0 },
    { name: 'b', prio: 5 },
    { name: 'c', needs: ['b'], prio: 9 },
  ])
  assert.deepEqual(waves, [['b', 'a'], ['c']])
})

test('the critical path is the floor, and it is not the sum', () => {
  const path = criticalPath(PAGE)
  assert.deepEqual(path.path, ['product-core', 'price-box', 'buy-panel'])
  assert.equal(Number(path.ms.toFixed(1)), 42.7)
  assert.equal(Number(path.sequentialMs.toFixed(1)), 123.3)
})

test('a cycle is named rather than deadlocked', () => {
  assert.throws(
    () =>
      schedule([
        { name: 'a', needs: ['b'] },
        { name: 'b', needs: ['a'] },
      ]),
    /E_PLAN_CYCLE.*a -> b/s,
  )
})

test('a dependency on a slot that is not in the plan is refused', () => {
  assert.throws(() => schedule([{ name: 'a', needs: ['ghost'] }]), /E_UNKNOWN_SLOT/)
})

test('concurrency is capped, because forty parallel queries melt a database', async () => {
  let live = 0
  let peak = 0
  const nodes: DagNode[] = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}` }))
  await dispatch(nodes, {
    maxConcurrency: 3,
    run: async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 1))
      live--
    },
  })
  assert.equal(peak, 3)
})

test('a slot that needs another runs strictly after it', async () => {
  const order: string[] = []
  await dispatch([{ name: 'core' }, { name: 'price', needs: ['core'] }, { name: 'buy', needs: ['price'] }], {
    maxConcurrency: 4,
    run: async (node) => {
      order.push(node.name)
    },
  })
  assert.deepEqual(order, ['core', 'price', 'buy'])
})

test('an inline executor reports a budget breach even though it could not stop it', async () => {
  const outcome = await inlineExecutor().run({
    slot: 'report',
    cpuBudgetMs: 5,
    run: async () => {
      await new Promise((r) => setTimeout(r, 25))
      return new TextEncoder().encode('done')
    },
  })
  assert.equal(outcome.failure?.code, 'E_CPU_BUDGET')
  assert.match(outcome.failure?.message ?? '', /cannot be interrupted, so it ran to completion anyway/)
  assert.equal(new TextDecoder().decode(outcome.bytes), 'done')
})

test('a slot that throws degrades; the request does not fail', async () => {
  const outcome = await inlineExecutor().run({
    slot: 'reviews',
    run: async () => {
      throw new Error('upstream down')
    },
  })
  assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
  assert.equal(outcome.bytes.length, 0)
})

test('every onExceed policy produces something, except the one that says fail', () => {
  const stale = new TextEncoder().encode('old')
  const placeholder = new TextEncoder().encode('...')
  const failure = { code: 'E_CPU_BUDGET', message: 'over' }

  assert.equal(decode(degrade({ slot: 's', policy: 'stale', stale, placeholder }, failure)), 'old')
  assert.equal(decode(degrade({ slot: 's', policy: 'stale', placeholder }, failure)), '...')
  assert.equal(decode(degrade({ slot: 's', policy: 'placeholder', placeholder }, failure)), '...')
  assert.equal(decode(degrade({ slot: 's', policy: 'client', placeholder }, failure)), '...')
  assert.throws(() => degrade({ slot: 's', policy: 'fail' }, failure), /E_CPU_BUDGET \[s\]/)
})
