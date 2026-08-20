import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quantile, separable, summarize } from '../src/stats.ts'

test('quantiles interpolate rather than round to a neighbour', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([10], 0.99), 10)
})

test('a summary carries the median absolute deviation, not only the standard deviation', () => {
  const s = summarize([10, 10, 10, 10, 400])
  assert.equal(s.p50, 10)
  assert.equal(s.mad, 0)
  assert.equal(s.max, 400)
})

test('overlapping runs are refused as a comparison', () => {
  const a = summarize([10, 11, 12, 11, 10])
  const b = summarize([11, 12, 10, 11, 12])
  assert.equal(separable(a, b), false)
})

test('a difference larger than the noise is allowed as a comparison', () => {
  const a = summarize([10, 10.1, 9.9, 10, 10.05])
  const b = summarize([40, 40.2, 39.8, 40, 40.1])
  assert.equal(separable(a, b), true)
})
