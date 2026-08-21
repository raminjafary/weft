import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryStore } from '../../adapters/src/memory-store.ts'
import { cookieSession } from '../../adapters/src/session.ts'
import { staticFlags } from '../../adapters/src/flags.ts'
import { gated, misbehaving, rejected, stack } from '../fixtures/plugins.ts'
import { cartRoute } from '../fixtures/cart-route.ts'
import {
  createEnvelope,
  createKernel,
  createReads,
  envelopeContext,
  lifecycle,
  requestFacts,
  resolvePlugins,
  runPlugins,
  type EnvelopeContext,
  type Ports,
} from '../src/index.ts'

/**
 * The plugin layer against a realistic stack rather than two plugins in a unit test. The
 * properties worth having only appear at this size: an inferred edge, a wave of genuinely
 * disjoint work, and a filter that ends the request before any of it runs.
 */
function ports(): Ports {
  return {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
    executors: {},
  }
}

function context(cookie: string): EnvelopeContext {
  const facts = requestFacts(
    new Request('https://example.test/cart', { headers: { cookie, 'accept-language': 'ar-IQ' } }),
  )
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  return envelopeContext(createReads(facts, ports()), envelope)
}

test('the stack orders itself from what each plugin reads and provides', () => {
  const { filters, waves } = resolvePlugins(stack)
  assert.deepEqual(filters, [])
  assert.deepEqual(
    waves.map((wave) => wave.map((p) => p.name).sort()),
    [
      // Disjoint: nothing they read is provided by anything here.
      ['@weft/csp', '@weft/session', '@weft/tracing'],
      // i18n reads ctx.session; analytics reads ctx.nonce and is also held by `before`.
      ['@acme/analytics', '@weft/i18n'],
    ],
  )
})

test('the whole stack runs, and every provided value is one it declared', async () => {
  const result = await runPlugins(resolvePlugins(stack), context('sid=u42; locale=ar'))
  assert.equal(result.response, undefined)
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.provided, {
    'ctx.session': 'u42',
    'ctx.trace': 'root',
    'ctx.nonce': 'n0nce',
    'ctx.locale': 'ar',
  })
  assert.deepEqual(result.axes, { locale: ['en', 'ar', 'ku'] })
})

test('a filter ends the request before a single enricher runs', async () => {
  const schedule = resolvePlugins(gated)
  assert.deepEqual(
    schedule.filters.map((p) => p.name),
    ['@weft/auth'],
  )
  const denied = await runPlugins(schedule, context(''))
  assert.equal(denied.response?.status, 302)
  assert.deepEqual(denied.provided, {})

  const allowed = await runPlugins(schedule, context('sid=u42'))
  assert.equal(allowed.response, undefined)
  assert.equal(allowed.provided['ctx.session'], 'u42')
})

test('every rejected fixture is refused at registration, by the code it exists for', () => {
  const expected: Record<string, RegExp> = {
    ambiguous: /E_PLUGIN_AMBIGUOUS/,
    cyclic: /E_PLUGIN_CYCLE/,
    duplicated: /E_PLUGIN_DUPLICATE/,
  }
  for (const [name, plugins] of Object.entries(rejected)) {
    assert.throws(() => resolvePlugins(plugins), expected[name] as RegExp, name)
  }
})

test('a plugin reading undeclared state throws rather than tainting nothing', async () => {
  await assert.rejects(
    () => runPlugins(resolvePlugins([misbehaving.undeclaredRead]), context('sid=u42')),
    /E_PLUGIN_UNDECLARED_READ.*identity/s,
  )
})

test('a plugin providing an undeclared key is refused', async () => {
  await assert.rejects(
    () => runPlugins(resolvePlugins([misbehaving.undeclaredProvide]), context('')),
    /E_PLUGIN_UNDECLARED_PROVIDE/,
  )
})

test('an enricher that tries to end the request is told to declare itself a filter', async () => {
  await assert.rejects(
    () => runPlugins(resolvePlugins([misbehaving.respondingEnricher]), context('')),
    /E_ENRICHER_RESPONDED/,
  )
})

test('a slow or failing third-party plugin is skipped and reported, never fatal', async () => {
  const result = await runPlugins(resolvePlugins([misbehaving.slow, misbehaving.failing]), context(''))
  assert.equal(result.response, undefined)
  const reasons = result.skipped.map((s) => `${s.plugin}: ${s.reason}`).sort()
  assert.match(reasons[0] ?? '', /slow: E_PLUGIN_TIMEOUT/)
  assert.match(reasons[1] ?? '', /third-party: third party down/)
})

test('the stack mounted on a real route redirects an anonymous request before rendering', async () => {
  const kernel = createKernel({ ports: ports(), plugins: gated })
  const response = await kernel.handle(new Request('https://example.test/cart'), await cartRoute())
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login')
  assert.deepEqual(kernel.trace?.states, ['received', 'envelope', 'settled'])
  assert.deepEqual(kernel.trace?.keys, {}, 'no key was resolved, because no plan was executed')
})

test('the same stack lets an authenticated request through to the compiled route', async () => {
  const kernel = createKernel({ ports: ports(), plugins: gated })
  const response = await kernel.handle(
    new Request('https://example.test/cart', { headers: { cookie: 'sid=u42; currency=IQD' } }),
    await cartRoute(),
    { region: 'baghdad' },
  )
  assert.equal(response.status, 200)
  assert.match(await response.text(), /Welcome back/)
  assert.deepEqual(kernel.trace?.states, ['received', 'envelope', 'planned', 'streaming', 'settled'])
})
