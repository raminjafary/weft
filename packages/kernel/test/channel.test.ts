import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertValidTemplate,
  draftTemplate,
  type Hole,
  seal,
  TEMPLATE_IR_VERSION,
  type TemplateIR,
} from '@weftjs/ir'
import { WARP_VERSION, frame, negotiate, residentFrame, str, type Frame } from '@weftjs/warp'
import { createHub, serverCapabilities, type ChannelSink } from '../src/channel.ts'
import { storeJournal } from '../src/journal.ts'
import { baseKey, DEFAULT_REFRESH_TTL, heldFrame, parseHeld, recordBase, selectForm } from '../src/refresh.ts'

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
import { memoryBus, memoryFanout, memoryStore } from '@weftjs/adapters'

/**
 * The channel without a socket. The bindings are tested over real ones in
 * `@weftjs/adapters`; what is here is the part that has to be true before any of them can be:
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
  // The bug this gate exists for: `SERVER_DEFAULTS.ir` in @weftjs/warp said 1.0.0 while the
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

test('a HELD frame adds to what the server believes this client is showing', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  const channel = hub.open(sink(), 'c1')
  await hub.receive('c1', [heldFrame([{ slot: 'prices', tpl: 't1', base: 'b1' }])])
  await hub.receive('c1', [heldFrame([{ slot: 'cart', tpl: 't2', base: 'b2' }])])
  assert.deepEqual([...channel.held.keys()], ['prices', 'cart'])
})

test('a client that has navigated says what it holds, and the page it left goes with it', async () => {
  // Slot names belong to a page. Without `only`, `sidebar` outlives the page it was on: a
  // REFRESH naming no slots would refresh it, and an invalidation would tell this connection a
  // region nobody is looking at went stale.
  const hub = createHub({ store: memoryStore(), source: () => null })
  const channel = hub.open(sink(), 'c1')
  await hub.receive('c1', [
    heldFrame([
      { slot: 'body', tpl: 'page-a', base: 'b1' },
      { slot: 'sidebar', tpl: 'aside', base: 's1' },
    ]),
  ])
  hub.stale.hold('c1', 'sidebar', 'weft:/a:sidebar')
  assert.equal(hub.stale.connections, 1)

  await hub.receive('c1', [heldFrame([{ slot: 'body', tpl: 'page-b', base: 'b9' }], { only: true })])
  assert.deepEqual([...channel.held.keys()], ['body'])
  assert.equal(channel.held.get('body')?.tpl, 'page-b')
  assert.equal(hub.stale.connections, 0, "the keys it held were the other page's")
})

test('the reserved key on a HELD frame is not a slot called $only', async () => {
  const hub = createHub({ store: memoryStore(), source: () => null })
  const channel = hub.open(sink(), 'c1')
  await hub.receive('c1', [heldFrame([{ slot: 'body', tpl: 't', base: 'b' }], { only: true })])
  assert.deepEqual([...channel.held.keys()], ['body'])
  assert.deepEqual(parseHeld(heldFrame([], { only: true })), [])
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

/**
 * Two instances, one store, one bus — the arrangement every deployment above one process is, and
 * the one the hub could not describe before there was a port for it.
 *
 * The property under test is not that a message moves. It is that a reader who is looking at a
 * region on instance B is told when the write that invalidated it was handled by instance A, which
 * is the half that was silently missing: `hub.notify` walks the connections *this* process holds,
 * so before this the answer was correct for the readers on the writing instance and absent for
 * everyone else, at a rate nothing in the system could report.
 */
test('an invalidation handled by one instance reaches a reader held by another', async () => {
  const ir = await priceList()
  const store = memoryStore()
  const bus = memoryBus()
  const source = ({ slot }: { slot: string }) =>
    slot === 'prices' ? { ir, values: { first: '10.00', second: '20.00' }, key: 'prices:v1' } : null

  // The composition a deployment does, written out: the hub is told where an invalidation goes
  // that it cannot reach, and whoever binds the port turns a delivered message into a `notify`.
  const toward = memoryFanout({ bus, origin: 'a' })
  const back = memoryFanout({ bus, origin: 'b' })
  const writer = createHub({ store, source, onInvalidated: (keys, why) => toward.publish(keys, why) })
  const reader = createHub({ store, source, onInvalidated: (keys, why) => back.publish(keys, why) })
  await back.subscribe((keys, why) => {
    void reader.notify(keys, why)
  })

  const held = sink()
  reader.open(held, 'r1')
  await reader.receive('r1', [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html'] }),
    frame('REFRESH', { s: 'prices' }),
  ])
  const before = held.frames.length

  await store.set('prices:v1', new TextEncoder().encode('x'), { class: 'shared', tags: ['prices'] })
  const result = await writer.invalidate(['prices'], 'price change')
  assert.deepEqual(result.keys, ['prices:v1'])
  // Nobody on the writing instance is looking at it, which is exactly the case that used to be
  // indistinguishable from nobody looking at it anywhere.
  assert.equal(result.notified, 0)

  for (let i = 0; i < 50 && held.frames.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const stale = held.frames.at(-1) as Frame
  assert.equal(stale.kind, 'STALE', `expected STALE, got ${held.frames.map((f) => f.kind).join(', ')}`)
  assert.equal(str(stale, 's'), 'prices')
  assert.equal(str(stale, 'reason'), 'price change')
})

test('a hub does not hear its own publish, or it would tell its readers twice per write', async () => {
  const ir = await priceList()
  const store = memoryStore()
  const bus = memoryBus()
  const source = ({ slot }: { slot: string }) =>
    slot === 'prices' ? { ir, values: { first: '10.00', second: '20.00' }, key: 'prices:v1' } : null

  const only = memoryFanout({ bus, origin: 'only' })
  const hub = createHub({ store, source, onInvalidated: (keys, why) => only.publish(keys, why) })
  await only.subscribe((keys, why) => {
    void hub.notify(keys, why)
  })
  const held = sink()
  hub.open(held, 'r1')
  await hub.receive('r1', [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html'] }),
    frame('REFRESH', { s: 'prices' }),
  ])

  await store.set('prices:v1', new TextEncoder().encode('x'), { class: 'shared', tags: ['prices'] })
  const result = await hub.invalidate(['prices'], 'price change')
  assert.equal(result.notified, 1, 'the local reader is told once, by the local notify')

  await new Promise((resolve) => setTimeout(resolve, 20))
  const stales = held.frames.filter((f) => f.kind === 'STALE')
  assert.equal(stales.length, 1, 'and not a second time by hearing its own message come back')
})

/**
 * What a client with no connection is told when it comes back.
 *
 * The turn binding holds nothing between requests, so an invalidation that happens in the gap has
 * nowhere to be pushed. The journal is where it waits — and the property that matters is that it is
 * a *record* and not a queue: reading it does not consume it, so two clients on the same page are
 * both told, and one client asking twice is told twice. Deciding what to do about that second one
 * is the client's, which is what `at` on the frame is for.
 */
test('an invalidation with nobody connected is written down, and read by whoever asks next', async () => {
  const store = memoryStore()
  const journal = storeJournal(store)

  assert.equal((await journal.lookup(['render:/prices'])).size, 0, 'nothing has happened yet')

  await journal.record(['render:/prices'], 'a price changed')
  const found = await journal.lookup(['render:/prices', 'render:/other'])
  assert.equal(found.size, 1, 'only the key that was dropped')
  assert.equal(found.get('render:/prices')?.reason, 'a price changed')
  assert.equal(typeof found.get('render:/prices')?.at, 'number')

  // Read again: still there. A queue would have handed it to the first reader and left the second
  // with nothing, which is the wrong shape for a record two tabs may both need.
  assert.equal((await journal.lookup(['render:/prices'])).size, 1)
})

test('a journal entry expires, so a client away for a week is not told about last Tuesday', async () => {
  const store = memoryStore()
  const journal = storeJournal(store, { windowMs: 1 })
  await journal.record(['render:/prices'], 'a price changed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    (await journal.lookup(['render:/prices'])).size,
    0,
    'past the window it is not stale news, it is no news: the client asks and is told what is there now',
  )
})

/**
 * The connection that ran the intent, and the note it was not sent.
 *
 * A write invalidates keys; every connection holding one is told with a `STALE`, and the one that
 * ran the intent is deliberately left out — a note about an old value is the wrong thing to send
 * somebody you are about to send the new one to. That reasoning has a hole in it, and the hole was
 * the common case: the new values only came back for slots the intent listed in `refresh`. An
 * intent that declared `writes` and called `revalidate` — which is the whole of what the design
 * asks an author for — refreshed every other tab and left the tab whose reader pressed the button
 * showing the number they had just changed.
 *
 * So the exclusion is kept and the promise behind it is made true: the connection is refreshed for
 * what it is *holding* that the write dropped, which is the same question `staleFor` asks about
 * everybody else.
 */
test('the connection that ran an intent is refreshed for what it holds, not left out of both', async () => {
  const ir = await priceList()
  const store = memoryStore()
  const source = ({ slot }: { slot: string }) =>
    slot === 'prices' ? { ir, values: { first: '10.00', second: '20.00' }, key: 'prices:v1' } : null

  const hub = createHub({
    store,
    source,
    keyFor: (slot) => (slot === 'prices' ? 'prices:v1' : undefined),
    intentContext: () => ({}) as never,
    intents: {
      // Declares its writes and nothing else, which is the shape the design asks for and the shape
      // that used to come back with nothing at all.
      run: () =>
        Promise.resolve({
          ok: true as const,
          id: 'i1',
          name: 'prices.set',
          dropped: ['prices:v1'],
          invalidated: ['prices'],
          refresh: [],
        }),
    },
  })

  const held = sink()
  hub.open(held, 'writer')
  await hub.receive('writer', [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html'] }),
    // What a page says it is showing. This is what makes it a candidate for an invalidation, and
    // it is the same declaration that now makes it a candidate for the answer.
    heldFrame([{ slot: 'prices', tpl: ir.version, base: 'r_0' }]),
  ])

  const out = await hub.receive('writer', [frame('INTENT', { i: 'i1' })])
  const ack = out.find((f) => f.kind === 'ACK') as Frame
  assert.equal(str(ack, 'ok'), 'true', 'the intent ran')
  const painted = out.filter((f) => f.kind === 'HTML' || f.kind === 'DELTA' || f.kind === 'PATCH')
  assert.equal(
    painted.length,
    1,
    `the tab that ran the intent got no new values: ${out.map((f) => f.kind).join(', ')}`,
  )
  assert.equal(str(painted[0] as Frame, 's'), 'prices', 'and it is the slot the write dropped')
  assert.equal(
    out.some((f) => f.kind === 'STALE'),
    false,
    'and not a note about the value it is being handed',
  )
})

/**
 * And only what it holds, because the registry is the whole of what decides.
 *
 * A write that drops a key nobody on this connection is showing is not a reason to render anything
 * for it. Without this the rule would read "an intent refreshes something", which is a different
 * and much worse rule than "an intent hands back what this reader was looking at".
 */
test('a write that drops nothing this connection holds refreshes nothing for it', async () => {
  const ir = await priceList()
  const store = memoryStore()
  const source = ({ slot }: { slot: string }) =>
    slot === 'prices' ? { ir, values: { first: '1', second: '2' }, key: 'prices:v1' } : null

  const hub = createHub({
    store,
    source,
    keyFor: (slot) => (slot === 'prices' ? 'prices:v1' : undefined),
    intentContext: () => ({}) as never,
    intents: {
      run: () =>
        Promise.resolve({
          ok: true as const,
          id: 'i2',
          name: 'elsewhere.set',
          dropped: ['somewhere-else:v1'],
          invalidated: ['elsewhere'],
          refresh: [],
        }),
    },
  })

  const held = sink()
  hub.open(held, 'writer')
  await hub.receive('writer', [
    residentFrame({ warp: WARP_VERSION, ir: TEMPLATE_IR_VERSION, forms: ['html'] }),
    heldFrame([{ slot: 'prices', tpl: ir.version, base: 'r_0' }]),
  ])
  const out = await hub.receive('writer', [frame('INTENT', { i: 'i2' })])
  assert.equal(
    out.filter((f) => f.kind === 'HTML' || f.kind === 'DELTA' || f.kind === 'PATCH').length,
    0,
    'a key nobody here is showing is not a reason to render',
  )
})
