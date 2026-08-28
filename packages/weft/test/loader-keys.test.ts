import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, serveApp, type Serving } from '../src/serve.ts'

/**
 * A cached slot whose loader reads the request, answered for the request that asked.
 *
 * The demo's feed declares `cache: { class: 'public', ttl: '30s', swr: '5m' }` on a body whose
 * loader reads `ctx.query('rows')`. The compiler infers a *fragment's* reads, and a route's loader
 * lives in a `.data.ts` it never read — so `route:rows` was not in the effect set, the key could
 * not contain it, and whichever value rendered first answered for every other one. `?rows=200`
 * came back with twenty rows for thirty seconds and then five minutes of stale-while-revalidate.
 *
 * Nothing in the framework said a word. `weft build` reported the fragment's reads and called the
 * page dynamic for the right reason; `weft verify --probe` was silent; every test passed. So this
 * one goes through the front door and asks for two row counts, because the bug is only visible
 * from outside — a unit test of the key would have agreed with itself.
 *
 * The other half is asserted too, and it is the half a careless fix breaks: two requests that ask
 * the same thing still share an entry. Turning the key into the whole query string, or refusing to
 * cache a slot whose loader reads anything, would both pass the first assertion and give up the
 * mechanism.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

let started: Promise<Serving> | null = null
function app(): Promise<Serving> {
  started ??= (async () => {
    const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0 }))
    servers.push(serving)
    return serving
  })()
  return started
}

async function feed(serving: Serving, rows: number): Promise<{ count: string; at: string }> {
  const html = await (await fetch(`${serving.url}app/feed?rows=${rows}`)).text()
  const count = /class="count">(\d+)</.exec(html)?.[1]
  const at = /class="at">(\d+)</.exec(html)?.[1]
  assert.ok(count && at, `the feed did not render its count: ${html.slice(0, 200)}`)
  return { count, at }
}

test('a slot whose loader reads the query is cached per value, not once for all of them', async () => {
  const serving = await app()
  // Twenty first, so the entry that used to answer for everything is the small one — the failure
  // this guards was a *stale* answer rather than a missing one, and asking for more rows second is
  // what makes the two distinguishable.
  assert.equal((await feed(serving, 20)).count, '20')
  assert.equal(
    (await feed(serving, 200)).count,
    '200',
    'the twenty-row entry answered a request for two hundred',
  )
  assert.equal((await feed(serving, 20)).count, '20', 'and the other way round')
})

test('and two requests that ask the same thing still share one entry', async () => {
  const serving = await app()
  // The body reads the clock, so the render's own timestamp says whether it rendered again. A fix
  // that made every request its own key would pass the test above and fail this one, which is the
  // whole of what a cache is for.
  const first = await feed(serving, 140)
  const second = await feed(serving, 140)
  assert.equal(second.at, first.at, 'the same question was rendered twice inside its own ttl')
})
