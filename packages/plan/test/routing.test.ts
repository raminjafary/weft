import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from '../../adapters/src/memory-store.ts'
import { cookieSession } from '../../adapters/src/session.ts'
import { staticFlags } from '../../adapters/src/flags.ts'
import { createKernel, type Ports } from '../../kernel/src/index.ts'
import { compileFixture, LINES, SHELL } from '../../kernel/fixtures/cart-route.ts'
import { cart, facts, LINES_ID, SHELL_ID } from '../fixtures/cart.ts'
import { cartBindings, guards, productBindings, routes } from '../fixtures/bindings.ts'
import { lowerPlan, plan, shell, slot } from '../src/index.ts'

/**
 * A plan becoming a route, and a request finding it.
 *
 * This is the seam the last phase left open: the kernel took a hand-assembled `KernelRoute`
 * and the plan layer produced a `Plan`, and nothing joined them. Everything asserted here is
 * a consequence of the two agreeing rather than of either restating the other.
 */
function ports(store = memoryStore()): Ports {
  return {
    store,
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
    executors: {},
  }
}

const get = (path: string, cookie = '') =>
  new Request(`https://example.test${path}`, {
    headers: { cookie, 'accept-language': 'ar-IQ' },
  })

test('a plan lowers to a route that carries the shell, the slots and the concurrency ceiling', async () => {
  const resolve = lowerPlan(cart, { facts: await facts() }, await cartBindings())
  const route = await resolve({})
  const shellIr = (await compileFixture(SHELL)).entry

  assert.equal(route.path, '/cart')
  assert.equal(route.template.version, shellIr.version)
  assert.equal(route.shell?.id, SHELL_ID)
  assert.deepEqual(route.shell?.effects, shellIr.effects)
  assert.equal(route.maxConcurrency, 4)
  assert.deepEqual(
    route.slots.map((s) => s.name),
    ['cartLines', 'recs'],
  )
})

test('every slot carries the identity and effects the compiler gave its fragment', async () => {
  const route = await (await lowerPlan(cart, { facts: await facts() }, await cartBindings()))({})
  const lines = route.slots.find((s) => s.name === 'cartLines')
  assert.equal(lines?.id, 'packages/compiler/fixtures/keyed.tsx#default')
  assert.ok(lines?.effects.reads.includes('time'), 'the effects came from the compiler, not the plan')
  // The plan said public with a ttl; nothing here mentions a key.
  assert.equal(lines?.policy?.class, 'public')
  assert.equal(lines?.policy?.ttlMs, 60_000)
  assert.deepEqual(lines?.policy?.tags, ['prices'])
  assert.equal(route.slots.find((s) => s.name === 'recs')?.policy?.class, 'private')
})

test('a budget and an executor cross the seam intact', async () => {
  const p = plan('/x', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).executor('pool:heavy').budget({ cpu: '120ms', onExceed: 'stale' }),
    slot('recs').fragment(LINES_ID).needs('cartLines').stream({ prio: 3 }),
  ])
  const bindings = await productBindings()
  const route = await (await lowerPlan(p, { facts: await facts() }, bindings))({})
  const heavy = route.slots[0]
  assert.equal(heavy?.executor, 'pool:heavy')
  assert.equal(heavy?.cpuBudgetMs, 120)
  assert.equal(heavy?.onExceed, 'stale')
  assert.deepEqual(route.slots[1]?.needs, ['cartLines'])
  assert.equal(route.slots[1]?.prio, 3)
})

test('the streaming order is derived from the plan, not defaulted', async () => {
  const streamed = await (await lowerPlan(cart, { facts: await facts() }, await cartBindings()))({})
  assert.equal(streamed.order, 'out-of-order')

  const { quiet } = await import('../fixtures/cart.ts')
  const { quietBindings } = await import('../fixtures/bindings.ts')
  const buffered = await (await lowerPlan(quiet, { facts: await facts() }, await quietBindings()))({})
  assert.equal(buffered.order, 'in-order', 'no slot asked to stream, so nothing pays for a filler')
})

test('an invalid plan cannot become a route at all', async () => {
  const broken = plan('/x', [shell(SHELL_ID), slot('cartLines').fragment(LINES_ID)])
  await assert.rejects(
    async () => lowerPlan(broken, { facts: await facts() }, await productBindings()),
    /E_PLAN_INVALID[\s\S]*E_SHELL_HOLE_UNFILLED/,
  )
})

test('a slot with no binding is refused, because there would be nothing to render', async () => {
  const bindings = await cartBindings()
  await assert.rejects(
    async () =>
      lowerPlan(
        cart,
        { facts: await facts() },
        { ...bindings, slots: { cartLines: bindings.slots.cartLines! } },
      ),
    /E_SLOT_UNBOUND.*recs/s,
  )
})

test('a guard with no handler is refused, because it would silently pass', async () => {
  const bindings = await cartBindings()
  await assert.rejects(
    async () => lowerPlan(cart, { facts: await facts() }, { ...bindings, guards: {} }),
    /E_UNKNOWN_GUARD.*session.required/s,
  )
})

test('serve matches a path, renders the plan, and derives the headers from it', async () => {
  const kernel = createKernel({ ports: ports(), routes: await routes() })
  const response = await kernel.serve(get('/cart', 'sid=u42; currency=IQD'))
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.deepEqual(kernel.trace?.matched, { pattern: '/cart', params: {} })
  assert.match(body, /<title>Your cart — Souq<\/title>/)
  assert.match(body, /<!>IQD<!> · <!>baghdad<!>/)
  assert.match(body, /Welcome back, <!>u42<!>/)
  // keyed.tsx reads a cookie and a header; private.tsx reads identity.
  assert.equal(response.headers.get('vary'), 'Accept-Language, Cookie, X-Tier')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})

test('a param reaches the shell as data and the fragment as a key component', async () => {
  const kernel = createKernel({ ports: ports(), routes: await routes() })
  const response = await kernel.serve(get('/product/basmati'))
  const body = await response.text()

  assert.deepEqual(kernel.trace?.matched, { pattern: '/product/:sku', params: { sku: 'basmati' } })
  assert.match(body, /<title>basmati — Souq<\/title>/)
  assert.match(body, /basmati — 5kg/)
})

test('a guard declared in the plan runs in phase A and nothing renders', async () => {
  const kernel = createKernel({ ports: ports(), routes: await routes() })
  const response = await kernel.serve(get('/cart'))
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login')
  assert.equal(response.body, null)
  assert.deepEqual(kernel.trace?.states, ['received', 'envelope', 'planned', 'settled'])
})

test('a guard that refuses without a redirect ends the request with no body', async () => {
  const p = plan('/product/:sku', [
    shell(SHELL_ID),
    { name: 'session.required', status: 403 },
    slot('cartLines').fragment(LINES_ID),
    slot('recs').fragment(LINES_ID),
  ])
  const resolve = lowerPlan(p, { facts: await facts() }, { ...(await productBindings()), guards })
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(get('/product/rice'), await resolve({ sku: 'rice' }))
  assert.equal(response.status, 403)
  assert.equal(response.body, null)
})

test('the shell contributes its own reads to the document, not only its slots', async () => {
  // shell.tsx reads nothing, so the assertion worth making is that its key is resolved at all
  // and that the union includes it rather than silently skipping it.
  const kernel = createKernel({ ports: ports(), routes: await routes() })
  await (await kernel.serve(get('/product/rice'))).text()
  assert.equal(kernel.trace?.document?.class, 'static')
  assert.equal(kernel.trace?.document?.key !== null, true)
})

test('an unmatched path is a 404, and nothing was planned', async () => {
  const kernel = createKernel({ ports: ports(), routes: await routes() })
  const response = await kernel.serve(get('/nope'))
  assert.equal(response.status, 404)
  assert.deepEqual(kernel.trace?.keys, {})
  assert.equal(kernel.trace?.matched, null)
})

test('serve without a route table says so rather than guessing', async () => {
  const kernel = createKernel({ ports: ports() })
  await assert.rejects(() => kernel.serve(get('/cart')), /E_NO_ROUTES/)
})

test('the second request for the same path hits the store for the slot that declared a policy', async () => {
  const store = memoryStore()
  const kernel = createKernel({ ports: ports(store), routes: await routes() })
  await (await kernel.serve(get('/cart', 'sid=u42; currency=IQD'))).text()
  assert.deepEqual(kernel.trace?.hits, [])
  await (await kernel.serve(get('/cart', 'sid=u42; currency=IQD'))).text()
  // Both, because `.cache('private')` is still a policy: a private entry keyed by identity in
  // a process-local tier is legitimate, and it is a tiered store's job to keep it there.
  assert.deepEqual(kernel.trace?.hits, ['cartLines', 'recs'])
})

test('a different param is a different key, so it renders again', async () => {
  const store = memoryStore()
  const p = plan('/product/:sku', [
    shell(SHELL_ID),
    slot('cartLines').fragment(LINES_ID).cache('public', { ttl: '60s' }),
    slot('recs').fragment(LINES_ID),
  ])
  // lines.tsx reads nothing, so its key is stable across params — which is the honest
  // answer, and the reason the fragment that varies by sku has to read the param itself.
  const resolve = lowerPlan(p, { facts: await facts() }, await productBindings())
  const kernel = createKernel({ ports: ports(store) })
  const lines = (await compileFixture(LINES)).entry
  assert.deepEqual(lines.effects.reads, [])

  await (await kernel.handle(get('/product/a'), await resolve({ sku: 'a' }), { sku: 'a' })).text()
  await (await kernel.handle(get('/product/b'), await resolve({ sku: 'b' }), { sku: 'b' })).text()
  assert.deepEqual(kernel.trace?.hits, ['cartLines'], 'a fragment that reads nothing is one entry')
})

test('the route table can be asked what it holds', async () => {
  const router = await routes()
  assert.deepEqual([...router.patterns].sort(), ['/cart', '/product/:sku', '/quiet'])
})
