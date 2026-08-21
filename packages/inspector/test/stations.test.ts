import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from 'weft/server'
import { fragmentIR, slotHoles } from 'weft'
import { coverage, hasSpecs, missingSpecFiles } from '../app/lib/index-page.ts'
import { HANDLERS } from '../app/lib/stations/index.ts'
import { STATIONS } from '../app/lib/stations.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * The inspector, built the way `weft dev` builds it. Once, for every test that needs it.
 *
 * Building it rather than compiling a hand-written file list is the point: if the convention
 * cannot express the framework's own inspector, these fail.
 */
let built: Awaited<ReturnType<typeof createApp>> | null = null

async function app(): Promise<NonNullable<typeof built>> {
  built ??= await createApp(ROOT, { mode: 'dev' })
  return built
}
/**
 * The promise the inspector makes is that it is **not a subset**: if a capability is in the specs, it
 * has a station. That is only a promise if it is checked, so these are the checks.
 *
 * They are deliberately about honesty rather than about behaviour. Whether a station is a good
 * explanation is not testable; whether it exists, whether it runs, and whether it claims to do
 * something it does not are all testable, and each of those is a way a demo goes bad quietly.
 */
test('every spec document has at least one station claiming it', () => {
  assert.ok(hasSpecs(), 'run from the repository root, where spec/ is')
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
  for (const id of ids) {
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

/**
 * The fixtures the stations demonstrate against, compiled by the real compiler.
 *
 * Each one exists for a case a station is about: a fragment that reads nothing, one that reads
 * identity, one that reads the clock, one with a signal. Their effect sets are asserted here so a
 * change that alters a fragment's cache class fails the build rather than being quietly wrong on
 * the station that claims it.
 */
test('every fragment the stations render compiles, and the document leaves the boundaries they fill', async () => {
  await app()
  assert.deepEqual(slotHoles(fragmentIR('layout')), ['panel', 'body', 'readout'])
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
  assert.equal(
    fragmentIR('fragment:interactive').entry.signals.length,
    1,
    'the client stations need a signal to demonstrate',
  )
  assert.ok(fragmentIR('fragment:interactive').entry.derived.length >= 2, 'and at least two derived values')
  assert.ok(
    fragmentIR('fragment:interactive').entry.wiring.some((w) => w.op === 'prop'),
    'and a prop binding, which is what the controls station is about',
  )
})
