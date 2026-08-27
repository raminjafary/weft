import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, serveApp } from '@weftjs/core/server'
import { fragmentIR, slotHoles } from '@weftjs/core'
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
  // Port zero: one of these tests serves this application, and the demo's own config asks for
  // 4173 — which is the port somebody running `pnpm demo` is already listening on.
  built ??= await createApp(ROOT, { mode: 'dev', port: 0 })
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

/** A concrete URL against a route pattern. `:name` takes a segment, `*` takes the rest. */
function matches(pattern: string, href: string): boolean {
  const source = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment === '*' ? '.*' : segment))
    .join('/')
  return new RegExp(`^${source}$`).test(href)
}

/**
 * Both directions, because each one catches a different way a demo goes wrong.
 *
 * A link to a page that does not exist is a 404 somebody hits; a page nothing links to is work
 * nobody sees. The nav had both at once: it pointed at `/spec`, which is a page in the *inspector*,
 * and nothing anywhere linked the streaming race.
 */
test('every link is a route, and every route is linked', async () => {
  const { routes, config } = await app()
  const links = [...(config.nav ?? []).map((item) => item.href), ...SHOWCASES.map((s) => s.href)]

  assert.deepEqual(
    links.filter((href) => !routes.some((route) => matches(route.pattern, href))),
    [],
    'a link in the nav or on the index points at a page this application does not have',
  )
  assert.deepEqual(
    routes.map((route) => route.pattern).filter((pattern) => !links.some((href) => matches(pattern, href))),
    [],
    'a route nothing links to. Put it in the nav, or introduce it on the index',
  )
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
  assert.deepEqual(names, ['cart.add', 'cart.checkout', 'cart.setQty', 'feed.tick'])
  for (const entry of intents.entries) {
    assert.match(entry.id, /^[0-9a-f]{6}$/, 'an intent id is six hex characters and nothing else')
    assert.match(entry.module, /^app\/intents\//)
  }
  // What the manifest carries about authority, which is what the config is checked against.
  const checkout = intents.entries.find((entry) => entry.name === 'cart.checkout')
  assert.deepEqual(checkout?.capabilities, ['cart:checkout'])
  assert.equal(checkout?.signed, true)
  assert.deepEqual(
    intents.entries.filter((entry) => entry.signed).map((entry) => entry.name),
    ['cart.checkout'],
    'exactly one intent here asks for the strongest gate, and it is the one that spends money',
  )
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

/**
 * One route with two params is two cached things.
 *
 * `/app/ordinary/:category` is one route, one slot and one sealed template, and the loader that
 * picks a category lives in a `.data.ts` — which the compiler never reads. So `route:category` is
 * not in the effect set, the key cannot contain it, and for as long as a slot's cache identity was
 * the route pattern and the slot name, whichever category rendered first answered for the other.
 * It is the same mistake the generated plan made one level up, where four slots bound to `markup`
 * shared a key, and it needed a second page on the same route to become visible.
 *
 * The order matters, so both directions are asked: a cache hit that serves the wrong page looks
 * exactly like a correct render of whichever page happened to be requested first.
 */
test('a route param is part of what a slot on a generated route is', async () => {
  // The application these tests already built, served — rather than a second one. Building twice
  // means staging the framework's own `.tsx` into `.weft` twice, and `weft build` in the L0 tests
  // empties that directory from another process.
  const serving = await serveApp(await app())
  try {
    const heading = async (path: string): Promise<string> => {
      const body = await (await fetch(new URL(path, serving.url))).text()
      return /<h2[^>]*>([^<]*)</.exec(body)?.[1] ?? ''
    }
    assert.equal(await heading('/app/ordinary/household'), 'Household')
    assert.equal(await heading('/app/ordinary/pantry'), 'Pantry', 'the first render answered for the second')
    assert.equal(await heading('/app/ordinary/household'), 'Household')
  } finally {
    await serving.close()
  }
})

/**
 * The conditional page, and the two things it has to get right.
 *
 * A strong tag is a promise that the same tag means the same bytes, so the first assertion is that
 * the tag is stable across two renders of a page whose slots all buffer. The second is the point of
 * having one at all: a reader who already holds those bytes is told so, and no body travels.
 *
 * The index declares `etag: true`; nothing else in the demo does, which is what makes the third
 * assertion meaningful — a streaming page does not quietly get one.
 */
test('a route that declared it answers a conditional request, and a streaming one does not', async () => {
  const serving = await serveApp(await app())
  const page = '/app/ordinary/pantry'
  try {
    const first = await fetch(new URL(page, serving.url))
    const tag = first.headers.get('etag')
    assert.ok(tag, 'the ordinary page declares etag: true')
    assert.equal(first.headers.get('content-length'), String((await first.arrayBuffer()).byteLength))

    const again = await fetch(new URL(page, serving.url))
    assert.equal(again.headers.get('etag'), tag, 'the same bytes have to produce the same tag')
    await again.arrayBuffer()

    const conditional = await fetch(new URL(page, serving.url), { headers: { 'if-none-match': tag } })
    assert.equal(conditional.status, 304)
    assert.equal((await conditional.arrayBuffer()).byteLength, 0)

    // `*` is "any representation you have", which for a page that exists is a match.
    const any = await fetch(new URL(page, serving.url), { headers: { 'if-none-match': '*' } })
    assert.equal(any.status, 304)
    await any.arrayBuffer()

    const stale = await fetch(new URL(page, serving.url), { headers: { 'if-none-match': '"nope"' } })
    assert.equal(stale.status, 200)
    assert.ok((await stale.text()).length > 0)

    // The feed streams, and a streaming response cannot carry a digest of something unfinished.
    const streamed = await fetch(new URL('/app/feed', serving.url))
    assert.equal(streamed.headers.get('etag'), null)
    await streamed.text()
  } finally {
    await serving.close()
  }
})
