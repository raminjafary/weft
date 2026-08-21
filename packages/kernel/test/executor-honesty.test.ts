import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clientExecutor,
  deferredExecutor,
  inlineExecutor,
  isHardLimit,
  type KernelExecutor,
} from '../src/executor.ts'

/**
 * What an executor claims about itself, gated. Every one of these was a sentence in a comment
 * until `workerPool` made the difference load-bearing: `deferred` declared `kind: 'pool'` and
 * `preemptible: true`, so a reader had two reasons to believe it enforced a budget it cannot
 * enforce against a synchronous loop.
 */
const utf8 = new TextEncoder()

const job = (cpuBudgetMs: number, spin: number) => ({
  slot: 's',
  cpuBudgetMs,
  run: async () => {
    const until = Date.now() + spin
    while (Date.now() < until) {
      /* a synchronous loop: nothing to await, nothing to abort at */
    }
    return utf8.encode('done')
  },
})

test('only a separate crash domain claims a hard limit', () => {
  assert.equal(isHardLimit(inlineExecutor().preemption), false)
  assert.equal(isHardLimit(deferredExecutor().preemption), false)
  assert.equal(inlineExecutor().preemption, 'never')
  assert.equal(deferredExecutor().preemption, 'at-await')
})

test('deferred does not claim to be a pool, because it is not one', () => {
  // It is a macrotask boundary on the request thread. Naming it `pool` put it in the same
  // category as the thing that can actually stop a render.
  assert.equal(deferredExecutor().kind, 'inline')
  assert.equal(inlineExecutor().kind, 'inline')
  assert.equal(clientExecutor().kind, 'client')
})

test('a breach on each executor says whether the work was actually stopped', async () => {
  const cases: [KernelExecutor, RegExp][] = [
    [inlineExecutor(), /cannot be interrupted, so it ran to completion anyway/],
    [deferredExecutor(), /interruptible only at an await, so a synchronous render ran to completion/],
  ]
  for (const [executor, expected] of cases) {
    const outcome = await executor.run(job(20, 60))
    assert.equal(outcome.failure?.code, 'E_CPU_BUDGET', executor.name)
    assert.match(outcome.failure?.message ?? '', expected, executor.name)
    assert.ok(outcome.bytes.length > 0, `${executor.name} finished the work despite the budget`)
  }
})
