import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureBudgets } from '../src/budget.ts'

/**
 * A byte budget only survives contact with a feature if exceeding it fails something.
 * This is that something.
 */
test('every entry stays inside its byte budget', async () => {
  const sizes = await measureBudgets()
  assert.equal(sizes.length > 0, true)
  for (const size of sizes) {
    assert.equal(
      size.within,
      true,
      `${size.id} is ${size.brotli} bytes brotli, over its ${size.limit} byte budget (${size.limitNote})`,
    )
  }
})

test('a content route does not pay for the update path it never uses', async () => {
  const sizes = await measureBudgets()
  const content = sizes.find((s) => s.id === 'content-route')
  const full = sizes.find((s) => s.id === 'runtime')
  assert.ok(content && full)
  assert.equal(
    content.brotli < full.brotli,
    true,
    `tree shaking should drop the delta and resident paths: ${content.brotli} vs ${full.brotli}`,
  )
})
