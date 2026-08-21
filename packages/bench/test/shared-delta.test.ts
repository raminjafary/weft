import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureSharedDelta } from '../src/measure/shared-delta.ts'
import { scenario } from '../src/workloads/index.ts'

/**
 * Phase 6's claim, gated. The mechanism has existed since the surgical-refresh work and the
 * comparison had never been run, which meant "beating LiveView on shared-delta efficiency" was
 * an argument rather than a number.
 */
test('a thousand clients on one base render cost one delta computation', async () => {
  const report = await measureSharedDelta(scenario('feed'), 200)
  const aligned = report.results.filter((r) => r.arrival === 'aligned')
  const perConnection = aligned.find((r) => r.strategy === 'per-connection')
  const shared = aligned.find((r) => r.strategy === 'shared')

  assert.equal(perConnection?.computations, 200, 'a per-connection differ has no way to share one')
  assert.equal(shared?.computations, 1, 'and a transition-keyed one computes it once')
  assert.equal(shared?.memoized, 199)
  assert.equal(
    shared?.bytesDelivered,
    perConnection?.bytesDelivered,
    'the same bytes reach the same clients; only the computing differs',
  )
})

/**
 * The case that does not favour us, asserted so it cannot quietly become the headline number.
 * Clients each holding a different base share nothing, and the shared path then does the same N
 * diffs plus a store read and a write for each.
 */
test('clients each on their own base render share nothing, and the cost is stated', async () => {
  const report = await measureSharedDelta(scenario('feed'), 200)
  const staggered = report.results.filter((r) => r.arrival === 'staggered')
  const perConnection = staggered.find((r) => r.strategy === 'per-connection')
  const shared = staggered.find((r) => r.strategy === 'shared')

  assert.equal(shared?.computations, perConnection?.computations, 'parity on the expensive part')
  assert.ok(
    (shared?.storeReads ?? 0) > 0,
    'and strictly more work than per-connection, because of the store round trips',
  )
  assert.equal(perConnection?.storeReads, 0)
})

test('the transition being measured actually changes something', async () => {
  const report = await measureSharedDelta(scenario('feed'), 4)
  assert.ok(report.changedRows > 0, 'a transition that changes nothing would make every number a lie')
  assert.ok(report.changedRows < report.totalRows, 'and one that changes everything would too')
})
