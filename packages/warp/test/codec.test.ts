import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FRAMES,
  RETIRED,
  createBinaryDecoder,
  createTextDecoder,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeStream,
  encodeTextFrame,
  frame,
  preamble,
  type AnyFrame,
} from '../src/index.ts'

const utf8 = new TextEncoder()
const decode = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined)

function drain(
  decoder: ReturnType<typeof createBinaryDecoder>,
  bytes: Uint8Array,
  chunkSize: number,
): AnyFrame[] {
  const out: AnyFrame[] = []
  for (let i = 0; i < bytes.length; i += chunkSize)
    out.push(...decoder.push(bytes.subarray(i, i + chunkSize)))
  decoder.end()
  return out
}

test('every frame code declares its direction by range', () => {
  for (const [kind, def] of Object.entries(FRAMES)) {
    assert.equal(
      def.dir === 'up' ? def.code < 0x10 : def.code >= 0x10,
      true,
      `${kind} code contradicts its direction`,
    )
  }
})

test('binary framing round-trips a header and an opaque body', () => {
  const original = frame(
    'HTML',
    { slot: 's12', form: 'html' },
    utf8.encode('<li>Basmati 5kg — 12,000 IQD</li>'),
    true,
  )
  const bytes = encodeStream([original])
  const [decoded] = drain(createBinaryDecoder(), bytes, bytes.length)
  assert.equal(decoded?.kind, 'HTML')
  assert.deepEqual(decoded?.header, { slot: 's12', form: 'html' })
  assert.equal(decode(decoded?.body), '<li>Basmati 5kg — 12,000 IQD</li>')
})

test('the decoder reassembles frames split at every byte boundary', () => {
  const frames = [
    frame('SHELL', { route: '/cart', plan: 'p7', flags: '3f2a' }),
    frame('HTML', { slot: 's12' }, utf8.encode('<p>a & b</p>'), true),
    frame('COMMIT', { epoch: 'e7', transition: 'view' }),
  ]
  const bytes = encodeStream(frames)
  for (const chunkSize of [1, 3, 7, 64]) {
    const decoded = drain(createBinaryDecoder(), bytes, chunkSize)
    assert.equal(decoded.length, 3, `chunk size ${chunkSize}`)
    assert.equal(decoded[2]?.kind, 'COMMIT')
    assert.equal(decode(decoded[1]?.body), '<p>a & b</p>')
  }
})

test('an unknown frame kind is skipped intact, which is why frames are length-prefixed', () => {
  const known = encodeBinaryFrame(frame('SHELL', { route: '/cart' }))
  const future = encodeBinaryFrame({
    kind: 'HTML',
    header: { slot: 's99' },
    body: utf8.encode('later'),
    bodyIsText: true,
  })
  future[0] = 0x7e
  const stream = new Uint8Array(preamble().length + known.length + future.length)
  stream.set(preamble(), 0)
  stream.set(known, preamble().length)
  stream.set(future, preamble().length + known.length)

  const decoded = drain(createBinaryDecoder(), stream, 5)
  assert.equal(decoded[0]?.kind, 'SHELL')
  assert.equal(decoded[1]?.kind, 'UNKNOWN')
  assert.equal(decoded[1]?.kind === 'UNKNOWN' && decoded[1].code, 0x7e)
  assert.equal(decode(decoded[1]?.body), 'later')
})

test('a frame travelling the wrong way is a protocol violation, not a version gap', () => {
  const bytes = encodeStream([frame('SHELL', { route: '/' })])
  assert.throws(() => createBinaryDecoder({ expect: 'up' }).push(bytes), /E_WRONG_DIRECTION/)
})

test('a foreign stream and a foreign major are both refused at the preamble', () => {
  assert.throws(() => createBinaryDecoder().push(utf8.encode('HTTP/1.1 ')), /E_BAD_MAGIC/)
  const wrong = preamble(9, 0)
  assert.throws(() => createBinaryDecoder().push(wrong), /E_WARP_MAJOR/)
})

test('a truncated frame is reported rather than delivered half-read', () => {
  const bytes = encodeStream([frame('HTML', { slot: 's1' }, utf8.encode('hello'), true)])
  const decoder = createBinaryDecoder()
  decoder.push(bytes.subarray(0, bytes.length - 2))
  assert.throws(() => decoder.end(), /E_TRUNCATED_FRAME/)
})

test('text framing keeps one frame per line even when the body has newlines', () => {
  const original = frame('HTML', { slot: 's12' }, utf8.encode('<p>one</p>\n<p>two</p>'), true)
  const line = encodeTextFrame(original)
  assert.equal(line.includes('\n'), false)
  const decoded = decodeTextFrame(line)
  assert.equal(decode(decoded.body), '<p>one</p>\n<p>two</p>')
})

test('header values survive spaces and equals signs', () => {
  const original = frame('STALE', { slot: 's12', reason: 'tag:cart:42 key=feed@c012,currency=IQD' })
  const decoded = decodeTextFrame(encodeTextFrame(original))
  assert.deepEqual(decoded.header, original.header)
})

test('the text decoder emits frames as lines complete', () => {
  const decoder = createTextDecoder()
  const bytes = encodeStream(
    [frame('SIGNAL', { name: 'cart.count', value: 3 }), frame('NAV', { to: '/checkout' })],
    'text',
  )
  assert.equal(decoder.push(bytes.subarray(0, 10)).length, 0)
  const rest = decoder.push(bytes.subarray(10))
  assert.equal(rest.length, 2)
  assert.equal(rest[1]?.kind, 'NAV')
})

/**
 * `every frame code declares its direction by range`, above, passed for the whole time `ACK`
 * was declared at 0x06 in the up range and used for the result of an intent, which travels
 * down. The gate was checking the table against itself: the code and the declared direction
 * agreed, and neither of them agreed with what the frame was for.
 *
 * Nothing static could have caught it. What caught it was a real socket, where the decoder
 * rejected the server's own answer as a wrong-direction frame. So what is added here is the
 * one thing a table can still be checked for — that a code retired for meaning the wrong
 * thing is never quietly reused for something else.
 */
test('no two frames share a code, and no retired code is reused', () => {
  const byCode = new Map<number, string>()
  for (const [kind, def] of Object.entries(FRAMES)) {
    const existing = byCode.get(def.code)
    assert.equal(existing, undefined, `0x${def.code.toString(16)}: ${kind} and ${existing}`)
    byCode.set(def.code, kind)
  }
  for (const retired of RETIRED) {
    assert.equal(
      byCode.get(retired.code),
      undefined,
      `0x${retired.code.toString(16)} was ${retired.was} and is reused by ${byCode.get(retired.code)}. A reused code is the one version mistake a length prefix cannot protect a reader from`,
    )
  }
})

test('a decoder expecting one direction refuses the other by name', () => {
  assert.throws(
    () => drain(createBinaryDecoder({ expect: 'down' }), encodeStream([frame('REFRESH', { s: 'x' })]), 64),
    /E_WRONG_DIRECTION/,
  )
})

/**
 * A socket is one stream, so its decoder consumes one preamble — and what happens to the second
 * one decides whether a bug like this is five minutes or an afternoon.
 *
 * `WRP1\x01\x08\x00\x00` parses as a perfectly well-formed frame header: code 0x57, a 12624-byte
 * header and a 2049-byte body. So a decoder that simply carried on would sit waiting for 14 KB
 * that no sender is going to send, on a channel that stays open and reports nothing — which is
 * exactly what shipped, and what made every intent on a live page silently do nothing.
 */
test('a second preamble mid-stream is refused by name rather than waited on', () => {
  const decoder = createBinaryDecoder({ expect: 'up' })
  assert.deepEqual(
    decoder.push(encodeStream([frame('REFRESH', { s: 'body' })])).map((f) => f.kind),
    ['REFRESH'],
    'the first stream is ordinary',
  )
  assert.throws(
    () => decoder.push(encodeStream([frame('REFRESH', { s: 'body' })])),
    /E_REPEATED_PREAMBLE/,
    'and the second announcement is named, not absorbed',
  )
})

/** The continuation a socket actually sends: frames with no preamble, on a decoder that has one. */
test('frames without a preamble continue a stream that already announced itself', () => {
  const decoder = createBinaryDecoder({ expect: 'up' })
  decoder.push(encodeStream([frame('RESIDENT', { warp: '1.8.0' })]))
  const next = decoder.push(encodeBinaryFrame(frame('INTENT', { i: '885475' })))
  assert.deepEqual(
    next.map((f) => f.kind),
    ['INTENT'],
    'a socket announces once and then sends frames',
  )
  const third = decoder.push(encodeBinaryFrame(frame('REFRESH', { s: 'body' })))
  assert.deepEqual(
    third.map((f) => f.kind),
    ['REFRESH'],
  )
})

/** Direction is in the first byte, so it is refused on read rather than after the body arrives. */
test('a wrong-direction frame is refused before its body is waited for', () => {
  const decoder = createBinaryDecoder({ expect: 'up' })
  decoder.push(preamble())
  // A header claiming a large body, of a frame travelling the wrong way. Only the eight header
  // bytes are pushed: a decoder that checked direction after completing the frame would return
  // nothing here and wait, which is indistinguishable from a slow peer.
  const down = encodeBinaryFrame(frame('ACK', { i: 'x' }, utf8.encode('x'.repeat(4096))))
  assert.throws(() => decoder.push(down.subarray(0, 8)), /E_WRONG_DIRECTION/)
})

/**
 * The property the repeated-preamble guard rests on: no frame can begin with the magic.
 *
 * The guard reads four bytes and compares them to `WRP1`. That is only sound because a frame's
 * first byte is a code and no code is `0x57`. Asserted rather than assumed — a future frame kind
 * allocated at `0x57` would turn a legitimate frame into a protocol error, and the failure would
 * look like the bug the guard was added to catch rather than like a code collision.
 */
test('no frame code collides with the first byte of the preamble', () => {
  const magicFirstByte = preamble()[0]
  assert.equal(magicFirstByte, 0x57, 'WRP1 begins with W')
  for (const [kind, def] of Object.entries(FRAMES)) {
    assert.notEqual(def.code, magicFirstByte, `${kind} is allocated at 0x57, which the magic claims`)
  }
  for (const retired of RETIRED) {
    assert.notEqual(retired.code, magicFirstByte, `${retired.was} was at 0x57 and could come back`)
  }
})
