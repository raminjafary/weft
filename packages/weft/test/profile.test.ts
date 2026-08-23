import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, serveApp, type Serving } from '../src/serve.ts'
import {
  ageOf,
  createRecorder,
  decide,
  likelyNext,
  MIN_SAMPLES,
  readProfile,
  type Profile,
} from '../src/profile.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
  await rm(join(ROOT, '.weft', 'profile.json'), { force: true })
})

/**
 * A plan generated from measurement.
 *
 * The assertions worth having are about the decisions rather than about the numbers: that a slow
 * region on a page with a fast one is streamed, that a page whose regions are all fast is left
 * buffered so the out-of-order filler stays off the wire, and — the one that stops this being a
 * plausible-looking mistake — that a slot with two samples decides nothing at all.
 */
function clock(): () => number {
  let t = 0
  return () => (t += 1)
}

function observed(ms: number[], bytes = 4_096): { ms: number[]; bytes: number } {
  return { ms, bytes }
}

function recorded(
  routes: Record<string, Record<string, { ms: number[]; bytes: number }>>,
  from: Record<string, Record<string, number>> = {},
): Profile {
  const recorder = createRecorder(clock())
  for (const [route, slots] of Object.entries(routes)) {
    recorder.request(route)
    for (const [slot, sample] of Object.entries(slots)) {
      for (const ms of sample.ms) recorder.render(route, slot, ms, sample.bytes)
    }
  }
  const profile = recorder.profile()
  for (const [route, sources] of Object.entries(from)) {
    const entry = profile.routes[route]
    if (entry) entry.from = sources
  }
  return profile
}

const many = (ms: number): number[] => Array.from({ length: MIN_SAMPLES + 4 }, () => ms)

test('a slow region on a page with a fast one is streamed, fastest first', () => {
  const decisions = decide(
    recorded({
      '/dash': {
        header: observed(many(3)),
        revenue: observed(many(180)),
        traffic: observed(many(90)),
      },
    }),
  )
  const route = decisions.routes.find((r) => r.route === '/dash')
  const by = (slot: string) => route?.slots.find((s) => s.slot === slot)

  assert.equal(by('header')?.delivery, 'buffered', '3ms is not worth its own flush')
  assert.equal(by('revenue')?.delivery, 'stream')
  assert.equal(by('traffic')?.delivery, 'stream')
  assert.ok(
    (by('traffic')?.prio ?? 0) > (by('revenue')?.prio ?? 0),
    'the region that can paint sooner goes first',
  )
  assert.match(by('revenue')?.because ?? '', /p95 180ms over 12 renders/)
})

test('a page whose regions are all fast keeps the filler off the wire', () => {
  const decisions = decide(recorded({ '/article': { body: observed(many(4)), aside: observed(many(6)) } }))
  const route = decisions.routes.find((r) => r.route === '/article')
  assert.deepEqual(
    route?.slots.map((s) => s.delivery),
    ['buffered', 'buffered'],
  )
  assert.match(route?.slots[0]?.because ?? '', /in-order, so the filler is not on the wire/)
})

test('a page whose regions are all slow is not streamed either, because there is nothing to wait behind', () => {
  const decisions = decide(recorded({ '/slow': { a: observed(many(200)), b: observed(many(210)) } }))
  const route = decisions.routes.find((r) => r.route === '/slow')
  assert.deepEqual(
    route?.slots.map((s) => s.delivery),
    ['buffered', 'buffered'],
    'a reader waits either way, and out-of-order costs the filler',
  )
})

test('a region too small to be worth a flush is buffered however slow it is', () => {
  const decisions = decide(
    recorded({
      '/page': { body: observed(many(4)), badge: { ms: many(120), bytes: 64 } },
    }),
  )
  const badge = decisions.routes[0]?.slots.find((s) => s.slot === 'badge')
  assert.equal(badge?.delivery, 'buffered')
  assert.match(badge?.because ?? '', /too small to be worth its own flush/)
})

test('two samples decide nothing, and the report says which slots were skipped', () => {
  const decisions = decide(recorded({ '/thin': { body: observed([9, 400]) } }))
  assert.deepEqual(decisions.routes[0]?.slots, [], 'nothing decided')
  assert.deepEqual(decisions.thin, [{ route: '/thin', slot: 'body', renders: 2 }])
})

test('a transition seen often enough is worth staging, and a rare one is not', () => {
  const profile = recorded(
    { '/app/cart': { body: observed(many(20)) }, '/app/feed': { body: observed(many(20)) } },
    { '/app/cart': { '/app/feed': 40, '/app/article': 1 } },
  )
  const cart = decide(profile).routes.find((r) => r.route === '/app/cart')
  assert.deepEqual(cart?.stage, ['/app/feed'], 'one in forty is not a pattern')

  // Read the other way round, which is what a navigation needs: from here, where next.
  assert.deepEqual(likelyNext(profile), { '/app/feed': ['/app/cart'] })
})

test('what a profile refuses to decide is printed rather than left as a silence', () => {
  const refused = decide(recorded({})).refused.map((r) => r.what)
  assert.deepEqual(refused, ['chunk packing', 'V8 compile hints', 'a cache key'])
})

test('a recording of real traffic decides the demo plan, and the plan is generated from it', async () => {
  await rm(join(ROOT, '.weft', 'profile.json'), { force: true })
  const recording = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, profile: true }))
  servers.push(recording)
  assert.ok(recording.app.recorder, 'a process asked to record has a recorder')

  // Enough requests that a slot passes the sample floor, against the page whose regions differ
  // most in cost.
  for (let i = 0; i < MIN_SAMPLES + 2; i++) {
    const response = await fetch(new URL('/app/dashboard', recording.url), {
      headers: { referer: new URL('/app/feed', recording.url).href },
    })
    await response.arrayBuffer()
  }
  await recording.close()
  servers.pop()

  const profile = await readProfile(ROOT, '.weft')
  assert.ok(profile, 'the recording was written on the way out')
  const dashboard = profile.routes['/app/dashboard']
  assert.ok(dashboard, 'the route that was asked for is in the recording')
  assert.ok(dashboard.requests >= MIN_SAMPLES, `${dashboard.requests} requests recorded`)
  assert.deepEqual(dashboard.from, { '/app/feed': MIN_SAMPLES + 2 }, 'where the readers came from')
  assert.equal(ageOf(profile, profile.recordedAt), 'just now')

  const decisions = decide(profile)
  const decided = decisions.routes.find((r) => r.route === '/app/dashboard')
  assert.ok(decided && decided.slots.length > 0, 'the dashboard has enough renders to decide')

  // And the plan generated next reflects it. The dashboard's panels are deliberately slow and its
  // chrome is not, so this is the shape a profile is for.
  const planned = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, profile: true }))
  servers.push(planned)
  const plan = planned.app.routes.find((r) => r.pattern === '/app/dashboard')?.plan
  assert.ok(plan)
  for (const decision of decided.slots) {
    const spec: { name: string; delivery: string } | undefined = plan.slots.find(
      (slot) => slot.name === decision.slot,
    )
    if (!spec || decision.delivery === null) continue
    assert.equal(
      spec.delivery,
      decision.delivery,
      `${decision.slot} was planned as the measurement decided: ${decision.because}`,
    )
  }
})
