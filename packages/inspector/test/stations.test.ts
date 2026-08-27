import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '@weft/core/server'
import { fragmentIR, slotHoles } from '@weft/core'
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

test('a refused station is not also a running one, and still names the spec it is about', () => {
  // Better an honest empty station than a mock, but not better than a dead end: a page saying a
  // capability does not exist has to say which capability, and cannot quietly have a handler.
  for (const station of STATIONS.filter((s) => s.status === 'refused')) {
    assert.ok(station.covers.length, `${station.id} is refused and names no spec document`)
    assert.equal(
      Object.keys(HANDLERS).includes(station.id),
      false,
      `${station.id} claims the capability does not exist and has something registered to run`,
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
  assert.deepEqual(fragmentIR('fragment:static').entry.effects.reads, [], 'article.tsx is the static case')
  assert.deepEqual(
    fragmentIR('fragment:private').entry.effects.reads,
    ['cookie:currency', 'identity'],
    'cart.tsx is the private case',
  )
  assert.deepEqual(
    fragmentIR('fragment:clock').entry.effects.reads,
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

/**
 * Every live station, run.
 *
 * The checks above assert that a live station has a handler; none of them asserted that the
 * handler works, and the gap hid a real one — the worker-pool station's address pointed at a
 * module path that does not exist, so the station that exists to show a budget being *enforced*
 * was showing a module-not-found instead. A station is a claim that runs, so the gate is that it
 * runs.
 *
 * Controls are left at their defaults: this is a smoke test over the page a visitor gets first,
 * not an assertion about what each station measures.
 */
test('every live station renders its three parts with its controls at their defaults', async () => {
  await app()
  const failures: string[] = []
  for (const [id, handler] of Object.entries(HANDLERS)) {
    try {
      const parts = await handler({ query: () => undefined } as never)
      for (const which of ['panel', 'body', 'readout'] as const) {
        const content = parts[which]
        if (content === undefined) continue
        const html =
          typeof content === 'function' ? await content({ query: () => undefined } as never) : content
        if (!html.length) failures.push(`${id}: ${which} is empty`)
        // The failure mode this test was written for: a station that runs, renders, and reports a
        // module it could not import where the number was supposed to be.
        if (html.includes('Cannot find module')) failures.push(`${id}: ${which} reports a missing module`)
      }
    } catch (error) {
      failures.push(`${id}: ${(error as Error).message}`)
    }
  }
  assert.deepEqual(failures, [])
})
