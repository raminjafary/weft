import assert from 'node:assert/strict'
import { test } from 'node:test'
import { render, type Values } from '@weft/ir'
import { str } from '@weft/warp'
import { collectingTelemetry, cookieSession, memoryStore, staticFlags } from '@weft/adapters'
import { cartRoute, compileFixture, LINES, PRIVATE, SHELL } from '../fixtures/cart-route.ts'
import { createKernel, recordBase, surgicalRefresh, type Ports } from '../src/index.ts'

/**
 * The whole path on real compiler output: compile, resolve keys from the inferred reads,
 * stream the shell before either slot resolves, and refresh one of them surgically.
 *
 * Everything the unit tests assert about a hand-built `TemplateIR` is asserted here about IR
 * the compiler emitted, because agreeing with a hand-written fixture is not the same as
 * working.
 */
function ports(store = memoryStore(), telemetry = collectingTelemetry()): Ports {
  return {
    store,
    telemetry,
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({
      axes: { 'new-cart': ['off', 'on'] },
      bucket: (_flag, request) => (request.cookies.beta ? 'on' : 'off'),
    }),
    executors: {},
  }
}

const rows = (qty: number): Values[] => [
  { name: 'Basmati 5kg', qty, total: '12,000 IQD' },
  { name: 'Tahini', qty: 1, total: '3,500 IQD' },
]

const get = (cookie: string) =>
  new Request('https://example.test/cart?sort=price', { headers: { cookie, 'accept-language': 'ar-IQ' } })

test('the compiled shell streams, and both compiled slots land in it', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(get('currency=IQD; sid=u42'), await cartRoute(), { region: 'baghdad' })
  const body = await response.text()

  assert.match(body, /^<!doctype html>/)
  assert.match(body, /<title>Your cart — Souq<\/title>/)
  // From keyed.tsx, rendered through its own compiled template. The `<!>` markers between
  // values are the anchors a delta writes against, so they are in the expectation rather
  // than stripped out of it.
  assert.match(body, /<!>IQD<!> · <!>baghdad<!> · <!>price<!> · <!>gold/)
  assert.match(body, /<span class="locale">ar-iq<\/span>/)
  // From private.tsx, which read the cookie through its render context.
  assert.match(body, /Welcome back, <!>Ramin<!> — prices in <!>IQD/)
})

test('the shell is sent before either slot resolves', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(
    get('currency=IQD'),
    await cartRoute({ delays: { cartLines: 60, recs: 10 } }),
    { region: 'baghdad' },
  )
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  const first = await reader.read()
  const head = decoder.decode(first.value)

  // The whole shell, both anchors, and no slot content yet.
  assert.match(head, /<!doctype html>/)
  assert.ok(!head.includes('data-w=') && !head.includes('Welcome back'))

  let rest = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    rest += decoder.decode(chunk.value)
  }
  // Fastest first: recs waits 10ms, cartLines waits 60, and the document order is the reverse.
  const recsAt = rest.indexOf('data-w="recs"')
  const linesAt = rest.indexOf('data-w="cartLines"')
  assert.ok(recsAt >= 0 && linesAt >= 0, 'both slots should have filled')
  assert.ok(recsAt < linesAt, 'slots did not arrive fastest-first')
})

test('the document headers are the union of what the compiled fragments read', async () => {
  const kernel = createKernel({ ports: ports() })
  const response = await kernel.handle(get('currency=IQD; sid=u42'), await cartRoute(), { region: 'baghdad' })
  await response.text()

  // keyed.tsx reads cookie:currency, header:x-tier and locale; private.tsx reads a cookie.
  assert.equal(response.headers.get('vary'), 'Accept-Language, Cookie, X-Tier')
  // private.tsx reads identity, so the document cannot be advertised as shared.
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
})

test('the keys come from the inferred reads, and nothing declared them', async () => {
  const kernel = createKernel({ ports: ports() })
  await (await kernel.handle(get('currency=IQD; sid=u42'), await cartRoute(), { region: 'baghdad' })).text()
  const keys = kernel.trace?.keys ?? {}

  const prices = keys.cartLines
  assert.equal(prices?.class, 'shared')
  assert.equal(prices?.components['cookie:currency'], 'IQD')
  assert.equal(prices?.components['route:region'], 'baghdad')
  assert.equal(prices?.components['route:sort'], 'price')
  assert.equal(prices?.components.locale, 'ar-iq')
  assert.deepEqual(prices?.axes, { 'new-cart': 'off' })
  assert.equal(prices?.ttlRequired, true, 'keyed.tsx reads the clock')

  assert.equal(keys.recs?.class, 'private')
  assert.equal(keys.recs?.components.identity, 'u42')
})

test('a flag resolving the other way is a different key for the same request shape', async () => {
  const kernel = createKernel({ ports: ports() })
  await (await kernel.handle(get('currency=IQD'), await cartRoute(), { region: 'baghdad' })).text()
  const off = kernel.trace?.keys.cartLines?.key
  await (await kernel.handle(get('currency=IQD; beta=1'), await cartRoute(), { region: 'baghdad' })).text()
  const on = kernel.trace?.keys.cartLines?.key
  assert.notEqual(off, on)
})

test('the second identical request is served from the store without rendering', async () => {
  const store = memoryStore()
  const kernel = createKernel({ ports: ports(store) })
  const route = await cartRoute()

  await (await kernel.handle(get('currency=IQD; sid=u42'), route, { region: 'baghdad' })).text()
  assert.deepEqual(kernel.trace?.hits, [])

  await (await kernel.handle(get('currency=IQD; sid=u42'), route, { region: 'baghdad' })).text()
  // Only the slot with a policy. The private one has no policy and is never stored.
  assert.deepEqual(kernel.trace?.hits, ['cartLines'])
})

test('a changed cookie misses, because the key contained it', async () => {
  const store = memoryStore()
  const kernel = createKernel({ ports: ports(store) })
  const route = await cartRoute()
  await (await kernel.handle(get('currency=IQD'), route, { region: 'baghdad' })).text()
  await (await kernel.handle(get('currency=USD'), route, { region: 'baghdad' })).text()
  assert.deepEqual(kernel.trace?.hits, [])
})

test('a guard on the compiled route redirects without rendering either slot', async () => {
  const kernel = createKernel({ ports: ports() })
  const route = await cartRoute()
  const response = await kernel.handle(get(''), {
    ...route,
    envelope: (ctx) => {
      if (!ctx.cookie('sid')) ctx.redirect('/login')
    },
  })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login')
  assert.equal(response.body, null)
})

test('a compiled fragment refreshes surgically, and the delta is one changed value', async () => {
  const store = memoryStore()
  const lines = await compileFixture(LINES)
  const listHole = lines.entry.holes.find((h) => h.kind === 'list')
  assert.ok(listHole, 'lines.tsx should lower to a list hole')

  const before: Values = { [listHole.binding]: rows(1) as never }
  const after: Values = { [listHole.binding]: rows(2) as never }

  const base = await recordBase(store, lines.entry, before)
  const result = await surgicalRefresh({
    slot: 'lines',
    ir: lines.entry,
    next: after,
    held: { slot: 'lines', tpl: lines.entry.version, base },
    store,
    accepted: ['html', 'delta'],
    resolve: lines.resolve,
  })

  assert.equal(result.choice.form, 'delta')
  assert.equal(result.frame.kind, 'DELTA')
  assert.deepEqual(Object.keys(result.delta?.changed ?? {}), [`${listHole.binding}[0].qty`])
  assert.equal(str(result.frame, 'base'), base)

  // The second client making the same transition pays a store read, not a diff.
  const again = await surgicalRefresh({
    slot: 'lines',
    ir: lines.entry,
    next: after,
    held: { slot: 'lines', tpl: lines.entry.version, base },
    store,
    accepted: ['html', 'delta'],
    resolve: lines.resolve,
  })
  assert.equal(again.memoized, true)
  assert.deepEqual(again.delta, result.delta)
})

test('a shell cannot serve delta, so a refresh of one falls to markup', async () => {
  const store = memoryStore()
  const shell = await compileFixture(SHELL)
  const result = await surgicalRefresh({
    slot: 'shell',
    ir: shell.entry,
    next: { title: 'Cart', cartCount: 4 },
    held: { slot: 'shell', tpl: shell.entry.version, base: 'whatever' },
    store,
    accepted: ['html', 'delta'],
    resolve: shell.resolve,
  })
  assert.equal(result.choice.form, 'html')
  assert.match(result.choice.reason, /base render was not in the store/)
})

test('a private fragment still renders the same bytes the delta path would reproduce', async () => {
  const priv = await compileFixture(PRIVATE)
  const values: Values = { user: 'Ramin', currency: 'IQD' }
  const direct = new TextDecoder().decode(render(priv.entry, values, priv.resolve))
  assert.match(direct, /Welcome back, <!>Ramin<!>/)
  assert.match(direct, /prices in <!>IQD/)
})
