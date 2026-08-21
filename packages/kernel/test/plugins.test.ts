import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createEnvelope,
  createReads,
  definePlugin,
  envelopeContext,
  lifecycle,
  requestFacts,
  guardReads,
  resolvePlugins,
  runPlugins,
  type EnvelopeContext,
  type Ports,
} from '../src/index.ts'
import { cookieSession, memoryStore, staticFlags } from '@weft/adapters'

function context(cookie = 'locale=ar'): EnvelopeContext {
  const ports: Ports = {
    store: memoryStore(),
    session: cookieSession(),
    flags: staticFlags({ axes: { 'new-cart': ['off', 'on'] } }),
    executors: {},
  }
  const facts = requestFacts(new Request('https://example.test/', { headers: { cookie } }))
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  return envelopeContext(createReads(facts, ports), envelope)
}

const i18n = definePlugin({
  name: '@weft/i18n',
  role: 'enricher',
  reads: ['cookie:locale'],
  provides: ['ctx.locale'],
  planAxis: () => ({ locale: ['en', 'ar', 'ku'] }),
  onRequest: (ctx) => ({ provided: { 'ctx.locale': ctx.cookie('locale') ?? 'en' } }),
})

const analytics = definePlugin({
  name: '@weft/analytics',
  role: 'enricher',
  reads: ['ctx.locale'],
  onRequest: () => ({}),
})

test('an edge is inferred from provides and reads, with nobody writing after:', () => {
  const { waves } = resolvePlugins([analytics, i18n])
  assert.deepEqual(
    waves.map((w) => w.map((p) => p.name)),
    [['@weft/i18n'], ['@weft/analytics']],
  )
})

test('disjoint plugins share a wave', () => {
  const tracing = definePlugin({ name: 'tracing', role: 'enricher', provides: ['ctx.trace'] })
  const { waves } = resolvePlugins([i18n, tracing])
  assert.equal(waves.length, 1)
  assert.equal(waves[0]?.length, 2)
})

test('two plugins providing the same key is caught, not resolved by load order', () => {
  const other = definePlugin({ name: 'other-i18n', role: 'enricher', provides: ['ctx.locale'] })
  assert.throws(() => resolvePlugins([i18n, other]), /E_PLUGIN_AMBIGUOUS/)
})

test('a declared ordering cycle is a build error', () => {
  const a = definePlugin({ name: 'a', role: 'enricher', before: ['b'] })
  const b = definePlugin({ name: 'b', role: 'enricher', before: ['a'] })
  assert.throws(() => resolvePlugins([a, b]), /E_PLUGIN_CYCLE/)
})

test('a plugin reading state it did not declare throws rather than tainting nothing', async () => {
  const sneaky = definePlugin({
    name: 'sneaky',
    role: 'enricher',
    critical: true,
    reads: ['cookie:locale'],
    onRequest: (ctx) => {
      ctx.cookie('session')
    },
  })
  await assert.rejects(
    () => runPlugins(resolvePlugins([sneaky]), context(), guardReads),
    /E_PLUGIN_UNDECLARED_READ.*cookie:session/s,
  )
})

test('a plugin providing a key it did not declare is refused', async () => {
  const sneaky = definePlugin({
    name: 'sneaky',
    role: 'enricher',
    critical: true,
    onRequest: () => ({ provided: { 'ctx.whatever': 1 } }),
  })
  await assert.rejects(() => runPlugins(resolvePlugins([sneaky]), context()), /E_PLUGIN_UNDECLARED_PROVIDE/)
})

test('a filter can end the request and everything after it is skipped', async () => {
  const ran: string[] = []
  const auth = definePlugin({
    name: 'auth',
    role: 'filter',
    onRequest: () => {
      ran.push('auth')
      return { response: new Response(null, { status: 302, headers: { location: '/login' } }) }
    },
  })
  const later = definePlugin({
    name: 'later',
    role: 'enricher',
    onRequest: () => {
      ran.push('later')
    },
  })
  const result = await runPlugins(resolvePlugins([auth, later]), context())
  assert.equal(result.response?.status, 302)
  assert.deepEqual(ran, ['auth'])
})

test('an enricher that tries to end the request is told to declare itself a filter', async () => {
  const bad = definePlugin({
    name: 'bad',
    role: 'enricher',
    onRequest: () => ({ response: new Response('no') }),
  })
  await assert.rejects(() => runPlugins(resolvePlugins([bad]), context()), /E_ENRICHER_RESPONDED/)
})

test('a non-critical plugin that fails is skipped and reported, never fatal', async () => {
  const flaky = definePlugin({
    name: 'flaky',
    role: 'enricher',
    critical: false,
    onRequest: () => {
      throw new Error('third party down')
    },
  })
  const result = await runPlugins(resolvePlugins([flaky]), context())
  assert.deepEqual(result.skipped, [{ plugin: 'flaky', reason: 'third party down' }])
})

test('a plugin adds an axis and never a key', async () => {
  const result = await runPlugins(resolvePlugins([i18n]), context())
  assert.deepEqual(result.axes, { locale: ['en', 'ar', 'ku'] })
  assert.equal(result.provided['ctx.locale'], 'ar')
  // There is no setter for a key anywhere on the plugin surface, which is the enforcement.
  assert.equal('key' in result, false)
})

test('a plugin over its timeout is skipped rather than allowed to hold the envelope', async () => {
  const slow = definePlugin({
    name: 'slow',
    role: 'enricher',
    timeoutMs: 5,
    onRequest: () => new Promise<void>((r) => setTimeout(r, 40)),
  })
  const result = await runPlugins(resolvePlugins([slow]), context())
  assert.match(result.skipped[0]?.reason ?? '', /E_PLUGIN_TIMEOUT/)
})
