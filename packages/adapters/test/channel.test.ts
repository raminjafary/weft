import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertValidTemplate, draftTemplate, seal, type Hole, type TemplateIR, type Values } from '@weft/ir'
import {
  type Channel,
  type ChannelHub,
  createEnvelope,
  createHub,
  createIntentDispatch,
  createReads,
  defineIntent,
  envelopeContext,
  lifecycle,
  requestFacts,
  type SlotRender,
} from '@weft/kernel'
import { cookieSession } from '../src/session.ts'
import { staticFlags } from '../src/flags.ts'
import {
  createTextDecoder,
  createBinaryDecoder,
  frame,
  residentFrame,
  str,
  WARP_VERSION,
  type AnyFrame,
  type Frame,
} from '@weft/warp'
import {
  type Adopted,
  type ChannelFrame,
  createChannelClient,
  createEpochs as createClientEpochs,
  type Region,
} from '@weft/client'
import { memoryStore } from '../src/memory-store.ts'
import { mountChannel, upFrames } from '../src/node-channel.ts'
import { collectingTelemetry } from '../src/telemetry.ts'

/**
 * The channel over a real socket, in all three bindings the design names.
 *
 * Every phase 5 and 6 flow existed before this file and none of them had ever left a test
 * process: `surgicalRefresh` was called directly, `STALE` was asserted as a returned map,
 * and `COMMIT` was a frame in an array. What is exercised here is the same flow with a
 * kernel on one end, a socket in the middle, and something on the other end that has to
 * parse what actually arrived.
 */
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

interface Harness {
  hub: ChannelHub
  url(id: string, binding?: 'stream' | 'sse' | 'socket'): string
  close(): Promise<void>
  /** What every channel will be served on its next refresh. One list, many watchers. */
  set(values: Values): void
  telemetry: ReturnType<typeof collectingTelemetry>
  ir: TemplateIR
  store: ReturnType<typeof memoryStore>
}

async function harness(options: { intents?: boolean } = {}): Promise<Harness> {
  const ir = await priceList()
  const store = memoryStore()
  const telemetry = collectingTelemetry()
  let current: Values = { first: '10.00', second: '20.00' }

  const markUp = defineIntent<{ to: string }>({
    name: 'prices.set',
    writes: ['prices'],
    input: (raw) => {
      const to = (raw as { to?: unknown }).to
      if (typeof to !== 'string') throw new Error('to is required')
      return { to }
    },
    async run(ctx, input) {
      if (input.to === 'boom') throw new Error('the pricing service is down')
      current = { first: current.first as string, second: input.to }
      await ctx.revalidate('prices')
      return { refresh: ['prices'] }
    },
  })

  const dispatch = createIntentDispatch({
    store,
    registry: {
      name: 'test',
      intent: (id) => (id === 'p1' ? (markUp as never) : undefined),
      intents: () => ['p1'],
    },
  })

  const hub = createHub({
    store,
    telemetry,
    templates: (version) => (version === ir.version ? ir : undefined),
    source: ({ slot }): SlotRender | null =>
      slot === 'prices' ? { ir, values: current, key: 'prices:v1' } : null,
    ...(options.intents
      ? {
          intents: dispatch,
          intentContext: () => {
            const life = lifecycle()
            const envelope = createEnvelope(life)
            life.to('envelope')
            const facts = requestFacts(new Request('https://example.test/'))
            return envelopeContext(
              createReads(facts, {
                store,
                session: cookieSession(),
                flags: staticFlags({ axes: {} }),
                executors: {},
              }),
              envelope,
            )
          },
        }
      : {}),
  })

  const mounted = await mountChannel({ hub })
  return {
    hub,
    ir,
    store,
    telemetry,
    set(values) {
      current = values
    },
    url: (id, binding) => mounted.channelUrl(id, binding),
    close: mounted.close,
  }
}

interface Down {
  frames: AnyFrame[]
  done: Promise<void>
  /**
   * A decode failure, kept rather than swallowed. Swallowing it is how a reader that died on
   * the second frame looked exactly like a server that never sent one — which is what hid a
   * wrong-direction frame for the length of an afternoon.
   */
  failure: Error | null
}

/** Reads the binary down stream of the `stream` binding and hands back frames as they land. */
function readBinary(url: string, signal: AbortSignal): Down {
  const out: Down = { frames: [], done: Promise.resolve(), failure: null }
  out.done = (async () => {
    const response = await fetch(url, { signal })
    const decoder = createBinaryDecoder({ expect: 'down' })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      if (value) out.frames.push(...decoder.push(value))
    }
  })().catch((error: unknown) => {
    if (signal.aborted) return
    out.failure = error instanceof Error ? error : new Error(String(error))
  })
  return out
}

function readSse(url: string, signal: AbortSignal): Down {
  const out: Down = { frames: [], done: Promise.resolve(), failure: null }
  const frames = out.frames
  out.done = (async () => {
    const response = await fetch(url, { signal })
    const decoder = createTextDecoder({ expect: 'down' })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const utf8 = new TextDecoder()
    let pending = ''
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      pending += utf8.decode(value ?? new Uint8Array(0), { stream: true })
      let nl: number
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (!line.startsWith('data: ')) continue
        frames.push(...decoder.push(new TextEncoder().encode(line.slice(6) + '\n')))
      }
    }
  })().catch((error: unknown) => {
    if (signal.aborted) return
    out.failure = error instanceof Error ? error : new Error(String(error))
  })
  return out
}

async function post(url: string, frames: Frame[]): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/warp' },
    body: upFrames(frames),
  })
}

/** A POST that was refused is a failure to report, not a frame that never arrives. */
async function send(url: string, frames: Frame[]): Promise<void> {
  const response = await post(url, frames)
  assert.equal(response.status, 202, await response.text())
}

async function settle(check: () => boolean, label: string, ms = 2000, down?: Down): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (down?.failure) assert.fail(`the reader died waiting for ${label}: ${down.failure.message}`)
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}${down?.failure ? `: ${down.failure.message}` : ''}`)
}

const hello = () =>
  residentFrame({ warp: WARP_VERSION, ir: '2.0.0', forms: ['html', 'delta', 'patch'], transport: 'stream' })

test('the streamed binding: negotiate, render, then a delta over one open connection', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readBinary(h.url('c1'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel to open')

  await post(h.url('c1'), [hello()])
  await settle(() => down.frames.length >= 1, 'the WARP frame', 2000, down)
  const warp = down.frames[0] as Frame
  assert.equal(warp.kind, 'WARP')
  assert.equal(str(warp, 'strategy'), 'stream')

  // First refresh: the client holds nothing, so the floor form serves markup.
  await post(h.url('c1'), [frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 2, 'the first render', 2000, down)
  const first = down.frames[1] as Frame
  assert.equal(first.kind, 'HTML')
  assert.match(new TextDecoder().decode(first.body), /10\.00/)
  const base = str(first, 'base') as string

  // Second refresh, one value changed. The client is holding a base the server recorded, so
  // only the changed value travels.
  h.set({ first: '10.00', second: '21.50' })
  await post(h.url('c1'), [frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 3, 'the delta', 2000, down)
  const delta = down.frames[2] as Frame
  assert.equal(delta.kind, 'DELTA')
  assert.equal(str(delta, 'base'), base, 'the delta names the base the client actually holds')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(delta.body)), { second: '21.50' })

  controller.abort()
  await down.done
  await h.close()
})

test('the SSE binding carries the same frames, in text framing, and says what that costs', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readSse(h.url('c1', 'sse'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel to open')

  await post(h.url('c1'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 2, 'WARP and the first render', 2000, down)
  assert.equal((down.frames[0] as Frame).kind, 'WARP')
  const html = down.frames[1] as Frame
  assert.equal(html.kind, 'HTML')
  assert.match(new TextDecoder().decode(html.body), /20\.00/)

  h.set({ first: '11.00', second: '20.00' })
  await post(h.url('c1'), [frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 3, 'the delta', 2000, down)
  const delta = down.frames[2] as Frame
  assert.equal(delta.kind, 'DELTA')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(delta.body)), { first: '11.00' })

  controller.abort()
  await down.done
  await h.close()
})

test('the socket binding is bidirectional, so an upstream frame needs no second request', async () => {
  const h = await harness()
  const socket = new WebSocket(h.url('ws1', 'socket'))
  const frames: AnyFrame[] = []
  const decoder = createBinaryDecoder({ expect: 'down' })
  socket.binaryType = 'arraybuffer'
  socket.onmessage = (event) => {
    frames.push(...decoder.push(new Uint8Array(event.data as ArrayBuffer)))
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('E_WS_CONNECT'))
  })

  socket.send(upFrames([hello(), frame('REFRESH', { s: 'prices' })]))
  await settle(() => frames.length >= 2, 'WARP and the first render')
  assert.equal((frames[0] as Frame).kind, 'WARP')
  assert.equal((frames[1] as Frame).kind, 'HTML')

  h.set({ first: '12.00', second: '20.00' })
  // No second preamble: one WebSocket is one stream, and the version was announced on it once.
  socket.send(upFrames([frame('REFRESH', { s: 'prices' })]).subarray(8))
  await settle(() => frames.length >= 3, 'the delta')
  assert.equal((frames[2] as Frame).kind, 'DELTA')

  socket.close()
  await h.close()
})

test('one transition, ten connections, one computation', async () => {
  const h = await harness()
  const controller = new AbortController()
  const streams = Array.from({ length: 10 }, (_, i) => ({
    id: `w${i}`,
    down: readBinary(h.url(`w${i}`), controller.signal),
  }))
  await settle(() => h.hub.channels === 10, 'ten channels')

  for (const s of streams) await post(h.url(s.id), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => streams.every((s) => s.down.frames.length >= 2), 'ten first renders')

  // Every connection is holding the same base, because they were all served the same values.
  const bases = new Set(streams.map((s) => str(s.down.frames[1] as Frame, 'base')))
  assert.equal(bases.size, 1, 'the base render is content-addressed, so identical values share one id')

  h.set({ first: '10.00', second: '99.00' })
  for (const s of streams) await post(h.url(s.id), [frame('REFRESH', { s: 'prices' })])
  await settle(() => streams.every((s) => s.down.frames.length >= 3), 'ten deltas')

  const computed = h.telemetry.measures.filter(
    (m) => m.name === 'channel.refresh' && m.attrs?.memoized === 'false',
  )
  const memoized = h.telemetry.measures.filter(
    (m) => m.name === 'channel.refresh' && m.attrs?.memoized === 'true',
  )

  // Ten first renders are ten computations; the shared transition after them is one.
  assert.equal(memoized.length, 9, 'nine of the ten deltas came out of the store')
  assert.equal(computed.length, 11, 'ten first renders plus exactly one delta computation')
  for (const s of streams) {
    assert.equal((s.down.frames[2] as Frame).kind, 'DELTA')
  }

  controller.abort()
  await Promise.all(streams.map((s) => s.down.done))
  await h.close()
})

test('invalidating a tag pushes STALE to exactly the connections holding the dropped key', async () => {
  const h = await harness()
  const controller = new AbortController()
  const watching = readBinary(h.url('holder'), controller.signal)
  const idle = readBinary(h.url('idle'), controller.signal)
  await settle(() => h.hub.channels === 2, 'two channels')

  await post(h.url('holder'), [hello(), frame('REFRESH', { s: 'prices' })])
  await post(h.url('idle'), [hello()])
  await settle(() => watching.frames.length >= 2, 'the holder to be served', 2000, watching)

  await h.store.set('prices:v1', new TextEncoder().encode('x'), { class: 'shared', tags: ['prices'] })
  const result = await h.hub.invalidate(['prices'], 'price change')
  assert.deepEqual(result.keys, ['prices:v1'])
  assert.equal(result.notified, 1, 'only the connection holding the key hears about it')

  await settle(() => watching.frames.length >= 3, 'the STALE frame', 2000, watching)
  const stale = watching.frames[2] as Frame
  assert.equal(stale.kind, 'STALE')
  assert.equal(str(stale, 's'), 'prices')
  assert.equal(str(stale, 'reason'), 'price change')
  assert.equal(idle.frames.length, 1, 'the idle connection was told nothing')

  controller.abort()
  await Promise.all([watching.done, idle.done])
  await h.close()
})

test('a staged epoch paints nothing until a commit, and the commit is one frame batch', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readBinary(h.url('e1'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')

  await post(h.url('e1'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 2, 'the first render', 2000, down)
  const before = down.frames.length

  h.set({ first: '10.00', second: '77.00' })
  await post(h.url('e1'), [frame('REFRESH', { s: 'prices', epoch: 'e-1' })])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(down.frames.length, before, 'the data arrived and resolved and nothing was sent')
  assert.deepEqual(h.hub.get('e1')?.epochs.slots('e-1'), ['prices'])

  await post(h.url('e1'), [frame('REFRESH', { epoch: 'e-1', commit: 'true', s: '' })])
  await settle(() => down.frames.length >= before + 2, 'the staged frame and its commit', 2000, down)
  const staged = down.frames[before] as Frame
  const commit = down.frames[before + 1] as Frame
  assert.equal(str(staged, 'epoch'), 'e-1')
  assert.equal(commit.kind, 'COMMIT')
  assert.equal(str(commit, 'slots'), 'prices')

  controller.abort()
  await down.done
  await h.close()
})

test('an upstream frame with no live downstream is refused by name, not dropped', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readBinary(h.url('gone'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')
  controller.abort()
  await down.done
  await settle(() => h.hub.channels === 0, 'the channel to close')

  const response = await post(h.url('gone'), [hello()])
  assert.equal(response.status, 409)
  assert.match(await response.text(), /E_NO_SUCH_CHANNEL/)
  await h.close()
})

test('a frame travelling the wrong way is a protocol error before it reaches the hub', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readBinary(h.url('c1'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')

  const response = await post(h.url('c1'), [frame('COMMIT', { epoch: 'x' })])
  assert.equal(response.status, 400)
  assert.match(await response.text(), /E_WRONG_DIRECTION/)

  controller.abort()
  await down.done
  await h.close()
})

test('an intent is refused by name rather than silently ignored', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readBinary(h.url('c1'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')

  await post(h.url('c1'), [hello(), frame('INTENT', { i: 'a1' }), frame('INTENT', {})])
  await settle(() => down.frames.length >= 3, 'both refusals', 2000, down)
  assert.equal(str(down.frames[1] as Frame, 'code'), 'E_NO_INTENTS', 'this hub has no dispatch')
  assert.equal(
    str(down.frames[2] as Frame, 'code'),
    'E_INTENT_UNNAMED',
    'and a frame with no id is malformed',
  )

  controller.abort()
  await down.done
  await h.close()
})

test('WARM sends the client the template it asked for, and nothing it did not', async () => {
  const h = await harness()
  const controller = new AbortController()
  const down = readBinary(h.url('c1'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')

  await post(h.url('c1'), [hello(), frame('WARM', { tpl: `${h.ir.version},nope` })])
  await settle(() => down.frames.length >= 3, 'a TPL and a refusal', 2000, down)
  const tpl = down.frames[1] as Frame
  assert.equal(tpl.kind, 'TPL')
  const view = JSON.parse(new TextDecoder().decode(tpl.body)) as Record<string, unknown>
  assert.equal(view.version, h.ir.version)
  assert.ok(!('segments' in view), 'segments are markup the client already holds')
  assert.ok(!('effects' in view), 'effects are a server concern the client cannot act on')
  assert.equal(str(down.frames[2] as Frame, 'code'), 'E_NO_SUCH_TEMPLATE')

  controller.abort()
  await down.done
  await h.close()
})

test('reconnecting under the same id keeps what the client is known to hold', async () => {
  const h = await harness()
  const first = new AbortController()
  const a = readBinary(h.url('resume-1'), first.signal)
  await settle(() => h.hub.channels === 1, 'the channel')

  await post(h.url('resume-1'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => a.frames.length >= 2, 'the first render', 2000, a)
  const held = (h.hub.get('resume-1') as Channel).held.get('prices')
  assert.ok(held, 'the server knows what this client holds')

  // The webview is frozen and evicted. The hub keeps the channel, because a rebind under the
  // same id is what resumption is.
  const second = new AbortController()
  const b = readBinary(h.url('resume-1'), second.signal)
  await new Promise((resolve) => setTimeout(resolve, 50))

  await post(h.url('resume-1'), [frame('RESUME', { epoch: 'live' })])
  h.set({ first: '10.00', second: '31.00' })
  await post(h.url('resume-1'), [frame('REFRESH', { s: 'prices' })])
  await settle(() => b.frames.some((f) => f.kind === 'DELTA'), 'a delta rather than a first render', 2000, b)
  const delta = b.frames.find((f) => f.kind === 'DELTA') as Frame
  assert.equal(str(delta, 'base'), held.base, 'the resumed channel continued from the base it held')

  first.abort()
  second.abort()
  await Promise.all([a.done, b.done])
  await h.close()
})

/**
 * The loop closed: a hub on one end, a real socket in the middle, and the client's own frame
 * router on the other end writing into a region. Every part of this existed before and no
 * test had ever run them against each other.
 */
test('end to end: a refresh over a socket becomes one DOM write on a real client', async () => {
  const h = await harness()
  const written: [string, unknown][] = []
  const adopted = {
    template: { version: h.ir.version, holes: [], wiring: [] },
    instances: {},
    rows: [],
    target: () => undefined,
    targets: () => [],
    write: (binding: string, value: unknown) => void written.push([binding, value]),
  } as unknown as Adopted

  const region: Region = { slot: 'prices', adopted, base: '' }
  const client = createChannelClient({ epochs: createClientEpochs(), regions: () => [region] })

  const socket = new WebSocket(h.url('e2e', 'socket'))
  const decoder = createBinaryDecoder({ expect: 'down' })
  const applied: Awaited<ReturnType<typeof client.apply>>[] = []
  socket.binaryType = 'arraybuffer'
  socket.onmessage = (event) => {
    const frames = decoder.push(new Uint8Array(event.data as ArrayBuffer))
    if (frames.length) {
      void client
        .apply(frames.filter((f) => f.kind !== 'UNKNOWN') as ChannelFrame[])
        .then((r) => applied.push(r))
    }
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('E_WS_CONNECT'))
  })

  socket.send(upFrames([hello(), frame('REFRESH', { s: 'prices' })]))
  await settle(() => region.base !== '', 'the first render to name a base')
  assert.deepEqual(written, [], 'markup was served, so there was nothing to write into')

  h.set({ first: '10.00', second: '44.00' })
  socket.send(upFrames([frame('REFRESH', { s: 'prices' })]).subarray(8))
  await settle(() => written.length > 0, 'the delta to be applied')
  assert.deepEqual(written, [['second', '44.00']], 'one changed value, one write')
  assert.equal(
    applied.reduce((sum, a) => sum + a.refused.length, 0),
    0,
    'the base the client held and the base the server diffed from were the same',
  )

  socket.close()
  await h.close()
})

test('an intent over the channel acknowledges, invalidates, and refreshes what it changed', async () => {
  const h = await harness({ intents: true })
  const controller = new AbortController()
  const down = readBinary(h.url('i1'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')

  await send(h.url('i1'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 2, 'the first render', 2000, down)
  const at = down.frames.length

  await send(h.url('i1'), [
    { ...frame('INTENT', { i: 'p1' }), body: new TextEncoder().encode('{"to":"55.00"}'), bodyIsText: true },
  ])
  await settle(() => down.frames.length >= at + 2, 'an ACK and a delta', 2000, down)
  const ack = down.frames[at] as Frame
  assert.equal(ack.kind, 'ACK')
  assert.equal(str(ack, 'ok'), 'true')
  assert.equal(str(ack, 'tags'), 'prices')
  const delta = down.frames[at + 1] as Frame
  assert.equal(delta.kind, 'DELTA')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(delta.body)), { second: '55.00' })

  controller.abort()
  await down.done
  await h.close()
})

/**
 * The optimistic case, which is the reason to run an intent over a channel rather than a
 * POST. The client stages its own guess under an epoch; the server stages the real result
 * into the same epoch and commits, so the guess is replaced in one paint. A failure sends
 * `ok=false` and no commit, and discarding an epoch is the whole of the rollback.
 */
test('an intent under an epoch commits the real values in one paint', async () => {
  const h = await harness({ intents: true })
  const controller = new AbortController()
  const down = readBinary(h.url('i2'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')
  await send(h.url('i2'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 2, 'the first render', 2000, down)
  const at = down.frames.length

  await send(h.url('i2'), [
    {
      ...frame('INTENT', { i: 'p1', epoch: 'o-3' }),
      body: new TextEncoder().encode('{"to":"61.00"}'),
      bodyIsText: true,
    },
  ])
  await settle(() => down.frames.length >= at + 3, 'an ACK, the staged delta, and a COMMIT', 2000, down)
  assert.equal(str(down.frames[at] as Frame, 'epoch'), 'o-3', 'the ACK names the epoch it belongs to')
  const staged = down.frames[at + 1] as Frame
  assert.equal(staged.kind, 'DELTA')
  assert.equal(str(staged, 'epoch'), 'o-3', 'staged, so it paints nothing on arrival')
  const commit = down.frames[at + 2] as Frame
  assert.equal(commit.kind, 'COMMIT')
  assert.equal(str(commit, 'epoch'), 'o-3')
  assert.equal(str(commit, 'slots'), 'prices')

  controller.abort()
  await down.done
  await h.close()
})

test('a failed intent sends no commit, so the client discards its optimistic epoch', async () => {
  const h = await harness({ intents: true })
  const controller = new AbortController()
  const down = readBinary(h.url('i3'), controller.signal)
  await settle(() => h.hub.channels === 1, 'the channel')
  await send(h.url('i3'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => down.frames.length >= 2, 'the first render', 2000, down)
  const at = down.frames.length

  await send(h.url('i3'), [
    {
      ...frame('INTENT', { i: 'p1', epoch: 'o-4' }),
      body: new TextEncoder().encode('{"to":"boom"}'),
      bodyIsText: true,
    },
  ])
  await settle(() => down.frames.length >= at + 1, 'the ACK', 2000, down)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(down.frames.length, at + 1, 'one frame: no delta, and above all no COMMIT')
  const ack = down.frames[at] as Frame
  assert.equal(str(ack, 'ok'), 'false')
  assert.equal(str(ack, 'code'), 'E_INTENT_FAILED')
  assert.match(str(ack, 'detail') ?? '', /pricing service is down/)

  controller.abort()
  await down.done
  await h.close()
})

test('an intent that invalidates a key another connection holds makes that one stale', async () => {
  const h = await harness({ intents: true })
  const controller = new AbortController()
  const actor = readBinary(h.url('actor'), controller.signal)
  const watcher = readBinary(h.url('watcher'), controller.signal)
  await settle(() => h.hub.channels === 2, 'two channels')
  await send(h.url('actor'), [hello(), frame('REFRESH', { s: 'prices' })])
  await send(h.url('watcher'), [hello(), frame('REFRESH', { s: 'prices' })])
  await settle(() => watcher.frames.length >= 2, 'both served', 2000, watcher)

  // The store has to be holding the key for an invalidation to drop anything.
  await h.store.set('prices:v1', new TextEncoder().encode('x'), { class: 'shared', tags: ['prices'] })
  const at = watcher.frames.length
  await send(h.url('actor'), [
    { ...frame('INTENT', { i: 'p1' }), body: new TextEncoder().encode('{"to":"70.00"}'), bodyIsText: true },
  ])
  await settle(() => watcher.frames.length > at, 'the watcher to hear about it', 2000, watcher)
  const stale = watcher.frames.slice(at).find((f) => f.kind === 'STALE') as Frame
  assert.ok(stale, 'a connection holding the invalidated key is told')
  assert.equal(str(stale, 's'), 'prices')

  controller.abort()
  await Promise.all([actor.done, watcher.done])
  await h.close()
})
