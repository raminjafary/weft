import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { heldFrame } from '@weftjs/kernel'
import { createApp, serveApp, type Serving } from '../src/server.ts'
import {
  createBinaryDecoder,
  encodeBinaryFrame,
  frame,
  preamble,
  residentFrame,
  str,
  WARP_VERSION,
  type AnyFrame,
} from '@weftjs/warp'

/**
 * An intent over the socket, through the front door, on an application the framework scaffolds.
 *
 * This is the gap the shipped 0.2.0 fell through, and the shape of the gap is worth writing down
 * because every layer's own tests passed. `packages/adapters/test/channel.test.ts` drives a real
 * socket and gets this right — it sends one preamble and then `upFrames(...).subarray(8)` for every
 * frame after, with a comment saying one socket is one stream. But it hand-rolls that framing. The
 * real browser client is `weft/src/client/boot.ts`, and it called `encodeStream` per message, which
 * prepends a preamble every time.
 *
 * So the server's long-lived decoder consumed the first preamble and then met a second one, which
 * parses as a well-formed header claiming a 12624-byte header and a 2049-byte body: it waited for
 * 14 KB that was never coming, on a channel that stayed open and reported nothing. Every frame
 * after the first was swallowed. On any `live: true` page that meant the intent buttons did nothing
 * at all — no ACK, no error, no write — while the same intent over `POST /_weft/i/<name>` worked,
 * so the no-JavaScript path and every server-side test stayed green.
 *
 * What was missing was a test that took the client's side of the wire seriously. This one does the
 * two halves that catch it: the protocol end-to-end through `createApp`, and an assertion about
 * what `boot.ts` actually sends.
 */
const ROOT = fileURLToPath(new URL('../../../demo', import.meta.url))

const servers: Serving[] = []
after(async () => {
  for (const serving of servers) await serving.close()
})

let started: Promise<{ serving: Serving; intents: Record<string, string> }> | null = null
function app(): Promise<{ serving: Serving; intents: Record<string, string> }> {
  started ??= (async () => {
    const built = await createApp(ROOT, { mode: 'dev', port: 0 })
    const serving = await serveApp(built)
    servers.push(serving)
    return { serving, intents: built.intents.names }
  })()
  return started
}

/** One frame as its own whole stream: a preamble and the frame. What the shipped client sent. */
function whole(f: ReturnType<typeof frame>): Uint8Array<ArrayBuffer> {
  const body = encodeBinaryFrame(f)
  const out = new Uint8Array(new ArrayBuffer(preamble().length + body.length))
  out.set(preamble(), 0)
  out.set(body, preamble().length)
  return out
}

/** What a client announces about itself, which the socket carries once. */
function hello(): ReturnType<typeof residentFrame> {
  return residentFrame({
    warp: WARP_VERSION,
    ir: '2.0.0',
    forms: ['html', 'delta', 'patch'],
    transport: 'socket',
  })
}

/**
 * One socket, driven the way a browser drives it: announce once, then send frames.
 *
 * `open()` sends the preamble with the first message and nothing but frames after — which is the
 * contract `boot.ts` now keeps and did not.
 */
async function channel(url: string, path: string, id: string) {
  const socket = new WebSocket(
    `${url.replace(/^http/, 'ws')}_weft/channel?c=${id}&at=${encodeURIComponent(path)}`,
  )
  socket.binaryType = 'arraybuffer'
  const decoder = createBinaryDecoder({ expect: 'down' })
  const arrived: AnyFrame[] = []
  socket.addEventListener('message', (event) => {
    const data = event.data as ArrayBuffer | string
    if (typeof data === 'string') return
    arrived.push(...decoder.push(new Uint8Array(data)))
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('the upgrade was refused')), { once: true })
  })

  let announced = false
  const send = (frames: ReturnType<typeof frame>[]): void => {
    const parts = frames.map(encodeBinaryFrame)
    const body = announced ? parts : [preamble(), ...parts]
    announced = true
    let total = 0
    for (const part of body) total += part.length
    const out = new Uint8Array(total)
    let at = 0
    for (const part of body) {
      out.set(part, at)
      at += part.length
    }
    socket.send(out)
  }

  /** Waits for a frame of a kind, so a test asserts on arrival rather than on a timer. */
  const waitFor = async (kind: string, ms = 4000): Promise<AnyFrame | undefined> => {
    const until = Date.now() + ms
    for (;;) {
      const found = arrived.find((f) => f.kind === kind)
      if (found) return found
      if (Date.now() > until) return undefined
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  return { socket, send, arrived, waitFor, close: () => socket.close() }
}

/**
 * The regression, end to end: a frame sent after the announcement is acted on.
 *
 * `feed.tick` takes no input and needs no capability, so what this asserts is the protocol and not
 * the demo's authorization: an INTENT that arrives as a continuation frame comes back ACKed, and it
 * comes back `ok`. Before the fix nothing came back at all.
 */
test('an intent sent after the socket announced itself is acted on and acknowledged', async () => {
  const { serving, intents } = await app()
  const id = intents['feed.tick']
  assert.ok(id, 'the demo declares feed.tick')

  const ch = await channel(serving.url, '/app/feed', 'socket-intent-1')
  try {
    // The announcement carries the preamble. Everything after it is frames, which is what one
    // stream means — and what the client used to get wrong.
    ch.send([hello()])
    ch.send([frame('INTENT', { i: id, epoch: 'o-test-1' })])

    const ack = await ch.waitFor('ACK')
    assert.ok(ack, 'an INTENT over the channel is answered, or the button on a live page does nothing')
    assert.equal(str(ack as never, 'i') ?? str(ack as never, 'intent'), id, 'the ACK names the intent')
    assert.equal(str(ack as never, 'ok'), 'true', `the intent was refused: ${JSON.stringify(ack.header)}`)
  } finally {
    ch.close()
  }
})

/**
 * And a second one on the same socket, because the failure was cumulative rather than first-frame.
 *
 * A decoder left waiting for a body that never arrives stays waiting: the bug was not that one
 * frame was lost but that the stream was wedged from the second message onward. Two intents on one
 * socket is the smallest test that says the stream is still usable.
 */
test('a socket stays usable for more than one frame', async () => {
  const { serving, intents } = await app()
  const id = intents['feed.tick'] as string
  const ch = await channel(serving.url, '/app/feed', 'socket-intent-2')
  try {
    ch.send([hello()])
    ch.send([frame('INTENT', { i: id, epoch: 'o-a' })])
    assert.ok(await ch.waitFor('ACK'), 'the first intent is answered')
    const seen = ch.arrived.filter((f) => f.kind === 'ACK').length
    ch.send([frame('INTENT', { i: id, epoch: 'o-b' })])
    const until = Date.now() + 4000
    for (;;) {
      if (ch.arrived.filter((f) => f.kind === 'ACK').length > seen) break
      assert.ok(Date.now() < until, 'the second intent on the same socket was swallowed')
      await new Promise((r) => setTimeout(r, 25))
    }
  } finally {
    ch.close()
  }
})

/**
 * The client's half, asserted on the source.
 *
 * `boot.ts` is a browser bundle with a byte budget the build enforces, so it is not imported here —
 * the same reason `navigated.test.ts` checks a string rather than sharing a constant. What matters
 * is that the socket branch announces once: a `send` that always called the whole-stream encoder is
 * precisely the bug, and it is invisible from every server-side test in the repository.
 */
const boot = readFileSync(fileURLToPath(new URL('../src/client/boot.ts', import.meta.url)), 'utf8')

test('the client announces its version once per socket, not once per message', () => {
  const socketBranch = boot.slice(
    boot.indexOf('const post = async'),
    boot.indexOf('const post = async') + 600,
  )
  assert.match(socketBranch, /if \(socket\)/, 'the socket branch is where a message is framed')
  assert.match(
    socketBranch,
    /announced \? encodeUpContinued\(frames\) : encodeUp\(frames\)/,
    'the first message carries the preamble and the rest do not',
  )
  assert.match(socketBranch, /announced = true/, 'and the flag is set, or every message is the first')
  assert.match(
    boot,
    /function encodeUpContinued/,
    'the continuation encoder exists rather than a subarray(8) at the call site',
  )
})

/**
 * And the wrong framing is refused out loud, which is the half that keeps this bug cheap.
 *
 * A client that re-announces on every message is a mistake somebody will make again — the encoder
 * that does it is one function call away from the one that does not. What made it expensive was
 * not the mistake but the silence: the stream wedged, the socket stayed open, and there was
 * nothing anywhere to read. So the decoder now names a second preamble, the channel closes with
 * that reason, and the next person to make this mistake is told in one line.
 */
test('a client that re-announces on every message is closed with the reason', async () => {
  const { serving } = await app()
  const url = `${serving.url.replace(/^http/, 'ws')}_weft/channel?c=socket-intent-3&at=${encodeURIComponent('/app/feed')}`
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }))
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('the upgrade was refused')), { once: true })
  })

  // Twice, each with its own preamble — which is exactly what the shipped client did.
  socket.send(whole(hello()))
  socket.send(whole(frame('REFRESH', { s: 'body' })))

  const { code, reason } = await Promise.race([
    closed,
    new Promise<{ code: number; reason: string }>((resolve) =>
      setTimeout(() => resolve({ code: 0, reason: '' }), 4000),
    ),
  ])

  /**
   * That it closed, which is the whole property. Not which code carried the news.
   *
   * The bug being guarded against is silence: a decoder that waits for a body no sender will send
   * leaves the channel open and reports nothing. So the assertion is that the connection ends.
   *
   * The code is deliberately not pinned. The server closes with 1002 and the reason, but a close
   * frame races the socket teardown behind it — when the teardown wins, the client is handed 1006
   * with no reason, which is what an abnormal close means and is not a different outcome. Pinning
   * 1002 made this test fail about a quarter of the time for a reason that has nothing to do with
   * the protocol rule it is here to check.
   */
  assert.notEqual(code, 0, 'the socket was still open, so the stream wedged silently')
  if (reason) {
    assert.match(reason, /E_REPEATED_PREAMBLE/, 'a close that carries a reason names the rule broken')
  }
})

/**
 * A page that has only just loaded is told about a write, which is the feature the scaffold's own
 * counter page advertises: "open this page in two tabs and press the button in one".
 *
 * Push invalidation matches a dropped key against what each connection holds, and a connection was
 * recorded as holding a region only by `serveSlot` — which runs on a REFRESH. So a client that had
 * opened, adopted its live region and declared it with `HELD` held nothing as far as the registry
 * was concerned: the first intent from anywhere else reached every tab that had already refreshed
 * and none that had merely arrived. Two tabs, press in one, and the other sat there.
 *
 * The second channel here does exactly what a fresh page does and no more — RESIDENT, then HELD —
 * and never asks for anything. What it must receive is a STALE, unprompted.
 */
test('a channel that has only declared what it holds is told when that is invalidated', async () => {
  const { serving, intents } = await app()
  const id = intents['feed.tick'] as string

  const watcher = await channel(serving.url, '/app/feed', 'stale-watcher')
  const firing = await channel(serving.url, '/app/feed', 'stale-firing')
  try {
    // The watcher declares what it is showing, the way a page does on load, and stops there.
    watcher.send([hello()])
    watcher.send([heldFrame([{ slot: 'body', tpl: 'x'.repeat(32), base: 'y'.repeat(16) }], { only: true })])
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(
      watcher.arrived.filter((f) => f.kind === 'REFRESH' || f.kind === 'DELTA').length,
      0,
      'it has asked for nothing, which is the whole point',
    )

    // Somebody else writes the tag its region is held under.
    firing.send([hello()])
    firing.send([frame('INTENT', { i: id, epoch: 'o-stale' })])
    assert.ok(await firing.waitFor('ACK'), 'the intent ran')

    const stale = await watcher.waitFor('STALE')
    assert.ok(stale, 'a page that had only declared what it holds was never told the write happened')
    assert.equal(str(stale as never, 's'), 'body', 'and it names the region that went stale')
  } finally {
    watcher.close()
    firing.close()
  }
})

/** And the connection that fired it is not told: it is about to be handed the new values. */
test('the channel that fired the intent is not sent a stale frame about its own write', async () => {
  const { serving, intents } = await app()
  const id = intents['feed.tick'] as string
  const ch = await channel(serving.url, '/app/feed', 'stale-self')
  try {
    ch.send([hello()])
    ch.send([heldFrame([{ slot: 'body', tpl: 'x'.repeat(32), base: 'y'.repeat(16) }], { only: true })])
    ch.send([frame('INTENT', { i: id, epoch: 'o-self' })])
    assert.ok(await ch.waitFor('ACK'), 'the intent ran')
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(
      ch.arrived.filter((f) => f.kind === 'STALE').length,
      0,
      'being told your own write went stale is a refresh nobody asked for',
    )
  } finally {
    ch.close()
  }
})
