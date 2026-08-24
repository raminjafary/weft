import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TEMPLATE_IR_VERSION } from '@weft/ir'
import { frame, readResident, residentFrame, str, WARP_VERSION, type Frame } from '@weft/warp'
import type { ChannelSink } from '@weft/kernel'
import { createApp, serveApp, type Serving } from '../src/serve.ts'

const ROOT = fileURLToPath(new URL('../../../demo/', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

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

/**
 * `WARM at=`, which is what the design's frame table always said the frame was for: "stage data for
 * a route, do not paint".
 *
 * Driven through the hub rather than through a browser, because what is being asserted is the
 * protocol: which frames come back, in which form, and what the server refuses. The browser half —
 * that a commit paints them — is measured in `spec/client/navigation.md`.
 */
async function app(): Promise<Serving> {
  const serving = await serveApp(await createApp(ROOT, { mode: 'dev', port: 0 }))
  servers.push(serving)
  return serving
}

async function channel(serving: Serving, at: string): Promise<{ id: string; out: Frame[] }> {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`
  serving.app.at.set(id, { path: at, cookie: '' })
  const held = sink()
  serving.app.hub.open(held, id)
  await serving.app.hub.receive(id, [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta', 'patch'] }),
  ])
  return { id, out: held.frames }
}

test('a route on the same shell is staged as regions, and every frame carries the epoch', async () => {
  const serving = await app()
  const { id } = await channel(serving, '/app/feed')
  const out = await serving.app.hub.receive(id, [frame('WARM', { at: '/app/cart', epoch: 'n-1' })])

  const nav = out.find((f) => f.kind === 'NAV') as Frame
  assert.ok(nav, 'the answer to a staged route is a NAV')
  assert.equal(str(nav, 'form'), 'slots')
  assert.equal(str(nav, 'route'), '/app/cart')
  assert.equal(str(nav, 'epoch'), 'n-1')
  assert.match(
    str(nav, 'title') ?? '',
    /cart/i,
    'the title it will show, so a commit needs no second request',
  )
  assert.ok(str(nav, 'css'), 'and the stylesheet, so the cascade is in place before it paints')

  const named = (str(nav, 's') ?? '').split(',')
  const regions = out.filter((f) => f.kind === 'HTML' || f.kind === 'DELTA')
  assert.deepEqual(
    regions.map((f) => str(f, 's')),
    named,
    'one frame per region the NAV named',
  )
  for (const region of regions) {
    assert.equal(str(region, 'epoch'), 'n-1', 'staged, so it paints nothing on arrival')
  }
})

test('the same route with different values comes back as changed values, not markup', async () => {
  const serving = await app()
  const { id } = await channel(serving, '/app/feed?rows=40')

  // What the client is showing: the feed's body, at the render the server just recorded for it.
  const first = await serving.app.hub.receive(id, [frame('REFRESH', { s: 'body' })])
  const shown = first.find((f) => f.kind === 'HTML' || f.kind === 'DELTA') as Frame
  assert.ok(shown, 'the page it is on')
  await serving.app.hub.receive(id, [
    frame('HELD', { body: `${str(shown, 'tpl')}-${str(shown, 'next') ?? str(shown, 'base')}` }),
  ])

  const out = await serving.app.hub.receive(id, [frame('WARM', { at: '/app/feed?rows=80', epoch: 'n-2' })])
  const body = out.find((f) => str(f, 's') === 'body') as Frame
  assert.equal(
    body.kind,
    'DELTA',
    'two pages on one route share a template, so what travels is the values that differ — for a page the reader has not been to',
  )
  assert.equal(str(body, 'epoch'), 'n-2')
})

test('a route on a different shell is refused, and the client is told to fetch the document', async () => {
  const serving = await app()
  // The demo's dashboard has a layout of its own, which is the case this exists to refuse: a
  // different document has different holes, so its regions cannot be swapped into these.
  const { id } = await channel(serving, '/app/feed')
  const out = await serving.app.hub.receive(id, [frame('WARM', { at: '/app/dashboard', epoch: 'n-3' })])

  const nav = out.find((f) => f.kind === 'NAV') as Frame
  assert.equal(str(nav, 'form'), 'document')
  assert.match(str(nav, 'why') ?? '', /different document/)
  assert.equal(
    out.filter((f) => f.kind === 'HTML' || f.kind === 'DELTA').length,
    0,
    'and no regions, because none of them could be applied',
  )
})

test('a route that does not exist is refused by name', async () => {
  const serving = await app()
  const { id } = await channel(serving, '/app/feed')
  const out = await serving.app.hub.receive(id, [frame('WARM', { at: '/nope', epoch: 'n-4' })])
  assert.equal(out[0]?.kind, 'ERROR')
  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_SUCH_ROUTE')
})

test('staging a route does not change what the server believes this client is showing', async () => {
  const serving = await app()
  const { id } = await channel(serving, '/app/feed')
  const before = [...(serving.app.hub.get(id)?.held.keys() ?? [])]
  await serving.app.hub.receive(id, [frame('WARM', { at: '/app/cart', epoch: 'n-5' })])
  assert.deepEqual(
    [...(serving.app.hub.get(id)?.held.keys() ?? [])],
    before,
    'the target’s bases in the held map would make the next refresh of the current page a delta against a render nobody has seen',
  )
})

test('a client that has not negotiated cannot be staged for, because no form could be chosen', async () => {
  const serving = await app()
  const id = 'c-cold'
  serving.app.at.set(id, { path: '/app/feed', cookie: '' })
  serving.app.hub.open(sink(), id)
  const out = await serving.app.hub.receive(id, [frame('WARM', { at: '/app/cart', epoch: 'n-6' })])
  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_NEGOTIATION')
})

test('the hello a client sends is the version this build speaks', () => {
  const hello = readResident(residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION }))
  assert.equal(
    hello.warp,
    '1.6.0',
    'WARM carrying a route arrived in 1.4.0; a plan prefix is 1.5.0; a region announcing itself is 1.6.0',
  )
})
