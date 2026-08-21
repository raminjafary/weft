import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EffectSet } from '../../ir/src/index.ts'
import { cacheHeaders, keyMaterial, requestFacts, resolveKey, resolveRead, type Ports } from '../src/index.ts'
import { cookieSession } from '../../adapters/src/session.ts'
import { staticFlags } from '../../adapters/src/flags.ts'
import { memoryStore } from '../../adapters/src/memory-store.ts'

function effects(reads: string[]): EffectSet {
  return { reads: [...reads].sort(), writes: [], envelope: [], residency: reads.length ? 'server' : 'either' }
}

function ports(): Ports {
  return {
    store: memoryStore(),
    session: cookieSession({ cookie: 'sid' }),
    flags: staticFlags({
      axes: { 'new-cart': ['off', 'on'] },
      bucket: (_f, r) => (r.cookies.beta ? 'on' : 'off'),
    }),
    executors: {},
  }
}

function facts(cookie: string, url = 'https://example.test/cart?region=north') {
  return requestFacts(new Request(url, { headers: { cookie, 'accept-language': 'ar-IQ,ar;q=0.9' } }), {
    region: 'north',
  })
}

test('a read resolves to the value the key has to contain', async () => {
  const p = ports()
  const f = facts('currency=IQD; sid=u42')
  assert.equal(await resolveRead('cookie:currency', f, p), 'IQD')
  assert.equal(await resolveRead('route:region', f, p), 'north')
  assert.equal(await resolveRead('locale', f, p), 'ar-iq')
  assert.equal(await resolveRead('identity', f, p), 'u42')
  assert.equal(await resolveRead('flag:new-cart', f, p), 'off')
})

test('the clock never reaches the key', async () => {
  assert.equal(await resolveRead('time', facts(''), ports()), '')
})

test('a read the compiler tracks and the kernel cannot resolve is named, not guessed', async () => {
  await assert.rejects(() => resolveRead('phase-of-moon', facts(''), ports()), /E_UNRESOLVABLE_READ/)
})

test('the same reads in a different order produce the same key', async () => {
  const p = ports()
  const f = facts('currency=IQD')
  const a = await resolveKey(
    { id: 'cart', version: 'v1', effects: effects(['cookie:currency', 'locale']) },
    f,
    p,
  )
  const b = await resolveKey(
    { id: 'cart', version: 'v1', effects: effects(['locale', 'cookie:currency']) },
    f,
    p,
  )
  assert.equal(a.key, b.key)
})

test('a different value for a tracked read is a different key', async () => {
  const p = ports()
  const input = { id: 'cart', version: 'v1', effects: effects(['cookie:currency']) }
  const a = await resolveKey(input, facts('currency=IQD'), p)
  const b = await resolveKey(input, facts('currency=USD'), p)
  assert.notEqual(a.key, b.key)
  assert.equal(a.components['cookie:currency'], 'IQD')
})

test('a flag is an axis and is still part of the key', async () => {
  const p = ports()
  const input = { id: 'cart', version: 'v1', effects: effects(['flag:new-cart']) }
  const off = await resolveKey(input, facts(''), p)
  const on = await resolveKey(input, facts('beta=1'), p)
  assert.deepEqual(off.axes, { 'new-cart': 'off' })
  assert.deepEqual(on.axes, { 'new-cart': 'on' })
  assert.notEqual(off.key, on.key)
  assert.deepEqual(off.components, {})
})

test('a content change is a different cached thing', async () => {
  const p = ports()
  const a = await resolveKey({ id: 'cart', version: 'v1', effects: effects([]) }, facts(''), p)
  const b = await resolveKey({ id: 'cart', version: 'v2', effects: effects([]) }, facts(''), p)
  assert.notEqual(a.key, b.key)
})

test('the key material is readable, which is what makes weft why possible', () => {
  assert.equal(
    keyMaterial(
      { id: 'cart-summary', version: 'a91f', effects: effects([]) },
      { 'cookie:currency': 'IQD' },
      { 'new-cart': 'on' },
    ),
    'cart-summary@a91f cookie:currency=IQD flag:new-cart=on',
  )
})

test('reading identity is private; reading nothing is static', async () => {
  const p = ports()
  const priv = await resolveKey({ id: 'x', version: 'v', effects: effects(['identity']) }, facts('sid=u1'), p)
  assert.equal(priv.class, 'private')
  const stat = await resolveKey({ id: 'x', version: 'v', effects: effects([]) }, facts(''), p)
  assert.equal(stat.class, 'static')
  assert.match(stat.reason, /reads nothing/)
})

test('ctx.raw leaves tracking, so there is no key at all', async () => {
  const resolved = await resolveKey(
    { id: 'x', version: 'v', effects: effects(['opaque']) },
    facts(''),
    ports(),
  )
  assert.equal(resolved.key, null)
  assert.equal(resolved.class, 'private')
  assert.match(resolved.reason, /uncacheable/)
})

test('Vary comes from the same reads as the key', async () => {
  const resolved = await resolveKey(
    { id: 'x', version: 'v', effects: effects(['cookie:currency', 'locale', 'header:x-tier']) },
    facts('currency=IQD'),
    ports(),
  )
  assert.deepEqual(resolved.vary, ['Accept-Language', 'Cookie', 'X-Tier'])
  assert.equal(cacheHeaders(resolved).vary, 'Accept-Language, Cookie, X-Tier')
})

test('a public policy on a private fragment is refused before it can leak', async () => {
  const resolved = await resolveKey(
    { id: 'x', version: 'v', effects: effects(['identity']) },
    facts('sid=u1'),
    ports(),
  )
  assert.throws(() => cacheHeaders(resolved, { class: 'public' }), /E_PRIVATE_AS_PUBLIC/)
})

test('a policy with no ttl on a fragment that reads the clock is refused', async () => {
  const resolved = await resolveKey({ id: 'x', version: 'v', effects: effects(['time']) }, facts(''), ports())
  assert.equal(resolved.ttlRequired, true)
  assert.throws(() => cacheHeaders(resolved, { class: 'public' }), /E_TTL_REQUIRED/)
  assert.equal(
    cacheHeaders(resolved, { class: 'public', ttlMs: 30_000 })['cache-control'],
    'public, max-age=30',
  )
})

test('no policy means no store, which is the safe default rather than the silent one', async () => {
  const resolved = await resolveKey(
    { id: 'x', version: 'v', effects: effects(['identity']) },
    facts('sid=u1'),
    ports(),
  )
  assert.equal(cacheHeaders(resolved)['cache-control'], 'private, no-store')
})
