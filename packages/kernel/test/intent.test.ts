import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnvelope } from '../src/envelope.ts'
import { createReads, envelopeContext, type EnvelopeContext } from '../src/context.ts'
import { createIntentDispatch, defineIntent, type Intent } from '../src/intent.ts'
import { createIntentRouter, serveIntent } from '../src/intent-http.ts'
import { requestFacts, type Ports, type Registry } from '../src/ports.ts'
import { lifecycle } from '../src/request.ts'
import { cookieSession, memoryStore, staticFlags } from '@weft/adapters'

/**
 * The only thing allowed to write. What is asserted here is mostly what an intent is *not*
 * allowed to do: invalidate a tag it did not declare, run with a capability nobody checked,
 * or fail in a way that looks like success.
 */
function ports(store = memoryStore()): Ports {
  return {
    store,
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    executors: {},
  }
}

function registry(intents: Record<string, Intent<never>>): Registry {
  return {
    name: 'test',
    intent: (id) => intents[id] as Intent | undefined,
    intents: () => Object.keys(intents),
  }
}

function context(p: Ports, cookie = 'sid=u42'): EnvelopeContext {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  const facts = requestFacts(new Request('https://example.test/cart', { headers: { cookie } }))
  return envelopeContext(createReads(facts, p), envelope)
}

const addLine = defineIntent<{ sku: string }>({
  name: 'cart.add',
  writes: ['cart'],
  input: (raw) => {
    const sku = (raw as { sku?: unknown }).sku
    if (typeof sku !== 'string' || !sku) throw new Error('sku is required')
    return { sku }
  },
  async run(ctx, input) {
    await ctx.revalidate('cart')
    return { refresh: ['lines'], data: { added: input.sku } }
  },
})

test('an intent invalidates a declared tag and reports the keys the store dropped', async () => {
  const store = memoryStore()
  const p = ports(store)
  await store.set('cart:u42', new TextEncoder().encode('x'), { class: 'private', tags: ['cart'] })
  const dispatch = createIntentDispatch({ registry: registry({ a1: addLine as Intent<never> }), store })

  const outcome = await dispatch.run('a1', { sku: 'SKU-1' }, context(p))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.invalidated, ['cart'])
  assert.deepEqual(outcome.dropped, ['cart:u42'])
  assert.deepEqual(outcome.refresh, ['lines'])
  assert.deepEqual(outcome.data, { added: 'SKU-1' })
  assert.equal(await store.get('cart:u42'), null)
})

test('a tag the intent did not declare is refused, because unpredictable invalidation is the bug', async () => {
  const sneaky = defineIntent({
    name: 'cart.sneaky',
    writes: ['cart'],
    async run(ctx) {
      await ctx.revalidate('orders')
    },
  })
  const store = memoryStore()
  const dispatch = createIntentDispatch({ registry: registry({ s1: sneaky as Intent<never> }), store })
  const outcome = await dispatch.run('s1', {}, context(ports(store)))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'E_UNDECLARED_WRITE')
  assert.match(outcome.detail ?? '', /orders.*Add it to writes/s)
})

test('an intent declaring a capability with no check bound is refused, not waved through', async () => {
  const guarded = defineIntent({
    name: 'admin.purge',
    writes: ['everything'],
    capabilities: ['admin'],
    run: () => {},
  })
  const store = memoryStore()
  const dispatch = createIntentDispatch({ registry: registry({ g1: guarded as Intent<never> }), store })
  const outcome = await dispatch.run('g1', {}, context(ports(store)))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'E_NO_CAPABILITY_CHECK')
  assert.match(outcome.detail ?? '', /admin/)
})

test('a bound check that says no is a denial, and it names the capability', async () => {
  const guarded = defineIntent({ name: 'admin.purge', writes: ['x'], capabilities: ['admin'], run: () => {} })
  const store = memoryStore()
  const dispatch = createIntentDispatch({
    registry: registry({ g1: guarded as Intent<never> }),
    store,
    capabilities: () => false,
  })
  const outcome = await dispatch.run('g1', {}, context(ports(store)))
  assert.equal(outcome.code, 'E_CAPABILITY_DENIED')
  assert.deepEqual(outcome.invalidated, [], 'a denied intent writes nothing')
})

test('bad input is a 422-shaped refusal, not a crash', async () => {
  const store = memoryStore()
  const dispatch = createIntentDispatch({ registry: registry({ a1: addLine as Intent<never> }), store })
  const outcome = await dispatch.run('a1', { sku: 7 }, context(ports(store)))
  assert.equal(outcome.code, 'E_INTENT_INPUT')
  assert.match(outcome.detail ?? '', /sku is required/)
})

test('an unknown id is named rather than being an empty success', async () => {
  const store = memoryStore()
  const dispatch = createIntentDispatch({ registry: registry({}), store })
  const outcome = await dispatch.run('nope', {}, context(ports(store)))
  assert.equal(outcome.code, 'E_NO_SUCH_INTENT')
  assert.equal(outcome.name, null)
})

test('what an intent invalidated before it threw is still reported', async () => {
  const halfway = defineIntent({
    name: 'cart.halfway',
    writes: ['cart'],
    async run(ctx) {
      await ctx.revalidate('cart')
      throw new Error('the payment provider timed out')
    },
  })
  const store = memoryStore()
  await store.set('cart:u42', new TextEncoder().encode('x'), { class: 'private', tags: ['cart'] })
  const dispatch = createIntentDispatch({ registry: registry({ h1: halfway as Intent<never> }), store })
  const outcome = await dispatch.run('h1', {}, context(ports(store)))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'E_INTENT_FAILED')
  assert.deepEqual(outcome.invalidated, ['cart'], 'the cache is already cold; pretending otherwise is worse')
  assert.deepEqual(outcome.dropped, ['cart:u42'])
})

test('a GET cannot carry a mutation, and the router refuses to be built', () => {
  assert.throws(
    () => createIntentRouter([{ method: 'GET', pattern: '/cart', intent: 'a1' }]),
    /E_INTENT_ON_SAFE_METHOD/,
  )
})

test('the intent router matches on method and path, and specificity still decides', () => {
  const router = createIntentRouter([
    { method: 'POST', pattern: '/cart', intent: 'add' },
    { method: 'DELETE', pattern: '/cart/:line', intent: 'remove' },
    { method: 'POST', pattern: '/cart/new', intent: 'create' },
  ])
  assert.deepEqual(router.match('POST', '/cart'), { intent: 'add', params: {} })
  assert.deepEqual(router.match('POST', '/cart/new'), { intent: 'create', params: {} })
  assert.deepEqual(router.match('DELETE', '/cart/7'), { intent: 'remove', params: { line: '7' } })
  assert.equal(router.match('POST', '/cart/7'), null, 'no POST pattern matches, and no method falls back')
  assert.equal(router.match('GET', '/cart'), null)
})

test('a form post redirects back where it came from, which is the no-JavaScript path', async () => {
  const store = memoryStore()
  const server = serveIntent({
    registry: registry({ a1: addLine as Intent<never> }),
    store,
    ports: ports(store),
    routes: createIntentRouter([{ method: 'POST', pattern: '/cart', intent: 'a1' }]),
  })
  const response = await server.handle(
    new Request('https://example.test/cart', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        referer: 'https://example.test/cart',
      },
      body: 'sku=SKU-9',
    }),
  )
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), 'https://example.test/cart')
  assert.equal(await response.text(), '')
  assert.deepEqual(server.last?.invalidated, ['cart'])
})

test('the same dispatch answers a fetch with the outcome rather than a redirect', async () => {
  const store = memoryStore()
  const server = serveIntent({
    registry: registry({ a1: addLine as Intent<never> }),
    store,
    ports: ports(store),
    routes: createIntentRouter([{ method: 'POST', pattern: '/cart', intent: 'a1' }]),
  })
  const response = await server.handle(
    new Request('https://example.test/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sku: 'SKU-9' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    invalidated: ['cart'],
    refresh: ['lines'],
    data: { added: 'SKU-9' },
  })
})

test('a named refusal becomes the status that describes it', async () => {
  const store = memoryStore()
  const server = serveIntent({
    registry: registry({ a1: addLine as Intent<never> }),
    store,
    ports: ports(store),
    routes: createIntentRouter([{ method: 'POST', pattern: '/cart', intent: 'a1' }]),
  })
  const response = await server.handle(
    new Request('https://example.test/cart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
  assert.equal(response.status, 422)
  assert.equal((await response.json()).code, 'E_INTENT_INPUT')
})
