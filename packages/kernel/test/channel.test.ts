import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TEMPLATE_IR_VERSION } from '../../ir/src/index.ts'
import { WARP_VERSION, frame, negotiate, residentFrame, str, type Frame } from '../../warp/src/index.ts'
import { createHub, serverCapabilities, type ChannelSink } from '../src/channel.ts'
import { memoryStore } from '../../adapters/src/memory-store.ts'

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
