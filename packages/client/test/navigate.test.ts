import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStaging, navigable, plainClick, stagingKey } from '../src/navigate.ts'

const HERE = 'https://shop.example/app/cart'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('staging a route fetches it and paints nothing the caller did not ask for', async () => {
  const loaded: string[] = []
  const staging = createStaging<string>({
    load: (url) => {
      loaded.push(url)
      return Promise.resolve(`<main>${url}</main>`)
    },
  })

  await staging.stage('/a')
  assert.deepEqual(loaded, ['/a'])
  assert.equal(staging.state('/a'), 'ready')
  assert.equal(staging.ready('/a'), '<main>/a</main>')
  assert.deepEqual(staging.open, ['/a'])
})

test('two stagings of the same route are one request', async () => {
  let calls = 0
  const gate = deferred<string>()
  const staging = createStaging<string>({
    load: () => {
      calls++
      return gate.promise
    },
  })

  const first = staging.stage('/a')
  const second = staging.stage('/a')
  gate.resolve('page')
  assert.deepEqual(await Promise.all([first, second]), ['page', 'page'])
  assert.equal(calls, 1)
})

test('a claim on a staged route is instant, and one on an unstaged route says so', async () => {
  const staging = createStaging<string>({ load: (url) => Promise.resolve(`page:${url}`) })

  await staging.stage('/a')
  assert.deepEqual(await staging.claim('/a'), { value: 'page:/a', how: 'staged' })
  // Spent: the page it describes is now the page, so holding the markup is a second copy.
  assert.deepEqual(staging.open, [])

  assert.deepEqual(await staging.claim('/b'), { value: null, how: 'cold' })
  assert.equal(staging.staged, 1)
  assert.equal(staging.cold, 1)
})

test('a claim that arrives mid-flight waits for the answer rather than starting a second one', async () => {
  let calls = 0
  const gate = deferred<string>()
  const staging = createStaging<string>({
    load: () => {
      calls++
      return gate.promise
    },
  })

  void staging.stage('/a')
  const claim = staging.claim('/a')
  gate.resolve('page')
  assert.deepEqual(await claim, { value: 'page', how: 'awaited' })
  assert.equal(calls, 1)
  assert.equal(staging.awaited, 1)
})

test('a load that fails is a cold claim, not a blank page', async () => {
  const staging = createStaging<string>({ load: () => Promise.reject(new Error('offline')) })

  assert.equal(await staging.stage('/a'), null)
  assert.equal(staging.state('/a'), 'failed')
  assert.equal(staging.ready('/a'), undefined)
  assert.deepEqual(await staging.claim('/a'), { value: null, how: 'cold' })
})

test('a resolved answer expires rather than painting a render from long ago', async () => {
  let clock = 1_000
  const staging = createStaging<string>({
    load: () => Promise.resolve('page'),
    ttlMs: 5_000,
    now: () => clock,
  })

  await staging.stage('/a')
  clock += 4_999
  assert.equal(staging.ready('/a'), 'page')
  clock += 2
  assert.equal(staging.ready('/a'), undefined)
  assert.equal(staging.state('/a'), 'none')
  assert.deepEqual(await staging.claim('/a'), { value: null, how: 'cold' })
})

test('staging is bounded, and the oldest route goes first', async () => {
  const aborted: string[] = []
  const staging = createStaging<string>({
    max: 2,
    load: (url, signal) => {
      signal.addEventListener('abort', () => aborted.push(url))
      return Promise.resolve(url)
    },
  })

  await staging.stage('/a')
  await staging.stage('/b')
  await staging.stage('/c')
  assert.deepEqual(staging.open, ['/b', '/c'])
  assert.deepEqual(aborted, ['/a'])
})

test('discarding a staged route aborts the request nobody is going to read', async () => {
  const aborted: string[] = []
  const staging = createStaging<string>({
    load: (url, signal) => {
      signal.addEventListener('abort', () => aborted.push(url))
      return deferred<string>().promise
    },
  })

  void staging.stage('/a')
  assert.equal(staging.discard('/a'), true)
  assert.deepEqual(aborted, ['/a'])
  assert.deepEqual(staging.open, [])
  assert.equal(staging.discard('/a'), false)
})

test('an aborted load that answers anyway is not an answer', async () => {
  const gate = deferred<string>()
  const staging = createStaging<string>({ load: () => gate.promise })

  const settled = staging.stage('/a')
  staging.discard('/a')
  gate.resolve('too late')
  assert.equal(await settled, null)
  assert.equal(staging.ready('/a'), undefined)
})

test('what the framework may answer itself, and what belongs to the browser', () => {
  assert.equal(navigable({ href: '/app/feed' }, HERE), true)
  assert.equal(navigable({ href: 'https://shop.example/app/feed' }, HERE), true)

  assert.equal(navigable({ href: 'https://elsewhere.example/' }, HERE), false)
  assert.equal(navigable({ href: 'mailto:hello@shop.example' }, HERE), false)
  assert.equal(navigable({ href: '/app/feed', target: '_blank' }, HERE), false)
  assert.equal(navigable({ href: '/invoice.pdf', download: true }, HERE), false)
  assert.equal(navigable({ href: '/app/feed', rel: 'noopener external' }, HERE), false)
  // The browser's own scrolling. Swapping would throw away the position it is moving to.
  assert.equal(navigable({ href: '#totals' }, HERE), false)
  // The same page with different parameters is a navigation, hash or no hash.
  assert.equal(navigable({ href: '/app/cart?currency=IQD#totals' }, HERE), true)

  assert.equal(plainClick({}), true)
  assert.equal(plainClick({ modified: true }), false)
  assert.equal(plainClick({ button: 1 }), false)
})

test('a staged route is keyed by what the server will be asked, fragment excluded', () => {
  assert.equal(stagingKey('/app/feed#latest', HERE), 'https://shop.example/app/feed')
  assert.equal(stagingKey('/app/feed', HERE), stagingKey('/app/feed#latest', HERE))
  assert.notEqual(stagingKey('/app/feed?page=2', HERE), stagingKey('/app/feed', HERE))
})
