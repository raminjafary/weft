import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isHardLimit } from '@weft/kernel'
import { collectingTelemetry } from '../src/telemetry.ts'
import { workerPool } from '../src/worker-pool.ts'

/**
 * The executor kind that makes a CPU budget a limit. Every other executor in this codebase
 * says honestly that a budget is advisory on it; the assertion worth having here is the one
 * about a synchronous loop, because that is the case a cooperative signal cannot touch.
 */
const RENDERERS = fileURLToPath(new URL('../fixtures/renderers.ts', import.meta.url))

const job = (slot: string, exportName: string, props?: unknown, cpuBudgetMs?: number) => ({
  slot,
  address: { module: RENDERERS, export: exportName, ...(props !== undefined ? { props } : {}) },
  ...(cpuBudgetMs !== undefined ? { cpuBudgetMs } : {}),
  run: async () => {
    throw new Error('a pooled job must never fall back to the request thread')
  },
})

test('a named export in another thread renders, and its bytes come back', async () => {
  const pool = workerPool({ size: 1 })
  try {
    const outcome = await pool.run(job('greeting', 'greeting', { name: 'Baghdad' }))
    assert.equal(outcome.failure, undefined)
    assert.equal(new TextDecoder().decode(outcome.bytes), '<p>hello Baghdad</p>')
  } finally {
    await pool.close()
  }
})

test('a renderer returning bytes rather than a string is passed through unchanged', async () => {
  const pool = workerPool({ size: 1 })
  try {
    const outcome = await pool.run(job('raw', 'bytes'))
    assert.equal(new TextDecoder().decode(outcome.bytes), '<p>raw</p>')
  } finally {
    await pool.close()
  }
})

test('a slot with no address is refused by name, not quietly run on the request thread', async () => {
  const pool = workerPool({ size: 1 })
  try {
    const outcome = await pool.run({
      slot: 'inline-only',
      run: async () => new TextEncoder().encode('nope'),
    })
    assert.equal(outcome.failure?.code, 'E_JOB_NOT_ADDRESSABLE')
    assert.match(outcome.failure?.message ?? '', /closure cannot cross a thread boundary/)
    assert.equal(outcome.bytes.length, 0, 'and it did not render anyway')
  } finally {
    await pool.close()
  }
})

test('a synchronous loop over its CPU budget is killed, which no other executor can do', async () => {
  const telemetry = collectingTelemetry()
  const pool = workerPool({ size: 1, telemetry })
  try {
    const outcome = await pool.run(job('spinner', 'spin', { ms: 5_000 }, 100))
    assert.equal(outcome.failure?.code, 'E_CPU_BUDGET')
    assert.match(outcome.failure?.message ?? '', /worker was terminated/)
    assert.ok(outcome.ms < 3_000, `killed after ${Math.round(outcome.ms)}ms rather than run to completion`)
    assert.equal(pool.replaced, 1, 'killing a render costs the worker, and that is counted')
    assert.equal(pool.size, 1, 'and the pool is back to strength')
  } finally {
    await pool.close()
  }
})

test('the pool keeps working after a budget kill', async () => {
  const pool = workerPool({ size: 1 })
  try {
    await pool.run(job('spinner', 'spin', { ms: 5_000 }, 80))
    const after = await pool.run(job('greeting', 'greeting', { name: 'again' }))
    assert.equal(after.failure, undefined)
    assert.equal(new TextDecoder().decode(after.bytes), '<p>hello again</p>')
  } finally {
    await pool.close()
  }
})

test('a renderer that throws degrades the slot and leaves its worker alive', async () => {
  const pool = workerPool({ size: 1 })
  try {
    const outcome = await pool.run(job('boom', 'explode'))
    assert.equal(outcome.failure?.code, 'E_SLOT_FAILED')
    assert.match(outcome.failure?.message ?? '', /the renderer threw/)
    assert.equal(pool.replaced, 0, 'an exception is not a crash domain event')
    const after = await pool.run(job('greeting', 'greeting'))
    assert.equal(after.failure, undefined)
  } finally {
    await pool.close()
  }
})

test('an export that is not callable is named rather than invoked', async () => {
  const pool = workerPool({ size: 1 })
  try {
    const outcome = await pool.run(job('bad', 'notAFunction'))
    assert.match(outcome.failure?.message ?? '', /E_NO_SUCH_EXPORT.*notAFunction/s)
  } finally {
    await pool.close()
  }
})

test('more jobs than workers queue rather than spawning threads', async () => {
  const pool = workerPool({ size: 2 })
  try {
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => pool.run(job(`s${i}`, 'greeting', { name: `n${i}` }))),
    )
    assert.equal(pool.size, 2)
    assert.deepEqual(
      outcomes.map((o) => new TextDecoder().decode(o.bytes)),
      Array.from({ length: 6 }, (_, i) => `<p>hello n${i}</p>`),
    )
  } finally {
    await pool.close()
  }
})

test('the pool is the only executor that claims a hard limit, and it earns it', () => {
  const pool = workerPool({ size: 1 })
  assert.equal(pool.preemption, 'always')
  assert.equal(isHardLimit(pool.preemption), true)
  assert.equal(pool.kind, 'pool')
  void pool.close()
})

test('a closed pool refuses rather than hanging', async () => {
  const pool = workerPool({ size: 1 })
  await pool.close()
  const outcome = await pool.run(job('after', 'greeting'))
  assert.equal(outcome.failure?.code, 'E_POOL_CLOSED')
})
