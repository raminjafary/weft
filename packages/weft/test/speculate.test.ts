import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryStore } from '@weft/adapters'
import { createApp } from '../src/serve.ts'
import { createSpeculation } from '../src/speculate.ts'
import { adoptScript } from '../src/routes.ts'
import type { CompiledFragment } from '../src/compile.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

let built: Awaited<ReturnType<typeof createApp>> | null = null
async function app(): Promise<NonNullable<typeof built>> {
  built ??= await createApp(ROOT, { mode: 'dev', port: 0 })
  return built
}

/**
 * `.speculate()`, which was recorded in the plan and read by nothing.
 *
 * What it has to get right is *when*: a slot whose entry is fresh must not be re-rendered, or the
 * mechanism is a render per request with extra steps. So the assertions are a fresh entry that is
 * left alone, a missing one that is warmed, and the queue actually being drained — because before
 * this, `revalidateAfterResponse` collected tasks that nobody ran.
 */
test('a slot that declared speculation is warmed after the response, not during it', async () => {
  const ready = await app()
  const store = memoryStore()
  const warmed: { slot: string; route: string }[] = []
  const speculation = createSpeculation({
    routes: ready.routes,
    store,
    ports: { ...ready.ports, store },
    onWarmed: (route, slot) => warmed.push({ route, slot }),
  })

  assert.ok(speculation.patterns.length > 0, 'the demo declares speculation on at least one route')
  const pattern = speculation.patterns[0] as string

  const queued = await speculation.after(
    pattern,
    { category: 'pantry' },
    new URL('http://x/app/ordinary/pantry'),
  )
  assert.ok(queued.length > 0, `nothing was in the store, so ${pattern} had something to warm`)

  // Queued, and nothing has run: the whole point is that this is not on the request.
  assert.deepEqual(warmed, [])
  await speculation.drain()
  assert.equal(warmed.length, queued.length, 'and the queue is drained by somebody, which it was not before')

  // Now the entry is fresh, so there is nothing to do — a speculation that warms a fresh entry is
  // a render per request wearing a different name.
  const again = await speculation.after(
    pattern,
    { category: 'pantry' },
    new URL('http://x/app/ordinary/pantry'),
  )
  assert.deepEqual(again, [])
})

test('a route that declared nothing queues nothing, however many responses it serves', async () => {
  const ready = await app()
  const store = memoryStore()
  const speculation = createSpeculation({ routes: ready.routes, store, ports: { ...ready.ports, store } })
  const quiet = ready.routes.find((route) => !speculation.patterns.includes(route.pattern))
  assert.ok(quiet, 'the demo has routes that declare no speculation')
  assert.deepEqual(await speculation.after(quiet.pattern, {}, new URL(`http://x${quiet.pattern}`)), [])
})

/**
 * The other half of the same pair: a declared refresh interval reaching the client that has to act
 * on it. It travels in the adopt payload, and only for a slot the channel can actually refresh —
 * an interval on a region nothing can refresh is a timer that asks nobody.
 */
test('a declared refresh interval travels to the client, and only for a live region', async () => {
  const ready = await app()
  const fragment = Object.values(ready.compiled.fragments)[0] as CompiledFragment
  const values = {} as Record<string, never>

  const live = adoptScript('body', fragment, values, {
    live: true,
    refresh: { everyMs: 30_000, when: ['visible'] },
  })
  assert.ok(live?.includes('"refresh"'))
  assert.ok(live?.includes('30000'))

  const inert = adoptScript('body', fragment, values, { live: false, refresh: { everyMs: 30_000 } })
  assert.ok(
    inert === null || !inert.includes('"refresh"'),
    'a region the channel cannot refresh gets no timer',
  )
})
