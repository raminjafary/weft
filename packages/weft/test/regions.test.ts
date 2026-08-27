import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bindingExecutor, regionService } from '@weftjs/adapters'
import { TEMPLATE_IR_VERSION } from '@weftjs/ir'
import { verifyRegions } from '@weftjs/plan'
import { frame, residentFrame, str, WARP_VERSION, type Frame } from '@weftjs/warp'
import { regionProbe } from '@weftjs/kernel'
import type { ChannelSink, RegionBinding, Registry } from '@weftjs/kernel'
import { createApp, serveApp, type Serving } from '../src/serve.ts'
import type { GeneratedRoute } from '../src/routes.ts'

/**
 * Composition through the front door.
 *
 * Everything here was reachable before by importing the kernel, the plan layer and the adapters and
 * wiring a composer by hand — which is how the plan layer's own tests do it, and rightly, because
 * their subject is the composer. This file's subject is the *front door*: a route says a slot is a
 * region, `weft.config.ts` says where the region is, and nothing in between is written by hand.
 *
 * It runs against `demo/`, which depends on `weft` and nothing else. That is deliberate: if
 * composing a page needed the kernel or the adapters directly, this file could not exist.
 */
const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))
const REGIONS = new URL('../../../demo/app/lib/', import.meta.url).href

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

/** The search tier, as the demo's own config builds it: a real crash-domain boundary, no socket. */
function tier(revision = 'search-42') {
  return bindingExecutor({
    binding: regionService({ root: REGIONS, revision }),
    name: 'binding:search',
    timeoutMs: 500,
  })
}

function binding(overrides: Partial<RegionBinding> = {}): RegionBinding {
  const { address, ...rest } = {
    region: 'search',
    executor: 'binding:search',
    address: { module: './search-region.ts', export: 'search' } as RegionBinding['address'],
    contract: { id: 'search', version: '2.1.0', reads: ['route:q'] },
    revision: 'search-42',
    ...overrides,
  }
  return { ...rest, ...(address ? { address } : {}) }
}

async function app(overrides: Parameters<typeof createApp>[1] = {}): Promise<Serving> {
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0, ...overrides }))
  servers.push(serving)
  return serving
}

/** What a verification compares against: the registry this deployment bound, and what it binds. */
function context(serving: Serving): { registry?: Registry; executors: string[] } {
  return {
    ...(serving.app.ports.registry ? { registry: serving.app.ports.registry } : {}),
    executors: Object.keys(serving.app.config.executors),
  }
}

async function page(serving: Serving, path: string): Promise<string> {
  const response = await fetch(new URL(path, serving.url))
  return response.text()
}

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

async function channel(serving: Serving, at: string): Promise<string> {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: at, cookie: '' })
  serving.app.hub.open(sink(), id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta', 'patch'] }),
  ])
  return id
}

const utf8 = new TextDecoder()

test('a staged route arrives with its remote regions filled, under the epoch', async () => {
  // Without this the reader committed a route and then watched the parts of it that live somewhere
  // else assemble themselves, which is the one thing staging exists to prevent.
  const serving = await app()
  const id = await channel(serving, '/app/composed')
  const out = await serving.app.hub.receive(id, [frame('WARM', { at: '/app/composed?q=tea', epoch: 'n-1' })])

  const nav = out.find((f) => f.kind === 'NAV') as Frame
  assert.equal(str(nav, 'form'), 'slots', 'the same shell, so it can be given as regions')
  assert.equal(
    (str(nav, 's') ?? '').split(',').includes('search'),
    true,
    'and the region is one of the slots it says are coming',
  )

  const painted = out.filter((f) => f.kind !== 'NAV')
  const region = painted.find((f) => str(f, 's') === 'search') as Frame
  assert.ok(region, 'the region answered')
  assert.equal(str(region, 'epoch'), 'n-1', 'staged rather than painted: a commit decides when it shows')
  assert.match(
    utf8.decode(region.body as Uint8Array),
    /ceylon tea/,
    "and it was given the staged route's reads",
  )
})

test("a remote region is refreshable over the channel, because its freshness is not this deployment's to judge", async () => {
  const serving = await app()
  const id = await channel(serving, '/app/composed?q=tea')
  const out = await serving.app.hub.receive(id, [frame('REFRESH', { s: 'search' })])

  const region = out.find((f) => str(f, 's') === 'search') as Frame
  assert.ok(region, 'a REFRESH for a region reaches the deployment serving it')
  assert.equal(str(region, 'epoch'), undefined, 'a refresh of the page they are on paints on arrival')
  assert.match(utf8.decode(region.body as Uint8Array), /ceylon tea/)
})

test('a route declares a slot is a region, and the plan the convention generates says so', async () => {
  const serving = await app()
  const route = serving.app.routes.find((r) => r.pattern === '/app/composed')
  assert.ok(route, 'the composed page is a route like any other')

  const search = route.plan.slots.find((slot) => slot.name === 'search')
  assert.ok(search?.region, 'the slot carries a region declaration')
  assert.equal(search.region.locus, 'remote', 'the route said a boundary is crossed')
  assert.equal(search.region.contract?.id, 'search')
  assert.equal(
    search.executor,
    'region',
    'the reserved executor, meaning the registry decides — not the tier the config happens to bind',
  )
  // The whole point of the omission: nothing in the plan names a deployment, so rolling the region
  // is a registry write rather than a rebuild of this page.
  assert.equal(
    JSON.stringify(route.plan).includes('binding:search'),
    false,
    'the plan names no tier, which is what makes a roll a registry write',
  )
})

test('the region renders across the boundary, into the hole the layout left', async () => {
  const serving = await app()
  const html = await page(serving, '/app/composed?q=tea')

  assert.match(html, /data-weft-slot="search"/, 'the region fills its own hole')
  assert.match(html, /rendered by the search deployment/, 'and the bytes came from the far side')
  assert.match(
    html,
    /<li>ceylon tea<\/li>/,
    'the region was given the read its contract declared, resolved by the composite',
  )
  assert.equal(
    html.includes('<li>sumac</li>'),
    false,
    'and it filtered on that read rather than rendering everything',
  )
  assert.equal(html.includes('data-degraded'), false, 'nothing degraded')
})

test('a document composed of described regions is still cacheable, and the class comes from the contract', async () => {
  const serving = await app()
  const response = await fetch(new URL('/app/composed', serving.url))
  assert.equal(
    response.headers.get('cache-control'),
    'public, max-age=300',
    'a region that describes its reads leaves the document shareable',
  )
})

test('a region one minor ahead of the shell degrades to the declared fallback, with both versions named', async () => {
  // The window CI cannot close: the contract test passed when the type was published, and this is
  // the deploy after it. Nothing is rebuilt — the registry points at a different export.
  const serving = await app({
    executors: { 'binding:search': tier() },
    regions: [binding({ address: { module: './search-region.ts', export: 'searchAhead' } })],
  })
  const html = await page(serving, '/app/composed?q=tea')

  assert.match(html, /data-degraded/, 'the region degraded rather than the page failing')
  assert.match(html, /Search is unavailable/, 'to the fallback this route declared')
  assert.equal(
    html.includes('rendered by the search deployment'),
    false,
    'and none of the mismatched answer reached the page',
  )
  assert.match(html, /Why this is one mechanism and not two/, 'every other region rendered')
})

test('a deployment that binds no region at all refuses by name rather than rendering an empty hole', async () => {
  const serving = await app({ executors: { 'binding:search': tier() }, regions: [] })
  assert.deepEqual(
    serving.app.regions?.errors.map((issue) => issue.code),
    ['E_NO_SUCH_REGION'],
    'and it is said at startup, where somebody can act on it, not only at request time',
  )
  assert.equal(
    serving.app.warnings.some((warning) => warning.includes('E_NO_SUCH_REGION')),
    true,
    'printed with the banner, because a gate that will refuse every request should say so first',
  )
})

test('a registry that quietly makes a remote region local is an error, not a faster page', async () => {
  const serving = await app({
    executors: { 'binding:search': tier() },
    // No address, because the registry says this process renders it — which contradicts the plan.
    regions: [binding({ executor: 'inline', address: undefined as never })],
  })
  const report = await verifyRegions(
    serving.app.routes.map((r) => r.plan).filter((p) => p.slots.some((s) => s.region)),
    { ...context(serving) },
  )
  assert.deepEqual(
    report.errors.map((issue) => issue.code),
    ['E_REGION_LOCUS_MISMATCH'],
    'the hop count and the document cache class were both decided on the declaration',
  )
})

test('the probe asks the running region what it serves, through the path that will serve traffic', async () => {
  const serving = await app()
  const report = await verifyRegions(
    serving.app.routes.map((r) => r.plan).filter((p) => p.slots.some((s) => s.region)),
    { ...context(serving) },
    regionProbe(serving.app.ports),
  )
  assert.deepEqual(report.errors, [], 'the deployment agrees with itself')
  const [status] = report.regions
  assert.equal(status?.serving?.contract, 'search@2.1.0', 'and said so itself, rather than being assumed')
  assert.equal(status?.serving?.revision, 'search-42', 'naming the build that answered')
})

test('a channel is told what the shell exposes, unasked, because the client cannot ask', async () => {
  const serving = await app()
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: '/app/composed', cookie: '' })
  const held = sink()
  serving.app.hub.open(held, id)
  const out = await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])

  const declared = out.find((f) => f.kind === 'SIGNAL' && f.header.name === undefined) as Frame
  assert.ok(declared, 'one frame, the whole set, when the connection opens')
  const values = JSON.parse(utf8.decode(declared.body as Uint8Array)) as Record<string, string>
  assert.deepEqual(
    Object.keys(values).sort(),
    ['cartCount', 'currency'],
    'every exposed name, in one frame, sorted the way the plan sorted the declaration',
  )
  assert.equal(values.currency, 'IQD')
})

test('a page that exposes nothing is told nothing, so the channel costs it no frame', async () => {
  const serving = await app()
  const id = await channel(serving, '/app/feed')
  const out = await serving.app.hub.receive(id, [frame('REFRESH', { s: 'body' })])
  assert.equal(
    out.some((f) => f.kind === 'SIGNAL'),
    false,
  )
})

test('an intent that changes an exposed value tells every page composing a region that reads it', async () => {
  // The whole point of the channel being live. A region has no other way to hear about a shell value
  // moving — and this is one frame naming one value, not a re-render of anything.
  const serving = await app()
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: '/app/composed', cookie: '' })
  const held = sink()
  serving.app.hub.open(held, id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] }),
  ])
  const declared = held.frames.find((f) => f.kind === 'SIGNAL') as Frame
  const before = JSON.parse(utf8.decode(declared.body as Uint8Array)) as Record<string, string>
  held.frames.length = 0

  await fetch(new URL('/_weft/i/cart.add', serving.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-weft-fetch': '1' },
    body: JSON.stringify({ sku: 'OIL-2L', qty: 2 }),
  })

  const changed = held.frames.filter((f) => f.kind === 'SIGNAL')
  assert.equal(changed.length, 1, 'one frame, for the one value that moved — not the whole set again')
  assert.equal(str(changed[0] as Frame, 'name'), 'cartCount')
  // Against what the route says now rather than against arithmetic on `before`: the demo's cart is
  // process-wide, so an earlier test in this file may have added to it, and what is being asserted is
  // that the frame agrees with the page rather than that this test knows the total.
  const now = await (serving.app.routes.find((r) => r.pattern === '/app/composed') as GeneratedRoute).exposed(
    {},
  )
  assert.equal(
    str(changed[0] as Frame, 'v'),
    now.cartCount,
    'the new value, derived from the same shellValues the document renders with',
  )
  assert.notEqual(now.cartCount, before.cartCount, 'and it actually moved')
})

test('the exposed value the region rendered with is the one the page rendered with', async () => {
  // Not a second source. `currency` is a layoutValues name, so the region and the document cannot
  // disagree about it — which is the only reason handing it across a boundary is safe.
  const serving = await app()
  const html = await page(serving, '/app/composed')
  assert.match(html, /data-currency="IQD"/, 'the region was handed the shell value it declared')
  assert.match(html, /in IQD/, 'and rendered with it, on the far side of a real boundary')
})

test('a composed page is not a file, and the refusal names the reason rather than measuring twice', async () => {
  const serving = await app()
  const route = serving.app.routes.find((r) => r.pattern === '/app/composed')
  assert.ok(route)
  assert.equal(route.static.static, false)
  assert.equal(
    route.static.static === false ? route.static.code : null,
    'L0_REGION',
    'two renders could agree by accident; what the region reads is its own and can be rolled',
  )
})

// ── invalidation, crossing the boundary ──────────────────────────────────────────────

/**
 * The silence the composition spec described, and what closes it.
 *
 * A composite holds a contract and a region holds its own keys, so a `STALE` about them has nobody
 * to send — that reason is about keys and it is still true, because nothing is dropped from any
 * store here. What was missing is the other half: which of this composite's connections are showing
 * that region, which only this side can answer.
 *
 * Every assertion here is about authority, because that is the whole of what was missing. A caller
 * names a region and never a slot; a region with no configured secret cannot say anything at all;
 * and a connection showing the region is told while a connection showing another page is not.
 */
async function open_(serving: Serving, at: string): Promise<{ id: string; frames: Frame[] }> {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  const held = sink()
  serving.app.at.set(id, { path: at, cookie: '' })
  serving.app.hub.open(held, id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta', 'patch'] }),
  ])
  return { id, frames: held.frames }
}

const SECRET = 'a-shared-secret-nobody-guesses'

async function tellStale(
  serving: Serving,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(new URL('/_weft/stale', serving.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

test('a region that has gone stale reaches the connections showing it, and nobody else', async () => {
  const serving = await app({
    executors: { 'binding:search': tier() },
    regions: [binding({ staleSecret: SECRET })],
  })

  const showing = await open_(serving, '/app/composed?q=tea')
  const elsewhere = await open_(serving, '/app/feed')
  /**
   * The client says what it is showing, and that claim is the only thing that decides whose
   * business an invalidation is.
   *
   * Not a refresh: a *region* refresh records nothing on this side, and correctly so — what came
   * back was frames the region chose, and the template and the base in them are the region's. So
   * the composite learns that a connection is showing a region the same way it learns anything
   * about a client's state, which is by being told.
   */
  await serving.app.hub.receive(showing.id, [frame('HELD', { search: 'tpl-base' })])

  const before = showing.frames.length
  const told = await tellStale(serving, { region: 'search', reason: 'tag:index' })
  assert.equal(told.status, 200)
  assert.deepEqual(told.json.slots, ['search'])
  assert.equal(told.json.told, 1, 'one connection is showing it')

  const pushed = showing.frames.slice(before).filter((f) => f.kind === 'STALE')
  assert.equal(pushed.length, 1)
  assert.equal(str(pushed[0] as Frame, 's'), 'search')
  assert.equal(str(pushed[0] as Frame, 'reason'), 'tag:index')
  assert.deepEqual(
    elsewhere.frames.filter((f) => f.kind === 'STALE'),
    [],
    'a connection on another page is not showing that region and is not told',
  )
})

test('a region with no configured secret cannot tell this deployment anything', async () => {
  const serving = await app({
    executors: { 'binding:search': tier() },
    regions: [binding()],
  })
  const refused = await tellStale(serving, { region: 'search' })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.code, 'E_NO_STALE_SECRET')
})

test('the wrong secret, an unknown region and a named slot are each refused by name', async () => {
  const serving = await app({
    executors: { 'binding:search': tier() },
    regions: [binding({ staleSecret: SECRET })],
  })

  const wrong = await tellStale(serving, { region: 'search' }, { authorization: 'Bearer nope' })
  assert.equal(wrong.status, 403)
  assert.equal(wrong.json.code, 'E_STALE_UNAUTHORISED')

  const unknown = await tellStale(serving, { region: 'checkout' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.code, 'E_NO_SUCH_REGION')

  // A slot is a hole in a page the region cannot see. Naming one is the escape the REGION frame
  // check refuses everywhere else, so it is refused here too — by having no other name to give.
  const slot = await tellStale(serving, { reason: 'tag:index' })
  assert.equal(slot.status, 400)
  assert.equal(slot.json.code, 'E_STALE_REGION')
})
