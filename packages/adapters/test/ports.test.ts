import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundedDb, DbError, envConfig, hostDeployment, prioScheduler, staticConfig } from '../src/index.ts'
import { collectingTelemetry } from '../src/telemetry.ts'

/**
 * The four ports that were declared and had nothing behind them.
 *
 * Each one is small, and each one is here for the same reason: a port with no implementation is a
 * design document, and a port whose implementation approximates its interface is worse than
 * either. So what is asserted is mostly what these refuse.
 */
test('a scheduler orders a wave by priority, and breaks the tie the same way twice', () => {
  const scheduler = prioScheduler({ maxConcurrency: 3 })
  const wave = [
    { name: 'reviews', prio: 0 },
    { name: 'price', prio: 5 },
    { name: 'breadcrumbs', prio: 0 },
  ]
  assert.deepEqual(
    scheduler.order(wave).map((s) => s.name),
    ['price', 'breadcrumbs', 'reviews'],
    'priority first, then name — so two runs of one plan dispatch identically',
  )
  assert.equal(scheduler.maxConcurrency, 3)
  // The nodes handed back are the nodes handed in: a scheduler reorders, it does not construct.
  assert.equal(scheduler.order(wave)[0], wave[1])
})

test('a setting is answered, and a missing required one is refused by name', () => {
  const config = staticConfig({ DATABASE_URL: 'postgres://localhost/shop', EMPTY: '' })
  assert.equal(config.get('DATABASE_URL'), 'postgres://localhost/shop')
  assert.equal(config.get('NOPE'), undefined)
  assert.equal(config.required('DATABASE_URL'), 'postgres://localhost/shop')
  assert.deepEqual(config.keys(), ['DATABASE_URL', 'EMPTY'])

  assert.throws(() => config.required('NOPE'), /E_CONFIG_MISSING/)
  // Set to nothing is not set. A deployment that exported an empty variable meant to export a
  // value, and starting anyway is how a page ends up talking to the empty string.
  assert.throws(() => config.required('EMPTY'), /E_CONFIG_MISSING/)
})

test('the environment is visible only under its prefix, and asked for without it', () => {
  const config = envConfig({
    env: { WEFT_API: 'https://api.example', AWS_SECRET_ACCESS_KEY: 'not yours', WEFT_: 'odd' },
  })
  assert.equal(config.get('API'), 'https://api.example')
  // The whole reason for the prefix: a fragment asking for a setting cannot reach a credential
  // the process happens to have been started with.
  assert.equal(config.get('AWS_SECRET_ACCESS_KEY'), undefined)
  assert.deepEqual(config.keys(), ['', 'API'])
})

test('a deployment names itself from whatever the host calls a revision', () => {
  const fly = hostDeployment({ env: { GIT_SHA: 'a'.repeat(40), FLY_REGION: 'fra', NODE_ENV: 'production' } })
  assert.equal(fly.revision, 'a'.repeat(12), 'shortened: a revision is read by a person, not scrolled past')
  assert.equal(fly.region, 'fra')
  assert.equal(fly.environment, 'production')

  const laptop = hostDeployment({ env: {} })
  assert.equal(laptop.revision, 'dev', 'a laptop has no build to name, and saying dev is honest')
  assert.equal(laptop.environment, 'development')

  const stated = hostDeployment({ env: { GIT_SHA: 'ignored' }, revision: 'v4', environment: 'preview' })
  assert.equal(stated.revision, 'v4', 'what the deployment says about itself wins')
  assert.equal(stated.environment, 'preview')
})

test('a query is named, timed, and bounded by a deadline somebody chose', async () => {
  const telemetry = collectingTelemetry()
  const db = boundedDb({
    telemetry,
    now: (() => {
      let t = 0
      return () => (t += 7)
    })(),
  })

  const rows = await db.query({ name: 'catalogue.page', tags: ['catalogue'] }, () =>
    Promise.resolve([{ sku: 'RICE-5K' }]),
  )
  assert.deepEqual(rows, [{ sku: 'RICE-5K' }])
  assert.deepEqual(
    db.observed().map((o) => [o.name, o.ms]),
    [['catalogue.page', 7]],
  )
  assert.deepEqual(db.tags(), ['catalogue'], 'what an invalidation can be checked against')
  assert.equal(
    telemetry.measures.some((m) => m.name === 'db.query'),
    true,
  )
})

test('a query that runs past its deadline is a timeout, and says so instead of hanging', async () => {
  const db = boundedDb()
  await assert.rejects(
    () =>
      db.query(
        { name: 'catalogue.slow', timeoutMs: 5 },
        (signal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve('too late'), 1_000)
            signal.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new Error('aborted'))
            })
          }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof DbError)
      assert.equal(error.code, 'E_QUERY_TIMEOUT')
      assert.equal(error.query, 'catalogue.slow')
      return true
    },
  )
  assert.deepEqual(
    db.observed().map((o) => [o.name, o.failed]),
    [['catalogue.slow', true]],
  )
})

test('a query that fails on its own is not reported as a timeout', async () => {
  const db = boundedDb()
  await assert.rejects(
    () => db.query({ name: 'catalogue.broken' }, () => Promise.reject(new Error('relation does not exist'))),
    /relation does not exist/,
    'a database that said no and a database that never answered are different incidents',
  )
})
