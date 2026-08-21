import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coverage, missingSpecFiles, specDocuments } from '../src/index-page.ts'
import { HANDLERS } from '../src/stations/index.ts'
import { SHOWCASES, STATIONS } from '../src/stations.ts'
import { compileDemo, slotBindings } from '../src/compile.ts'

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

test('the spec walk finds the documents it is supposed to', () => {
  const docs = specDocuments()
  assert.ok(docs.includes('kernel/budgets.md'))
  assert.ok(docs.includes('warp/warp-1.md'))
  assert.equal(docs.includes('FINDINGS.md'), false, 'FINDINGS describes the project, not a capability')
  assert.equal(docs.includes('VERSIONING.md'), false)
})
