import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { test } from 'node:test'
import { cookieSession, memoryStore, staticFlags } from '@weftjs/adapters'
import { createCapabilityModel, covers, grantsOf, roleGrants, AuthorityError } from '../src/authority.ts'
import { createEnvelope } from '../src/envelope.ts'
import { createReads, envelopeContext, type EnvelopeContext } from '../src/context.ts'
import { createIntentDispatch, defineIntent, type Intent } from '../src/intent.ts'
import { createIntentRouter, serveIntent } from '../src/intent-http.ts'
import { requestFacts, type Ports, type Registry } from '../src/ports.ts'
import { lifecycle } from '../src/request.ts'
import { createIntentSigner, createIntentVerifier, canonical, digest } from '../src/token.ts'

/**
 * Authority: who may run an intent, and whether this deployment issued the call at all.
 *
 * Almost everything here asserts a refusal, which is the point — the capability model and the
 * signature check exist to say no, and a gate whose only tested path is the happy one is a gate
 * nobody has checked. So: denied by default, denied on an outage, denied for a token that is
 * valid and for the wrong intent, the wrong reader, the wrong payload, or the second time.
 */
function ports(store = memoryStore()): Ports {
  return {
    store,
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({ axes: {} }),
    executors: {},
  }
}

function context(p: Ports, cookie = 'sid=u42'): EnvelopeContext {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  const facts = requestFacts(new Request('https://example.test/cart', { headers: { cookie } }))
  return envelopeContext(createReads(facts, p), envelope)
}

function registry(intents: Record<string, Intent<never>>): Registry {
  return {
    name: 'test',
    intent: (id) => intents[id] as Intent | undefined,
    intents: () => Object.keys(intents),
  }
}

const TABLE = {
  admin: ['cart:*', 'order:refund'],
  customer: ['cart:write'],
  anonymous: [],
}

function model(roles: Record<string, string[]>, ambient: string[] = []) {
  const decisions: { allowed: boolean; required: readonly string[] }[] = []
  const built = createCapabilityModel({
    grants: roleGrants({ table: TABLE, roles: (subject) => roles[subject] ?? [] }),
    ambient,
    audit: (decision) => decisions.push({ allowed: decision.allowed, required: decision.required }),
  })
  return { built, decisions }
}

// ── the capability model ─────────────────────────────────────────────────────────────

test('a namespace grant covers what is under it and nothing above it', () => {
  assert.equal(covers('cart:write', 'cart:write'), true)
  assert.equal(covers('cart:*', 'cart:write'), true)
  assert.equal(covers('cart:*', 'cart:line:delete'), true)
  assert.equal(covers('cart:*', 'order:refund'), false)
  // The trap: a prefix that is not a namespace boundary. `cart` must not cover `cartel:*`.
  assert.equal(covers('cart', 'cartel:write'), false)
})

test('every declared capability is required, not any of them', async () => {
  const { built } = model({ u42: ['customer'] })
  const ctx = context(ports())
  assert.equal(await built.check(ctx, ['cart:write']), true)
  assert.equal(
    await built.check(ctx, ['cart:write', 'order:refund']),
    false,
    'holding one of two is not holding both, or a longer declaration would be a weaker one',
  )
})

test('a caller with no session holds only what the anonymous role and the ambient set give', async () => {
  const { built } = model({}, ['catalogue:read'])
  const ctx = context(ports(), '')
  assert.equal(await built.check(ctx, ['catalogue:read']), true)
  assert.equal(await built.check(ctx, ['cart:write']), false)
  const decision = await built.decide(ctx, ['cart:write'])
  assert.equal(decision.subject, null)
  assert.deepEqual(decision.missing, ['cart:write'])
})

test('a grant source that throws is a denial, and it says which', async () => {
  const built = createCapabilityModel({
    grants: () => {
      throw new Error('the identity service is down')
    },
  })
  const decision = await built.decide(context(ports()), ['cart:write'])
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'E_GRANTS_UNAVAILABLE')
  assert.match(decision.via ?? '', /identity service/)
})

test('a grant that matches everything is refused where it is written', () => {
  assert.throws(
    () => createCapabilityModel({ grants: () => ({ subject: null, capabilities: [] }), ambient: ['*'] }),
    {
      code: 'E_GRANT_TOO_BROAD',
    },
  )
  assert.throws(() => roleGrants({ table: { root: ['*'] }, roles: () => ['root'] }), {
    code: 'E_GRANT_TOO_BROAD',
  })
  assert.ok(new AuthorityError('E_X', 'y') instanceof Error)
})

test('an allow is audited as loudly as a denial', async () => {
  const { built, decisions } = model({ u42: ['admin'] })
  const ctx = context(ports())
  await built.check(ctx, ['order:refund'])
  await built.check(ctx, ['nothing:granted'])
  assert.deepEqual(
    decisions.map((d) => d.allowed),
    [true, false],
    'a log of denials only is a log in which a successful escalation is silence',
  )
  assert.equal(built.recent().length, 2)
})

test('roles resolve to the union of what they grant', () => {
  assert.deepEqual(grantsOf(['customer', 'admin'], TABLE), ['cart:write', 'cart:*', 'order:refund'])
  assert.deepEqual(grantsOf(['nobody'], TABLE), [])
})

// ── the model, behind the dispatch ───────────────────────────────────────────────────

const refund = defineIntent({
  name: 'order.refund',
  writes: ['orders'],
  capabilities: ['order:refund'],
  async run(ctx) {
    await ctx.revalidate('orders')
  },
})

test('a bound model is what turns a declared capability into an answer', async () => {
  const store = memoryStore()
  const p = ports(store)
  const registered = registry({ r1: refund as unknown as Intent<never> })

  const unchecked = createIntentDispatch({ registry: registered, store })
  assert.equal(
    (await unchecked.run('r1', {}, context(p))).code,
    'E_NO_CAPABILITY_CHECK',
    'the seam with nothing behind it refuses, which is the behaviour a model replaces',
  )

  const denied = createIntentDispatch({
    registry: registered,
    store,
    capabilities: model({ u42: ['customer'] }).built.check,
  })
  assert.equal((await denied.run('r1', {}, context(p))).code, 'E_CAPABILITY_DENIED')

  const allowed = createIntentDispatch({
    registry: registered,
    store,
    capabilities: model({ u42: ['admin'] }).built.check,
  })
  const outcome = await allowed.run('r1', {}, context(p))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.invalidated, ['orders'])
})

// ── signed intents ───────────────────────────────────────────────────────────────────

async function keys(): Promise<{ signer: ReturnType<typeof createIntentSigner>; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  return { signer: createIntentSigner({ kid: 'k1', key: pair.privateKey }), publicKey: pair.publicKey }
}

const checkout = defineIntent({
  name: 'order.checkout',
  writes: ['cart'],
  signed: true,
  async run(ctx) {
    await ctx.revalidate('cart')
    return { data: { placed: true } }
  },
})

test('a token minted for this intent, this reader and this payload verifies once', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store })
  const payload = { sku: 'RICE-5K', qty: 2 }
  const token = await signer.mint({ intent: 'c1', subject: 'u42', payload })

  const first = await verifier.verify({ id: 'c1', token, raw: payload, subject: 'u42' })
  assert.equal(first.ok, true)
  assert.equal(first.ok && first.boundPayload, true)

  const again = await verifier.verify({ id: 'c1', token, raw: payload, subject: 'u42' })
  assert.equal(again.ok, false)
  assert.equal(!again.ok && again.code, 'E_INTENT_REPLAYED')
})

test('a token spent in one process is spent as far as a second process is concerned', async () => {
  /**
   * The claim `replayScope` makes, asserted across a real process boundary.
   *
   * Everything above verifies twice against one `memoryStore`, which proves a Map remembers — and a
   * Map was never the thing in question. Behind a load balancer the second call lands somewhere else,
   * and until a store's leases were shared this framework had no arrangement in which that was
   * refused. So the second verifier here is genuinely a second process, and it has the public key and
   * the lease directory and nothing else in common with the first.
   */
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  const { sharedLeases } = await import('@weftjs/adapters')
  const run = promisify(execFile)

  const dir = await mkdtemp(join(tmpdir(), 'weft-replay-'))
  try {
    const { signer, publicKey } = await keys()
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64')
    const store = sharedLeases(memoryStore(), { dir })
    const verifier = createIntentVerifier({ keys: { k1: publicKey }, store })
    assert.equal(verifier.replayScope, 'shared', 'and it says so, which is what a deployment reads')

    const payload = { sku: 'RICE-5K', qty: 2 }
    const token = await signer.mint({ intent: 'c1', subject: 'u42', payload })
    const first = await verifier.verify({ id: 'c1', token, raw: payload, subject: 'u42' })
    assert.equal(first.ok, true)

    const kernel = fileURLToPath(new URL('../src/', import.meta.url))
    const adapters = fileURLToPath(new URL('../../adapters/src/', import.meta.url))
    const script = `
      import { createIntentVerifier } from '${kernel}token.ts'
      import { memoryStore } from '${adapters}memory-store.ts'
      import { sharedLeases } from '${adapters}shared-leases.ts'
      const key = await crypto.subtle.importKey('spki', Buffer.from(${JSON.stringify(spki)}, 'base64'),
        { name: 'Ed25519' }, false, ['verify'])
      const store = sharedLeases(memoryStore(), { dir: ${JSON.stringify(dir)} })
      const verifier = createIntentVerifier({ keys: { k1: key }, store })
      const out = await verifier.verify({
        id: 'c1', token: ${JSON.stringify(token)},
        raw: ${JSON.stringify(payload)}, subject: 'u42',
      })
      process.stdout.write(out.ok ? 'ok' : out.code)
    `
    const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script])
    assert.equal(
      stdout.trim(),
      'E_INTENT_REPLAYED',
      'a second process refuses the token the first one spent, which is the whole point',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a payload written in another key order is the same payload', async () => {
  const { signer, publicKey } = await keys()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store: memoryStore() })
  const token = await signer.mint({ intent: 'c1', subject: 'u42', payload: { a: 1, b: { c: 2, d: 3 } } })
  const outcome = await verifier.verify({
    id: 'c1',
    token,
    raw: { b: { d: 3, c: 2 }, a: 1 },
    subject: 'u42',
  })
  assert.equal(outcome.ok, true, 'a client that iterated its own object differently sent the same call')
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(canonical([2, 1]), '[2,1]', 'an array’s order is data, so it is left alone')
  assert.equal(await digest({ a: 1 }), await digest({ a: 1 }))
})

test('every way a token can be the wrong token is a different refusal', async () => {
  const { signer, publicKey } = await keys()
  const other = await keys()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store: memoryStore() })
  const payload = { qty: 2 }
  const token = await signer.mint({ intent: 'c1', subject: 'u42', payload })

  const cases: [string, Awaited<ReturnType<typeof verifier.verify>>][] = [
    ['unsigned', await verifier.verify({ id: 'c1', raw: payload, subject: 'u42' })],
    ['malformed', await verifier.verify({ id: 'c1', token: 'weft1.nonsense', raw: payload, subject: 'u42' })],
    ['another intent', await verifier.verify({ id: 'c2', token, raw: payload, subject: 'u42' })],
    ['another reader', await verifier.verify({ id: 'c1', token, raw: payload, subject: 'u99' })],
    ['another payload', await verifier.verify({ id: 'c1', token, raw: { qty: 200 }, subject: 'u42' })],
    [
      'another key',
      await verifier.verify({
        id: 'c1',
        token: await other.signer.mint({ intent: 'c1', subject: 'u42', payload }),
        raw: payload,
        subject: 'u42',
      }),
    ],
  ]
  assert.deepEqual(
    cases.map(([what, outcome]) => [what, outcome.ok ? 'accepted' : outcome.code]),
    [
      ['unsigned', 'E_INTENT_UNSIGNED'],
      ['malformed', 'E_INTENT_TOKEN_MALFORMED'],
      ['another intent', 'E_TOKEN_WRONG_INTENT'],
      ['another reader', 'E_TOKEN_WRONG_SUBJECT'],
      ['another payload', 'E_TOKEN_WRONG_PAYLOAD'],
      // The key id is `k1` in both, and the bundle is pinned to one key under that name — so this
      // is a signature that does not verify rather than a key that is not known.
      ['another key', 'E_INTENT_SIGNATURE'],
    ],
  )
})

test('a key id the bundle does not pin is refused rather than resolved', async () => {
  const { signer } = await keys()
  const other = await keys()
  const verifier = createIntentVerifier({ keys: { k2: other.publicKey }, store: memoryStore() })
  const token = await signer.mint({ intent: 'c1', payload: {} })
  const outcome = await verifier.verify({ id: 'c1', token, raw: {}, subject: null })
  assert.equal(!outcome.ok && outcome.code, 'E_TOKEN_KEY_UNKNOWN')
})

test('an expired token is refused, and the window is the token’s own', async () => {
  const { publicKey } = await keys()
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  let now = 1_000_000
  const signer = createIntentSigner({ kid: 'k1', key: pair.privateKey, ttlMs: 1_000, clock: () => now })
  const verifier = createIntentVerifier({
    keys: { k1: pair.publicKey },
    store: memoryStore(),
    clock: () => now,
    skewMs: 0,
  })
  const token = await signer.mint({ intent: 'c1', payload: {} })
  now += 5_000
  const outcome = await verifier.verify({ id: 'c1', token, raw: {}, subject: null })
  assert.equal(!outcome.ok && outcome.code, 'E_INTENT_EXPIRED')
  assert.ok(publicKey)
})

test('a token without a payload authorises the intent and not one call', async () => {
  const { signer, publicKey } = await keys()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store: memoryStore() })
  const token = await signer.mint({ intent: 'c1', subject: 'u42' })
  const outcome = await verifier.verify({ id: 'c1', token, raw: { qty: 9000 }, subject: 'u42' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.boundPayload, false, 'weaker, and the caller chose it')
})

test('a signed intent with no verifier bound is refused by name', async () => {
  const store = memoryStore()
  const dispatch = createIntentDispatch({
    registry: registry({ c1: checkout as unknown as Intent<never> }),
    store,
  })
  const outcome = await dispatch.run('c1', {}, context(ports(store)))
  assert.equal(outcome.code, 'E_NO_VERIFIER')
  assert.equal(outcome.ok, false)
})

test('the signature is checked before the grant, and the dispatch runs neither on a refusal', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const p = ports(store)
  let checked = 0
  const dispatch = createIntentDispatch({
    registry: registry({ c1: checkout as unknown as Intent<never> }),
    store,
    verify: createIntentVerifier({ keys: { k1: publicKey }, store }),
    capabilities: () => {
      checked++
      return true
    },
  })

  const forged = await dispatch.run('c1', {}, context(p), { token: 'weft1.a.b' })
  assert.equal(forged.code, 'E_INTENT_TOKEN_MALFORMED')
  assert.equal(checked, 0, 'a call that was not authentic never reaches the question of who is asking')

  const token = await signer.mint({ intent: 'c1', subject: 'u42', payload: {} })
  const outcome = await dispatch.run('c1', {}, context(p), { token })
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.invalidated, ['cart'])
})

test('over HTTP the token is a header or a form field, and never part of the payload', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const seen: unknown[] = []
  const signedEcho = defineIntent({
    name: 'echo',
    writes: [],
    signed: true,
    run: (_ctx, input) => {
      seen.push(input)
    },
  })
  const server = serveIntent({
    registry: registry({ c1: signedEcho as unknown as Intent<never> }),
    store,
    verify: createIntentVerifier({ keys: { k1: publicKey }, store }),
    routes: createIntentRouter([{ method: 'POST', pattern: '/checkout', intent: 'c1' }]),
    ports: ports(store),
  })

  const unsigned = await server.handle(
    new Request('https://example.test/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  assert.equal(unsigned.status, 401, 'authenticate and try again, which a 403 would deny')

  const payload = { sku: 'RICE-5K' }
  const token = await signer.mint({ intent: 'c1', payload })
  const header = await server.handle(
    new Request('https://example.test/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-weft-intent-token': token },
      body: JSON.stringify(payload),
    }),
  )
  assert.equal(header.status, 200)

  // The form path: a hidden field, taken out of the payload before the digest is compared — a
  // token that bound a payload containing itself could never verify.
  const formToken = await signer.mint({ intent: 'c1', payload })
  const form = await server.handle(
    new Request('https://example.test/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sku: 'RICE-5K', _weft_token: formToken }).toString(),
    }),
  )
  assert.equal(form.status, 200)
  assert.deepEqual(seen, [payload, payload], 'the intent never saw the credential')
})

test('a replay is a 409, because the request was well-formed and is not going to work again', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const once = defineIntent({ name: 'once', writes: [], signed: true, run: () => {} })
  const server = serveIntent({
    registry: registry({ c1: once as unknown as Intent<never> }),
    store,
    verify: createIntentVerifier({ keys: { k1: publicKey }, store }),
    routes: createIntentRouter([{ method: 'POST', pattern: '/once', intent: 'c1' }]),
    ports: ports(store),
  })
  const token = await signer.mint({ intent: 'c1' })
  const post = (): Promise<Response> =>
    server.handle(
      new Request('https://example.test/once', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-weft-intent-token': token },
        body: '{}',
      }),
    )
  assert.equal((await post()).status, 200)
  assert.equal((await post()).status, 409)
})

// ── delegation ───────────────────────────────────────────────────────────────────────

/**
 * A token minted from a token, and the reason every one of these assertions is a refusal.
 *
 * Delegation is the part of an authority model that goes wrong quietly: the failure is not an
 * error, it is a child that authorises slightly more than its parent did, discovered later by
 * somebody reading a log. So the narrowing is enforced claim by claim and each refusal has its own
 * name, and the default on the checking side is to accept no delegation at all.
 */
test('a delegated token is narrower, and the parent is spent producing it', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store, maxDepth: 1 })

  const parent = await signer.mint({ intent: 'order.checkout', subject: 'u42' })
  const child = await signer.delegate(
    { token: parent, subject: 'u42', intent: 'order.checkout', payload: { sku: 'a' } },
    verifier,
  )

  // The parent's nonce was spent by the verification that produced the child, so the parent
  // cannot be used again — by its holder or by anybody who took a copy of it.
  const reused = await verifier.verify({
    id: 'order.checkout',
    token: parent,
    raw: {},
    subject: 'u42',
  })
  assert.equal(reused.ok, false)
  assert.equal(reused.ok === false && reused.code, 'E_INTENT_REPLAYED')

  const checked = await verifier.verify({
    id: 'order.checkout',
    token: child,
    raw: { sku: 'a' },
    subject: 'u42',
  })
  assert.equal(checked.ok, true)
  assert.equal(checked.ok && checked.claims.d, 1)
  assert.equal(checked.ok && checked.boundPayload, true, 'the child bound a payload its parent did not')
  assert.ok(checked.ok && checked.claims.pn, 'and it names the token it came from, so a chain can be read')
})

test('a deployment that never asked for delegation refuses a delegated token by name', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const permissive = createIntentVerifier({ keys: { k1: publicKey }, store, maxDepth: 1 })
  const child = await signer.delegate(
    { token: await signer.mint({ intent: 'order.checkout' }), subject: null, intent: 'order.checkout' },
    permissive,
  )

  // The default, which is the behaviour this codebase had before delegation existed.
  const strict = createIntentVerifier({ keys: { k1: publicKey }, store: memoryStore() })
  const outcome = await strict.verify({ id: 'order.checkout', token: child, raw: {}, subject: null })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.code, 'E_DELEGATE_DEPTH')
})

test('a child may not outlive its parent, and asking for longer is refused rather than clamped', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store, maxDepth: 1 })
  const parent = await signer.mint({ intent: 'order.checkout', ttlMs: 1_000 })
  await assert.rejects(
    () =>
      signer.delegate({ token: parent, subject: null, intent: 'order.checkout', ttlMs: 60_000 }, verifier),
    /E_DELEGATE_LONGER/,
  )
})

/**
 * A bound parent needs no widening rule of its own: presenting the child's payload to the parent's
 * own check is what refuses both a different payload and no payload at all. Asserted because the
 * absence of a rule is only safe if the other one really covers it.
 */
test('a child cannot unbind or change the payload its parent bound', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store, maxDepth: 1 })

  const unbind = await signer.mint({ intent: 'order.checkout', payload: { sku: 'a' } })
  await assert.rejects(
    () => signer.delegate({ token: unbind, subject: null, intent: 'order.checkout' }, verifier),
    /E_TOKEN_WRONG_PAYLOAD/,
  )

  const change = await signer.mint({ intent: 'order.checkout', payload: { sku: 'a' } })
  await assert.rejects(
    () =>
      signer.delegate(
        { token: change, subject: null, intent: 'order.checkout', payload: { sku: 'b' } },
        verifier,
      ),
    /E_TOKEN_WRONG_PAYLOAD/,
  )

  // And the one that is legal: the same payload, for less time.
  const same = await signer.mint({ intent: 'order.checkout', payload: { sku: 'a' }, ttlMs: 60_000 })
  const child = await signer.delegate(
    { token: same, subject: null, intent: 'order.checkout', payload: { sku: 'a' }, ttlMs: 1_000 },
    verifier,
  )
  const checked = await verifier.verify({
    id: 'order.checkout',
    token: child,
    raw: { sku: 'a' },
    subject: null,
  })
  assert.equal(checked.ok, true)
})

test('a child for another intent is not a child at all', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store, maxDepth: 1 })
  const parent = await signer.mint({ intent: 'order.checkout' })
  await assert.rejects(
    () => signer.delegate({ token: parent, subject: null, intent: 'cart.add' }, verifier),
    /E_TOKEN_WRONG_INTENT/,
  )
})

test('a chain stops where the signer says it stops', async () => {
  const { signer, publicKey } = await keys()
  const store = memoryStore()
  const verifier = createIntentVerifier({ keys: { k1: publicKey }, store, maxDepth: 2 })
  const first = await signer.delegate(
    { token: await signer.mint({ intent: 'order.checkout' }), subject: null, intent: 'order.checkout' },
    verifier,
  )
  // maxDepth is one by default, and the child is already at one.
  await assert.rejects(
    () => signer.delegate({ token: first, subject: null, intent: 'order.checkout' }, verifier),
    /E_DELEGATE_DEPTH/,
  )
})
