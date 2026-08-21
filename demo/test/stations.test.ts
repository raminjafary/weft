import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coverage, missingSpecFiles, specDocuments } from '../src/index-page.ts'
import { HANDLERS } from '../src/stations/index.ts'
import { SHOWCASES, STATIONS } from '../src/stations.ts'
import { fileURLToPath } from 'node:url'
import { createApp } from 'weft/server'
import { compileDemo, slotBindings } from '../src/compile.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * The demo, built the way `weft dev` builds it.
 *
 * Once, for every test below that needs it. Building it here rather than compiling a hand-written
 * file list is the point of the migration: if the convention cannot produce this application, these
 * tests fail — which is a stronger statement than "the fragments compile".
 */
let built: Awaited<ReturnType<typeof createApp>> | null = null

async function app(): Promise<NonNullable<typeof built>> {
  built ??= await createApp(ROOT, { mode: 'dev' })
  return built
}

/**
 * The promise this demo makes is that it is **not a subset**: if a capability is in the specs, it
 * has a station. That is only a promise if it is checked, so these are the checks.
 *
 * They are deliberately about honesty rather than about behaviour. Whether a station is a good
 * explanation is not testable; whether it exists, whether it runs, and whether it claims to do
 * something it does not are all testable, and each of those is a way a demo goes bad quietly.
 */
test('every spec document has at least one station claiming it', () => {
  const uncovered = coverage()
    .filter((row) => row.stations.length === 0)
    .map((row) => row.doc)
  assert.deepEqual(
    uncovered,
    [],
    'a capability shipped without a station. Add one, or say why the document is not a capability',
  )
})

test('no station claims a spec document that does not exist', () => {
  assert.deepEqual(missingSpecFiles(), [], 'a station points at a document that has been renamed or removed')
})

test('a station marked live has a handler, and a handler belongs to a live station', () => {
  const live = STATIONS.filter((s) => s.status === 'live')
    .map((s) => s.id)
    .sort()
  const handlers = Object.keys(HANDLERS).sort()
  assert.deepEqual(
    live.filter((id) => !handlers.includes(id)),
    [],
    'marked live with nothing to run: the index would advertise a page that does not work',
  )
  assert.deepEqual(
    handlers.filter((id) => !live.includes(id)),
    [],
    'a handler exists but the station is not marked live, so nobody can reach it',
  )
})

test('a refused station names the roadmap entry that explains it', () => {
  for (const station of STATIONS.filter((s) => s.status === 'refused')) {
    assert.ok(
      station.roadmap,
      `${station.id} is refused and does not say where the explanation is. Better an honest empty station than a mock, but not better than a dead end`,
    )
  }
})

test('station ids are unique and url-safe', () => {
  const ids = STATIONS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'two stations share an id, so one of them is unreachable')
  for (const id of [...ids, ...SHOWCASES.map((s) => s.id)]) {
    assert.match(id, /^[a-z0-9-]+$/, `${id} is not a usable path segment`)
  }
})

test('every station says what it shows and what the control is', () => {
  for (const station of STATIONS) {
    assert.ok(station.shows.length > 20, `${station.id} does not say what it shows`)
    assert.ok(station.control.length > 3, `${station.id} does not say what the control is`)
    assert.ok(station.covers.length > 0, `${station.id} claims no spec document`)
  }
})

test('every showcase says what shape of application it stands for', () => {
  for (const showcase of SHOWCASES) {
    assert.ok(showcase.standsFor.length > 20, `${showcase.id} does not say what it stands for`)
    assert.ok(
      showcase.leansOn.length >= 3,
      `${showcase.id} leans on fewer than three capabilities: is it a showcase?`,
    )
  }
})

/**
 * The demo's own fragments, compiled by the real compiler. If this fails the demo is serving a
 * page whose template did not build, which is the one failure a running server would hide until
 * somebody opened that page.
 */
test('every demo fragment compiles, and the shells leave the boundaries the pages fill', async () => {
  await app()
  const compiled = await compileDemo()
  assert.deepEqual(slotBindings(compiled.shell), ['panel', 'body', 'readout'])
  assert.deepEqual(slotBindings(compiled['dash-shell'] as never), [
    'panel',
    'traffic',
    'revenue',
    'errors',
    'slowest',
    'readout',
  ])
  // The effect sets the cache stations are about, asserted so a change to a fragment that changes
  // its class fails here rather than being quietly wrong on a station page.
  assert.deepEqual(compiled.article.entry.effects.reads, [], 'article.tsx is the static case')
  assert.deepEqual(
    compiled.cart.entry.effects.reads,
    ['cookie:currency', 'identity'],
    'cart.tsx is the private case',
  )
  assert.deepEqual(compiled.feed.entry.effects.reads, ['time'], 'feed.tsx is the case that forces a ttl')
  assert.equal(
    compiled.interactive.entry.signals.length,
    1,
    'the client stations need a signal to demonstrate',
  )
  assert.ok(compiled.interactive.entry.derived.length >= 2, 'and at least two derived values')
  assert.ok(
    compiled.interactive.entry.wiring.some((w) => w.op === 'prop'),
    'and a prop binding, which is what the controls station is about',
  )
})

/**
 * The route table is the file tree, so this is the assertion that the file tree still means what
 * the demo says it means. A station whose file was renamed, a showcase that lost its declaration,
 * or a layout that stopped declaring a hole all fail here rather than at the first request.
 */
test('the convention produces a route for every station and every showcase', async () => {
  const { routes } = await app()
  const patterns = new Set(routes.map((route) => route.pattern))

  const missing = STATIONS.map((station) => `/s/${station.id}`).filter((path) => !patterns.has(path))
  assert.deepEqual(missing, [], 'a station with no route file is a station the index links to a 404')

  const showcases = ['/app/ordinary/:category', '/app/feed', '/app/cart', '/app/article', '/app/dashboard']
  assert.deepEqual(
    showcases.filter((path) => !patterns.has(path)),
    [],
  )
  assert.ok(patterns.has('/live/race/:order'), 'the streaming race is a route, not a hand-built response')

  // Every station page is the same three regions, which is what makes one document serve all of
  // them — and the dashboard is the one page that needed a different shape.
  for (const station of STATIONS) {
    const route = routes.find((r) => r.pattern === `/s/${station.id}`)
    assert.deepEqual(
      route?.plan.slots.map((slot) => slot.name),
      ['panel', 'body', 'readout'],
      `/s/${station.id} does not have the three station regions`,
    )
  }
  const dashboard = routes.find((r) => r.pattern === '/app/dashboard')
  assert.deepEqual(
    dashboard?.plan.slots.map((slot) => slot.name),
    ['panel', 'traffic', 'revenue', 'errors', 'slowest', 'readout'],
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

test('the spec walk finds the documents it is supposed to', () => {
  const docs = specDocuments()
  assert.ok(docs.includes('kernel/budgets.md'))
  assert.ok(docs.includes('warp/warp-1.md'))
  assert.equal(docs.includes('FINDINGS.md'), false, 'FINDINGS describes the project, not a capability')
  assert.equal(docs.includes('VERSIONING.md'), false)
})
