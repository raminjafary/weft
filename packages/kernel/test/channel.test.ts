import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertValidTemplate,
  draftTemplate,
  type Hole,
  seal,
  TEMPLATE_IR_VERSION,
  type TemplateIR,
} from '@weft/ir'
import { WARP_VERSION, frame, negotiate, residentFrame, str, type Frame } from '@weft/warp'
import { createHub, serverCapabilities, type ChannelSink } from '../src/channel.ts'
import { baseKey, DEFAULT_REFRESH_TTL, recordBase, selectForm } from '../src/refresh.ts'

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

async function priceList(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'fragment/prices',
        segments: ['<ul><li>', '</li><li>', '</li></ul>'],
        holes: [hole(0, 'first'), hole(1, 'second', { path: [1] })],
      }),
    ),
  )
}
import { memoryStore } from '@weft/adapters'

/**
 * The channel without a socket. The bindings are tested over real ones in
 * `@weft/adapters`; what is here is the part that has to be true before any of them can be:
 * what this build says it can serve, and what it refuses.
 */
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

test('the advertised IR version is the one this build emits, not a number written beside it', () => {
  // The bug this gate exists for: `SERVER_DEFAULTS.ir` in @weft/warp said 1.0.0 while the
  // emitter was on 2.4.0, so every current client negotiated an IR major mismatch and was
  // served markup only. Warp cannot see the IR's version, so the composition lives here.
  const capabilities = serverCapabilities()
  assert.equal(capabilities.ir, TEMPLATE_IR_VERSION)
  assert.equal(capabilities.warp, WARP_VERSION)
  assert.ok(capabilities.forms.includes('delta'), 'a server that cannot offer delta has no phase 6')
})

test('a client on this build own versions is offered the delta form', () => {
  const settled = negotiate(
    { warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html', 'delta'] },
    serverCapabilities(),
  )
  assert.equal(settled.ok, true)
  assert.ok(settled.forms.includes('delta'))
  assert.equal(settled.ir, TEMPLATE_IR_VERSION)
  assert.equal(
    settled.downgrades.some((d) => d.includes('ir major mismatch')),
    false,
    'a client on the current IR is not a mismatch',
  )
})

test('a REFRESH before RESIDENT is refused, because a form cannot be chosen without one', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  const s = sink()
  hub.open(s, 'c1')
  const out = await hub.receive('c1', [frame('REFRESH', { s: 'prices' })])
  assert.equal(out[0]?.kind, 'ERROR')
  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_NEGOTIATION')
})

test('a slot the source does not know is named rather than skipped', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  const s = sink()
  hub.open(s, 'c1')
  await hub.receive('c1', [residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION })])
  const out = await hub.receive('c1', [frame('REFRESH', { s: 'nope' })])
  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_SUCH_SLOT')
  assert.equal(str(out[0] as Frame, 'detail'), 'nope')
})

test('a WARM with no template registry says so rather than answering emptily', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  hub.open(sink(), 'c1')
  const out = await hub.receive('c1', [frame('WARM', { tpl: 'anything' })])
  assert.equal(str(out[0] as Frame, 'code'), 'E_NO_TEMPLATE_REGISTRY')
})

test('receiving on a channel that was never opened is not a channel with nothing in it', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  await assert.rejects(() => hub.receive('ghost', []), /E_NO_SUCH_CHANNEL/)
})

test('closing a channel releases its stale holds, so an invalidation cannot address a corpse', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  hub.open(sink(), 'c1')
  hub.stale.hold('c1', 'prices', 'k')
  assert.equal(hub.stale.connections, 1)
  hub.close('c1')
  assert.equal(hub.stale.connections, 0)
  assert.equal(hub.channels, 0)
})

test('base renders and memoized deltas expire, so a shared store does not grow forever', async () => {
  // Both were written with no ttl. `memoryStore` is byte-bounded and evicts, so it looked
  // harmless; a Redis or KV adapter would have accumulated every value set ever rendered.
  const store = memoryStore()
  const ir = await priceList()
  const id = await recordBase(store, ir, { first: '1', second: '2' } as never)
  const entry = await store.get(baseKey(ir.version, id))
  assert.equal(entry?.meta.ttlMs, DEFAULT_REFRESH_TTL.baseMs)

  // An expired base is not a correctness problem: it costs a form. The client names a base the
  // server cannot recover and `selectForm` falls to html.
  const short = await recordBase(store, ir, { first: '9', second: '2' } as never, { baseMs: 1 })
  assert.equal((await store.get(baseKey(ir.version, short)))?.meta.ttlMs, 1)
  assert.equal(
    selectForm({
      available: ir.forms,
      accepted: ['html', 'delta'],
      resident: true,
      baseRecovered: false,
    }).form,
    'html',
  )
})

test('a peer that stops reading is closed rather than buffered for', async () => {
  // A channel is not a queue. Frames held for a peer that is not reading are memory the process
  // cannot reclaim, and every one of them is stale by the time it would arrive.
  const hub = createHub({ store: memoryStore(), source: () => null, maxSaturatedSends: 3 })
  let closed: string | undefined
  const stuck: ChannelSink = {
    binding: 'stream',
    open: true,
    saturated: true,
    send() {},
    close(reason) {
      closed = reason
    },
  }
  const channel = hub.open(stuck, 'slow')
  for (let i = 0; i < 3; i++) await channel.send([frame('STALE', { s: 'x' })])
  assert.match(closed ?? '', /E_SLOW_CONSUMER/)
  assert.equal(hub.channels, 0, 'and the channel is gone rather than accumulating frames')
})

test('a peer that keeps up is never closed for it', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null, maxSaturatedSends: 2 })
  let saturated = false
  let closed = false
  const keepingUp: ChannelSink = {
    binding: 'stream',
    open: true,
    get saturated() {
      return saturated
    },
    send() {},
    close() {
      closed = true
    },
  }
  const channel = hub.open(keepingUp, 'ok')
  // One saturated send followed by a drain is a burst, not a slow consumer.
  saturated = true
  await channel.send([frame('STALE', { s: 'x' })])
  saturated = false
  for (let i = 0; i < 10; i++) await channel.send([frame('STALE', { s: 'x' })])
  assert.equal(closed, false)
  assert.equal(hub.channels, 1)
})
