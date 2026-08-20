import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FRAMES,
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
