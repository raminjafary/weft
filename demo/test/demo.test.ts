import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from 'weft/server'
import { fragmentIR, slotHoles } from 'weft'
import { SHOWCASES } from '../app/lib/showcases.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * The demo, built the way `weft dev` builds it.
 *
 * These are assertions about an *application*: that the file tree produced the routes it should,
 * that the generated plan says what the pages claim, and that a component's stylesheet reaches the
 * pages that render it. Nothing here reaches past `weft` — which is the property that made the
 * stations move out.
 */
let built: Awaited<ReturnType<typeof createApp>> | null = null

async function app(): Promise<NonNullable<typeof built>> {
  built ??= await createApp(ROOT, { mode: 'dev' })
  return built
}

/**
 * The demo's own documents and fragments, compiled by the real compiler.
 *
 * The dashboard is the one page here with a different shape, so it has a layout of its own — and
 * the plan is generated per route, which is what lets it. The effect sets are asserted because
 * they are what the showcases claim: the article reads nothing, the cart reads identity, the feed
 * reads the clock and therefore needs a ttl.
 */
test('the documents leave the boundaries the pages fill, and the fragments read what is claimed', async () => {
  await app()
  assert.deepEqual(slotHoles(fragmentIR('layout')), ['panel', 'body', 'readout'])
  assert.deepEqual(slotHoles(fragmentIR('layout:dash')), [
    'panel',
    'traffic',
    'revenue',
    'errors',
    'slowest',
    'readout',
  ])
  assert.deepEqual(fragmentIR('fragment:article').entry.effects.reads, [], 'article.tsx is the static case')
  assert.deepEqual(
    fragmentIR('fragment:cart').entry.effects.reads,
    ['cookie:currency', 'identity'],
    'cart.tsx is the private case',
  )
  assert.deepEqual(
    fragmentIR('fragment:feed').entry.effects.reads,
    ['time'],
    'feed.tsx is the case that forces a ttl',
  )
})

test('every showcase the index links to is a route', async () => {
  const { routes } = await app()
  const patterns = new Set(routes.map((route) => route.pattern))
  const missing = SHOWCASES.map((s) => s.href).filter(
    (href) => !patterns.has(href) && !patterns.has('/app/ordinary/:category'),
  )
  assert.deepEqual(missing, [], 'the index links to a page that does not exist')
})
test('the plan the framework generated says what the showcases claim', async () => {
  const { routes } = await app()
  const bySlot = (pattern: string, name: string) =>
    routes.find((r) => r.pattern === pattern)?.plan.slots.find((s) => s.name === name)

  // Derived, not declared: no slot on the ordinary page asks to stream, so it is delivered in
  // order and pays for no fill mechanism.
  const ordinary = routes.find((r) => r.pattern === '/app/ordinary/:category')
  assert.equal(
    ordinary?.plan.slots.every((slot) => slot.delivery === 'buffered'),
    true,
    'the ordinary page is the case where nothing streams',
  )

  // The compiler contradicting the declaration, and the declaration losing: the feed reads the
  // clock so its policy needs a ttl, and the cart reads identity so it cannot be public.
  assert.equal(bySlot('/app/feed', 'body')?.cache?.class, 'public')
  assert.ok((bySlot('/app/feed', 'body')?.cache?.ttlMs ?? 0) > 0, 'a time read forces a ttl')
  assert.equal(bySlot('/app/cart', 'body')?.cache?.class, 'private')

  // The wave the dashboard station is about.
  assert.deepEqual(bySlot('/app/dashboard', 'slowest')?.needs, ['traffic'])
})

test('every intent in app/intents is in the manifest, under an id derived from its module', async () => {
  const { intents } = await app()
  const names = intents.entries.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['cart.add', 'cart.setQty', 'feed.tick'])
  for (const entry of intents.entries) {
    assert.match(entry.id, /^[0-9a-f]{6}$/, 'an intent id is six hex characters and nothing else')
    assert.match(entry.module, /^app\/intents\//)
  }
})

/**
 * The claim that a page links the stylesheets of the components on it and no others. It is
 * checkable, so it is checked: `product-card.css` belongs to the ordinary page because
 * `ordinary.tsx` composes that component, and to no other page.
 */
test('a component stylesheet reaches the pages that render it and no others', async () => {
  const { routes } = await app()
  const css = (pattern: string): string[] =>
    (routes.find((r) => r.pattern === pattern)?.css ?? []).map((file) => file.split('/').pop() as string)

  assert.ok(css('/app/ordinary/:category').includes('product-card.css'))
  assert.equal(css('/app/article').includes('product-card.css'), false)
  assert.ok(css('/app/dashboard').includes('dashboard.css'))
  assert.equal(css('/app/article').includes('dashboard.css'), false)
})
