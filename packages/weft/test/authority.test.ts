import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_IR_VERSION } from '@weft/ir'
import { frame, residentFrame, str, num, WARP_VERSION, type Frame } from '@weft/warp'
import type { ChannelSink } from '@weft/kernel'
import { createApp, serveApp, type Serving } from '../src/serve.ts'
import { generateSigningKeys, resolveAuthority } from '../src/authority.ts'
import { loadIntents } from '../src/intents.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

/**
 * Authority and discovery through the front door, against the demo.
 *
 * The demo is the right subject for both: it depends on `weft` alone, so anything it cannot express
 * is a gap in the front door rather than in a test. `cart.checkout` there declares a capability and
 * a signature, and its config grants the one and holds the keys for the other — which is the whole
 * of what an application has to write.
 */
const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

let shared: Serving | null = null
async function app(): Promise<Serving> {
  shared ??= await serveApp(await createApp(ROOT, { mode: 'dev', port: 0 }))
  if (!servers.includes(shared)) servers.push(shared)
  return shared
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

async function post(serving: Serving, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(path, serving.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// ── minting ──────────────────────────────────────────────────────────────────────────

test('a token is minted for a signed intent, and only for one', async () => {
  const serving = await app()
  const minted = await post(serving, '/_weft/token', { intent: 'cart.checkout', payload: { sku: 'OIL-2L' } })
  assert.equal(minted.status, 200)
  const body = (await minted.json()) as { token: string; bound: boolean; expiresInMs: number }
  assert.match(body.token, /^weft1\./)
  assert.equal(body.bound, true, 'the payload was named, so the token is a receipt for one call')
  assert.ok(body.expiresInMs > 0)
  assert.equal(
    minted.headers.get('cache-control'),
    'no-store',
    'a token in a cache is the failure this whole path exists to avoid',
  )

  // An intent that needs no token does not get one. A gate that hands out credentials nobody
  // checks reads like a gate and is not one.
  const unnecessary = await post(serving, '/_weft/token', { intent: 'cart.add' })
  assert.equal(unnecessary.status, 400)
  assert.equal(((await unnecessary.json()) as { code: string }).code, 'E_INTENT_NOT_SIGNED')

  const nothing = await post(serving, '/_weft/token', { intent: 'cart.nope' })
  assert.equal(nothing.status, 404)
})

test('minting is a POST, because a token has no business in a URL or a log', async () => {
  const serving = await app()
  const got = await fetch(new URL('/_weft/token', serving.url))
  assert.equal(got.status, 405)
  assert.equal(got.headers.get('allow'), 'POST')
})

// ── the two bindings ─────────────────────────────────────────────────────────────────

test('the POST path runs a signed intent with a token and refuses it without one', async () => {
  const serving = await app()
  const payload = { sku: 'OIL-2L' }

  const unsigned = await post(serving, '/_weft/i/cart.checkout', payload)
  assert.equal(unsigned.status, 401)
  assert.equal(((await unsigned.json()) as { code: string }).code, 'E_INTENT_UNSIGNED')

  const { token } = (await (
    await post(serving, '/_weft/token', { intent: 'cart.checkout', payload })
  ).json()) as { token: string }
  const signed = await post(serving, '/_weft/i/cart.checkout', payload, { 'x-weft-intent-token': token })
  assert.equal(signed.status, 200)
  assert.deepEqual(((await signed.json()) as { invalidated: string[] }).invalidated, ['cart'])

  // The same token again. The nonce was spent by the call that worked.
  const replayed = await post(serving, '/_weft/i/cart.checkout', payload, { 'x-weft-intent-token': token })
  assert.equal(replayed.status, 409)
})

test('a token minted for one payload does not authorise another', async () => {
  const serving = await app()
  const { token } = (await (
    await post(serving, '/_weft/token', { intent: 'cart.checkout', payload: { sku: 'OIL-2L' } })
  ).json()) as { token: string }
  const moved = await post(
    serving,
    '/_weft/i/cart.checkout',
    { sku: 'RICE-5K' },
    { 'x-weft-intent-token': token },
  )
  assert.equal(moved.status, 403)
  assert.equal(((await moved.json()) as { code: string }).code, 'E_TOKEN_WRONG_PAYLOAD')
})

test('the channel enforces the same gates, with the token in the frame header', async () => {
  const serving = await app()
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: '/app/cart?anonymous=1', cookie: '' })
  const held = sink()
  serving.app.hub.open(held, id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])
  const intent = serving.app.intents.names['cart.checkout'] as string

  const refused = await serving.app.hub.receive(id, [
    { ...frame('INTENT', { i: intent }), body: new TextEncoder().encode('{"sku":"OIL-2L"}') },
  ])
  const ack = refused.find((f) => f.kind === 'ACK') as Frame
  assert.equal(str(ack, 'ok'), 'false')
  assert.equal(str(ack, 'code'), 'E_INTENT_UNSIGNED')

  const payload = { sku: 'DATE-1K' }
  const { token } = (await (
    await post(serving, '/_weft/token', { intent: 'cart.checkout', payload })
  ).json()) as { token: string }
  const ran = await serving.app.hub.receive(id, [
    { ...frame('INTENT', { i: intent, t: token }), body: new TextEncoder().encode(JSON.stringify(payload)) },
  ])
  const good = ran.find((f) => f.kind === 'ACK') as Frame
  assert.equal(str(good, 'ok'), 'true', str(good, 'detail') ?? '')
  assert.equal(str(good, 'tags'), 'cart')
})

test('the page tells the client which intents need a token, by id and not by name', async () => {
  const serving = await app()
  const boot = await (await fetch(new URL(serving.app.assets.boot, serving.url))).text()
  const intent = serving.app.intents.names['cart.checkout'] as string
  assert.match(boot, new RegExp(`__weftSigned = \\["${intent}"\\]`))
  assert.equal(boot.includes('cart.checkout"]'), false, 'the prelude carries ids; names are the markup’s')
})

// ── the closed set ───────────────────────────────────────────────────────────────────

test('a capability an intent requires and no role grants fails the build, naming it', async () => {
  const intents = await loadIntents(ROOT, [])
  intents.entries.push({
    module: 'app/intents/x.ts',
    export: 'x',
    id: 'aaaaaa',
    name: 'x',
    writes: [],
    capabilities: ['order:refund'],
    signed: false,
  })
  const { store, ports } = (await app()).app
  await assert.rejects(
    () => resolveAuthority({ grants: { user: ['cart:write'] } }, intents, store, ports),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'E_CAPABILITY_UNGRANTABLE')
      assert.match(error.message, /order:refund/)
      return true
    },
  )
})

test('a grant nothing declares is said rather than refused, and so is an unenforced declaration', async () => {
  const { store, ports } = (await app()).app
  const intents = await loadIntents(ROOT, [])
  intents.entries.push({
    module: 'app/intents/x.ts',
    export: 'x',
    id: 'aaaaaa',
    name: 'x',
    writes: [],
    capabilities: ['cart:write'],
    signed: true,
  })

  const stale = await resolveAuthority({ grants: { user: ['cart:*', 'nobody:asks'] } }, intents, store, ports)
  assert.ok(stale.diagnostics.some((line) => line.startsWith('W_GRANT_UNUSED')))
  assert.ok(
    stale.diagnostics.some((line) => line.startsWith('W_NO_VERIFIER')),
    'a signature nobody can check is a warning at startup and a named refusal per call',
  )

  // Nothing bound at all: the dispatch already refuses, and it is said where somebody can act.
  const unbound = await resolveAuthority(undefined, intents, store, ports)
  assert.equal(unbound.model, null)
  assert.ok(unbound.diagnostics.some((line) => line.startsWith('W_NO_CAPABILITY_MODEL')))
})

/**
 * The two halves of a signing key, each missing on its own.
 *
 * Both warn at startup rather than at the first call, because both are configuration mistakes and a
 * configuration mistake found by a reader is a configuration mistake found too late. They had no
 * test until now — a warning nothing asserts is a warning that can stop firing without anybody
 * noticing, which is the same failure as a refusal nobody checks.
 */
test('a private key with no public keys warns, and so does a signature nobody can mint', async () => {
  const { store, ports } = (await app()).app
  const intents = await loadIntents(ROOT, [])
  intents.entries.push({
    module: 'app/intents/x.ts',
    export: 'x',
    id: 'bbbbbb',
    name: 'x',
    writes: [],
    capabilities: [],
    signed: true,
  })
  const keys = await generateSigningKeys()

  // Can mint and cannot check its own tokens.
  const mintOnly = await resolveAuthority(
    { grants: {}, signing: { kid: 'dev', privateKey: keys.privateKey } },
    intents,
    store,
    ports,
  )
  assert.ok(
    mintOnly.diagnostics.some((line) => line.startsWith('W_NO_PUBLIC_KEYS')),
    mintOnly.diagnostics.join(' | '),
  )

  // Can check and cannot mint: `/_weft/token` refuses by name, which is worth saying at startup.
  const verifyOnly = await resolveAuthority(
    { grants: {}, signing: { kid: 'dev', publicKeys: { dev: keys.publicKey } } },
    intents,
    store,
    ports,
  )
  assert.ok(
    verifyOnly.diagnostics.some((line) => line.startsWith('W_NO_SIGNER')),
    verifyOnly.diagnostics.join(' | '),
  )
  assert.equal(
    verifyOnly.diagnostics.some((line) => line.startsWith('W_NO_VERIFIER')),
    false,
    'a public key is a verifier, so that warning is not this one',
  )
})

test('the demo starts clean except for what its store cannot promise', async () => {
  const serving = await app()
  const authority = serving.app.authority
  assert.ok(authority.model, 'the demo binds a capability model')
  assert.ok(authority.signer && authority.verifier, 'and both halves of the signing pair')
  assert.deepEqual(authority.declared, ['cart:checkout'])
  assert.deepEqual(
    authority.diagnostics.map((line) => line.split(':')[0]),
    ['W_REPLAY_PROCESS_LOCAL'],
    'the one thing an in-process store cannot promise is that a nonce is spent everywhere',
  )
})

// ── discovery ────────────────────────────────────────────────────────────────────────

test('a channel is told about its own route and where readers go next, unasked', async () => {
  const serving = await app()
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: '/app/cart?anonymous=1', cookie: '' })
  const held = sink()
  serving.app.hub.open(held, id)
  const out = await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])

  const plan = out.find((f) => f.kind === 'PLAN') as Frame
  assert.ok(plan, 'the handshake is where a page with no channel history hears anything at all')
  const routes = JSON.parse(new TextDecoder().decode(plan.body)) as {
    pattern: string
    shell: string
    shared: boolean
    slots: string[]
    css: string
  }[]
  const cart = routes.find((route) => route.pattern === '/app/cart')
  assert.ok(cart, 'the connection’s own route is described first')
  assert.equal(cart.shared, true, 'a route is trivially in its own shell')
  assert.deepEqual(cart.slots.sort(), ['body', 'panel', 'readout'])
  assert.match(cart.css, /\.css/)
})

test('a subtree is described without rendering any of it, and the shell is the answer that pays', async () => {
  const serving = await app()
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: '/app/cart?anonymous=1', cookie: '' })
  serving.app.hub.open(sink(), id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])

  const out = await serving.app.hub.receive(id, [frame('WARM', { plan: '/live/*' })])
  const plan = out.find((f) => f.kind === 'PLAN') as Frame
  assert.ok(plan)
  const routes = JSON.parse(new TextDecoder().decode(plan.body)) as { pattern: string; shared: boolean }[]
  assert.ok(routes.length > 0)
  assert.equal(
    routes.every((route) => route.pattern.startsWith('/live/')),
    true,
  )
  assert.equal(
    routes.some((route) => !route.shared),
    true,
    'the race page uses another layout, so this is the round trip a click on it no longer spends',
  )
  // No slot was rendered to answer any of this: describing a route runs no loader.
  assert.equal(num(plan, 'n'), routes.length)

  const absent = await serving.app.hub.receive(id, [frame('WARM', { plan: '/nowhere/*' })])
  assert.equal(num(absent.find((f) => f.kind === 'PLAN') as Frame, 'n'), 0)
})
