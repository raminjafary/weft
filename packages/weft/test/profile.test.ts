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
  MIN_DESCRIBED,
  MIN_SAMPLES,
  readProfile,
  type Profile,
} from '../src/profile.ts'
import { frame, residentFrame, WARP_VERSION, type Frame } from '@weft/warp'
import { TEMPLATE_IR_VERSION } from '@weft/ir'
import type { ChannelSink } from '@weft/kernel'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

/** A channel that keeps what it was sent, so a PLAN can be read out of it. */
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

test('a description that is followed often enough is worth sending, and a rare one is not', () => {
  // The one thing about discovery that was never a measurement. A `PLAN` frame describes routes a
  // client has not been to; whether that pays is not in the file tree, so the recording counts
  // descriptions handed out against descriptions used.
  const recorder = createRecorder(clock())
  for (let i = 0; i < MIN_DESCRIBED; i++) {
    recorder.described('/checkout')
    recorder.described('/legal/terms')
  }
  for (let i = 0; i < 4; i++) recorder.followed('/checkout')
  recorder.followed('/legal/terms')

  const decisions = decide(recorder.profile())
  const checkout = decisions.discover.find((d) => d.route === '/checkout')
  const terms = decisions.discover.find((d) => d.route === '/legal/terms')

  assert.equal(checkout?.describe, true, 'half the descriptions were used')
  assert.match(checkout?.because ?? '', /saves a round trip and a server render/)
  assert.equal(terms?.describe, false, 'one in eight is not worth the bytes')
  assert.match(terms?.because ?? '', /the bytes buy nothing here/)
})

test('a route described too few times decides nothing, so an unmeasured one keeps describing', () => {
  // The same rule delivery follows: a recording of last Tuesday cannot quietly turn a feature off for
  // a route it barely saw.
  const recorder = createRecorder(clock())
  for (let i = 0; i < MIN_DESCRIBED - 1; i++) recorder.described('/checkout')

  assert.deepEqual(decide(recorder.profile()).discover, [])
})

test('what a profile refuses to decide is printed rather than left as a silence', () => {
  const refused = decide(recorded({})).refused.map((r) => r.what)
  assert.deepEqual(refused, [
    'chunk packing',
    'V8 compile hints',
    // Discovery is now two halves: whether a description was *followed* is measured and decided, and
    // whether a prefix nobody has ever asked about is worth describing has no observation behind it.
    // Both are stated, because half a capability that reads as none is worse than the whole refusal.
    'whether a subtree is worth describing before anybody has looked at it *at all*',
    'a cache key',
  ])
})

test('a real recording counts the descriptions it hands out and the ones a client uses', async () => {
  // End to end, because the two halves are recorded in two places: the extender describes when a
  // channel opens, and the stager is what says a description was used.
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, profile: true }))
  servers.push(serving)
  const recorder = serving.app.recorder as NonNullable<typeof serving.app.recorder>

  const id = 'described'
  serving.app.at.set(id, { path: '/app/feed', cookie: '' })
  serving.app.hub.open({ binding: 'socket', open: true, send: () => {}, close: () => {} }, id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])

  const described = serving.app.at.get(id)?.described
  assert.ok(described?.has('/app/feed'), 'the connection was told about the page it is on')
  assert.equal(
    recorder.profile().routes['/app/feed']?.described,
    1,
    'and the recording counted the description',
  )

  await serving.app.hub.receive(id, [frame('WARM', { at: '/app/feed', epoch: 'n-1' })])
  assert.equal(
    recorder.profile().routes['/app/feed']?.followed,
    1,
    'staging a described route is that description being used',
  )
})

test('a stage of a route nobody described is a hover on a link, not a description that paid', async () => {
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, profile: true }))
  servers.push(serving)
  const recorder = serving.app.recorder as NonNullable<typeof serving.app.recorder>

  const id = 'undescribed'
  // No RESIDENT, so nothing was described — and the connection is registered, so the stage resolves.
  serving.app.at.set(id, { path: '/app/feed', cookie: '' })
  serving.app.hub.open({ binding: 'socket', open: true, send: () => {}, close: () => {} }, id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])
  // `/app/cart` shares the feed's shell but is not in the demo's transition table, so it was never
  // described. Counting this would make every description look successful.
  await serving.app.hub.receive(id, [frame('WARM', { at: '/app/cart', epoch: 'n-2' })])

  assert.equal(recorder.profile().routes['/app/cart']?.followed ?? 0, 0)
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

/**
 * The one decision the profile measured and nobody read, now read.
 *
 * `RouteDecision.stage` records which pages readers arrive from often enough for staging to pay.
 * Until this reached the wire, `weft profile` printed it and the client stated every hovered link
 * regardless — which is the guess the profile layer exists instead of. `stage: false` on a described
 * route is that decision, per source page: readers of the cart go to checkout, and readers of the
 * article do not.
 */
test('a route nobody arrives at from here is described as not worth staging', async () => {
  await rm(join(ROOT, '.weft', 'profile.json'), { force: true })
  const recording = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, profile: true }))
  servers.push(recording)

  // Every reader of the dashboard arrived from the article. Nobody arrived from the feed.
  for (let i = 0; i < MIN_SAMPLES + 2; i++) {
    await (
      await fetch(new URL('/app/dashboard', recording.url), {
        headers: { referer: new URL('/app/article', recording.url).href },
      })
    ).arrayBuffer()
  }
  await recording.close()
  servers.pop()

  const profile = await readProfile(ROOT, '.weft')
  assert.ok(profile)
  assert.deepEqual(
    decide(profile).routes.find((r) => r.route === '/app/dashboard')?.stage,
    ['/app/article'],
    'the recording says the dashboard is worth staging from the article and from nowhere else',
  )

  const planned = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, profile: true }))
  servers.push(planned)

  const described = async (at: string): Promise<Record<string, { stage?: boolean }>> => {
    const id = `c-${Math.random().toString(36).slice(2, 8)}`
    planned.app.at.set(id, { path: at, cookie: '' })
    planned.app.hub.open(sink(), id)
    await planned.app.hub.receive(id, [
      residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
    ])
    const out = await planned.app.hub.receive(id, [frame('WARM', { plan: '/app/*' })])
    const plan = out.find((f) => f.kind === 'PLAN') as Frame
    assert.ok(plan, `no PLAN came back for a connection on ${at}`)
    const routes = JSON.parse(new TextDecoder().decode(plan.body)) as {
      pattern: string
      stage?: boolean
    }[]
    return Object.fromEntries(routes.map((route) => [route.pattern, route]))
  }

  const fromFeed = await described('/app/feed')
  assert.equal(
    fromFeed['/app/dashboard']?.stage,
    false,
    'nobody has ever gone feed → dashboard, so hovering that link should not fetch a document',
  )

  const fromArticle = await described('/app/article')
  assert.equal(
    fromArticle['/app/dashboard']?.stage,
    undefined,
    'from the page readers do arrive from, the field is absent and staging is on',
  )

  // A route the recording saw no arrivals to at all is unmeasured, not refused: a cold recording
  // may not quietly switch staging off for a page nobody has reached yet.
  assert.equal(fromFeed['/app/cart']?.stage, undefined, 'unmeasured keeps the behaviour it had')
})
