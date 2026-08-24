import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { byAddress, bySession, bySubject, countingLimits, memoryStore } from '@weft/adapters'
import { TEMPLATE_IR_VERSION } from '@weft/ir'
import { frame, residentFrame, str, WARP_VERSION, type Frame } from '@weft/warp'
import type { ChannelSink, LimitRequest } from '@weft/kernel'
import { createApp, serveApp, type Serving } from '../src/serve.ts'

/**
 * Rate limiting: one port, and the one decision it exists to refuse to make.
 *
 * The interesting assertions here are not that a counter counts. They are that an intent declaring a
 * limit is *refused* when nothing enforces it, that the same limit applies on both bindings, and
 * that what a call is counted against is genuinely the deployment's — three limiters over one intent
 * produce three different notions of "the same caller", and none of them is the framework's.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

async function app(overrides: Parameters<typeof createApp>[1] = {}): Promise<Serving> {
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, ...overrides }))
  servers.push(serving)
  return serving
}

/**
 * The demo binds a limiter, so a test about *not* binding one has to take it away.
 *
 * Cast because the config's optional fields are exactly optional: `limits: undefined` is not a
 * `LimitPort`, and the only reason to write it is to unbind what a config file bound.
 */
const UNBOUND = { limits: undefined } as unknown as Parameters<typeof createApp>[1]

/**
 * A limiter whose clock does not move, for the tests that are about *counting* rather than about
 * windows.
 *
 * The window is fixed, not sliding — that is stated in the adapter and it is the honest limiter for a
 * store that has a lease and not a counter — so a burst that straddles a boundary is split across two
 * buckets and neither reaches the ceiling. Real, documented, and nothing to do with what these two
 * tests are asserting; a test that let the wall clock decide would fail about one run in eight and
 * teach whoever hit it to re-run rather than to read.
 *
 * It also exercises the other shape of `WeftConfig.limits`: a whole `LimitPort`, which is what a
 * deployment with a gateway or a Redis script binds.
 */
function frozen(counted: (request: LimitRequest) => string | null) {
  return countingLimits({ store: memoryStore(), counted, now: () => 1_700_000_000_000 })
}

async function add(serving: Serving, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL('/_weft/i/cart.add', serving.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-weft-fetch': '1', ...headers },
    body: JSON.stringify({ sku: 'OIL-2L', qty: 1 }),
  })
}

function sink(): ChannelSink & { frames: Frame[] } {
  const frames: Frame[] = []
  return {
    frames,
    binding: 'socket',
    open: true,
    send(batch) {
      frames.push(...batch)
    },
    close() {},
  }
}

async function channel(serving: Serving, at: string): Promise<string> {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: at, cookie: '' })
  serving.app.hub.open(sink(), id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])
  return id
}

function asked(overrides: Partial<LimitRequest> = {}): LimitRequest {
  return {
    id: 'abc123',
    intent: 'cart.add',
    limit: { max: 2, windowMs: 1000 },
    subject: null,
    header: () => undefined,
    cookie: () => undefined,
    ...overrides,
  }
}

test('an intent that declares a limit is refused when nothing counts, and says so at startup', async () => {
  // Not unlimited. The same argument an unchecked capability makes, one step further along: a limit
  // nothing enforces reads as a protection that is not there.
  const serving = await app(UNBOUND)
  assert.equal(
    serving.app.warnings.some((w) => w.startsWith('W_NO_RATE_LIMIT')),
    true,
    'printed with the banner, because a 501 in front of a reader is the wrong moment to find out',
  )

  const response = await add(serving)
  assert.equal(response.status, 501, 'declared and unenforceable is not a client error')
  const body = (await response.json()) as { code?: string }
  assert.equal(body.code, 'E_NO_RATE_LIMIT')
})

test('the demo binds one, and the limit is enforced over plain HTTP with a Retry-After', async () => {
  const serving = await app({ limits: frozen(() => 'one-caller') })
  // cart.add declares 20 per 10s. The twenty-first is the one that should be turned away.
  const codes: number[] = []
  for (let i = 0; i < 21; i++) codes.push((await add(serving)).status)

  assert.equal(codes.filter((code) => code === 429).length, 1, 'twenty through, and the twenty-first refused')
  assert.equal(codes.at(-1), 429, 'and it is the last one, not an arbitrary one')

  const refused = await add(serving)
  assert.equal(refused.status, 429)
  const retry = Number(refused.headers.get('retry-after'))
  assert.ok(retry >= 1 && retry <= 10, `Retry-After is seconds until the window rolls, got ${retry}`)
  const body = (await refused.json()) as { code?: string; detail?: string }
  assert.equal(body.code, 'E_RATE_LIMITED')
  assert.equal(
    body.detail?.includes('one-caller'),
    false,
    'the refusal does not say what the call was counted against: that identifies the caller',
  )
})

test('two callers the deployment counts separately do not spend each other budget', async () => {
  const serving = await app({ limits: frozen((request) => request.header('x-caller') ?? null) })
  for (let i = 0; i < 20; i++) await add(serving, { 'x-caller': 'a' })

  assert.equal((await add(serving, { 'x-caller': 'a' })).status, 429, 'a is out')
  assert.equal((await add(serving, { 'x-caller': 'b' })).status, 200, 'and b never was')
})

test('a caller the deployment does not count is not limited, which is a decision and not a hole', async () => {
  // A queue worker, a migration, an internal caller. The honest place for that exemption is the
  // function that decides who is being counted, not a second declaration on the intent.
  const serving = await app({ limits: frozen(() => null) })
  const codes: number[] = []
  for (let i = 0; i < 25; i++) codes.push((await add(serving)).status)
  assert.deepEqual([...new Set(codes)], [200])
})

test('the same limit applies over the channel, because one binding enforcing it is a way around it', async () => {
  const serving = await app({ limits: frozen(() => 'over-the-channel') })
  const id = await channel(serving, '/app/cart')
  const ids = serving.app.intents.names['cart.add'] as string

  const codes: (string | undefined)[] = []
  for (let i = 0; i < 21; i++) {
    const out = await serving.app.hub.receive(id, [
      frame('INTENT', { i: ids }, new TextEncoder().encode(JSON.stringify({ sku: 'OIL-2L', qty: 1 }))),
    ])
    const ack = out.find((f) => f.kind === 'ACK') as Frame
    codes.push(str(ack, 'code'))
  }

  assert.equal(codes.filter((code) => code === 'E_RATE_LIMITED').length, 1)
  assert.equal(codes.at(-1), 'E_RATE_LIMITED', 'the twenty-first, refused in an ACK rather than a status')
  assert.equal(
    codes.slice(0, 20).every((code) => code === undefined),
    true,
    'and the twenty before it ran',
  )
})

test('the three answers the design names are three functions, and they read three different things', () => {
  const seen = { header: [] as string[], cookie: [] as string[] }
  const request = asked({
    subject: 'user-7',
    header: (key) => (seen.header.push(key), key === 'x-forwarded-for' ? '203.0.113.9, 10.0.0.1' : undefined),
    cookie: (key) => (seen.cookie.push(key), key === 'sid' ? 'session-3' : undefined),
  })

  assert.equal(byAddress()(request), '203.0.113.9', 'the left-most entry is the client; the rest are proxies')
  assert.equal(bySession()(request), 'session-3')
  assert.equal(bySubject()(request), 'user-7')
  assert.deepEqual(seen.header, ['x-forwarded-for'], 'and each reads only what it counts against')
  assert.deepEqual(seen.cookie, ['sid'])
})

test('bySubject leaves an anonymous caller unlimited rather than quietly falling back to an address', () => {
  // Stated rather than combined: a limiter that counted anonymous callers by IP would be a
  // different policy from the one that was asked for.
  assert.equal(bySubject()(asked({ subject: null, header: () => '203.0.113.9' })), null)
})

test('the window rolls, and a bucket is a key rather than something that has to be swept', async () => {
  let clock = 1_000_000
  const limits = countingLimits({
    store: memoryStore(),
    counted: () => 'one',
    now: () => clock,
  })
  const request = asked()

  assert.equal((await limits.check(request)).ok, true)
  assert.equal((await limits.check(request)).ok, true)
  const third = await limits.check(request)
  assert.equal(third.ok, false)
  assert.equal(third.ok === false ? third.counted : null, 'one', 'the log gets it; the caller does not')
  assert.ok(third.ok === false && (third.retryAfterMs ?? 0) > 0, 'and it can say when to come back')

  clock += 1000
  assert.equal((await limits.check(request)).ok, true, 'a new window is a new key')
})

test('what is left of the budget is reported, because a limiter nobody can see is one nobody tunes', async () => {
  const limits = countingLimits({ store: memoryStore(), counted: () => 'one' })
  const first = await limits.check(asked())
  assert.equal(first.ok && first.remaining, 1)
})
