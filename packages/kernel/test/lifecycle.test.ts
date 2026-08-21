import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyDeferred,
  createEnvelope,
  createMailbox,
  lifecycle,
  linkHeader,
  sendEarlyHints,
  type PreloadLink,
  type TransportPort,
} from '../src/index.ts'

test('the machine refuses a transition it does not have', () => {
  const life = lifecycle()
  assert.equal(life.state, 'received')
  life.to('envelope')
  life.to('planned')
  assert.throws(() => life.to('envelope'), /E_REQUEST_STATE in state planned/)
})

test('a settled request is terminal', () => {
  const life = lifecycle()
  life.to('envelope')
  life.to('settled')
  assert.throws(() => life.to('streaming'), /E_REQUEST_STATE/)
})

test('the envelope takes writes in phase A and refuses them after the seal', () => {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')

  envelope.status(201)
  envelope.setCookie({ name: 'sid', value: 'abc', httpOnly: true, path: '/' })
  envelope.vary('Cookie')
  const init = envelope.seal()

  assert.equal(init.status, 201)
  const headers = init.headers as Headers
  assert.equal(headers.get('vary'), 'Cookie')
  assert.match(headers.get('set-cookie') ?? '', /sid=abc; Path=\/; HttpOnly/)
  assert.throws(() => envelope.setCookie({ name: 'late', value: '1' }), /E_ENVELOPE_SEALED/)
})

test('sealing twice is an error rather than a second envelope', () => {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  envelope.seal()
  assert.throws(() => envelope.seal(), /E_ENVELOPE_SEALED/)
})

test('a deferrable effect is queued; a non-idempotent one is refused by name', () => {
  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  life.to('planned')
  envelope.seal()
  life.to('streaming')

  envelope.deferrable({ kind: 'cookie', cookie: { name: 'last-seen', value: '7' }, reason: 'timestamp' })
  assert.equal(envelope.deferred.length, 1)

  assert.throws(
    () => envelope.deferrable({ kind: 'cookie', cookie: { name: 'consent', value: 'yes' }, reason: 'gdpr' }),
    /E_NOT_DEFERRABLE.*consent/s,
  )
})

test('a deferred effect becomes a real header on the next request, and only once', () => {
  const mailbox = createMailbox()
  mailbox.owe('c1', [{ kind: 'cookie', cookie: { name: 'token', value: 'v2' }, reason: 'rotation' }])

  const life = lifecycle()
  const envelope = createEnvelope(life)
  life.to('envelope')
  assert.equal(applyDeferred(envelope, mailbox.claim('c1')), 1)
  assert.match((envelope.seal().headers as Headers).get('set-cookie') ?? '', /token=v2/)

  assert.deepEqual(mailbox.claim('c1'), [])
})

test('the mailbox is bounded, because an effect nobody returns for must not accumulate', () => {
  const mailbox = createMailbox(2)
  for (const id of ['a', 'b', 'c']) {
    mailbox.owe(id, [{ kind: 'header', header: { name: 'x-t', value: id }, reason: 'trace' }])
  }
  assert.equal(mailbox.size, 2)
  assert.deepEqual(mailbox.claim('a'), [])
})

const LINKS: PreloadLink[] = [
  { href: '/a.css', as: 'style', rel: 'preload' },
  { href: '/a.js', as: 'script', rel: 'modulepreload' },
]

test('early hints are a Link header, and preload carries an as', () => {
  assert.equal(linkHeader(LINKS), '</a.css>; rel=preload; as=style, </a.js>; rel=modulepreload')
})

test('hints go out before the envelope is committed and never after', async () => {
  const sent: PreloadLink[][] = []
  const transport: TransportPort = {
    name: 'test',
    earlyHints(links) {
      sent.push(links)
      return true
    },
  }
  const life = lifecycle()
  const result = await sendEarlyHints(life, transport, LINKS)
  assert.equal(result.sent, true)
  assert.equal(sent.length, 1)

  life.to('envelope')
  life.to('planned')
  await assert.rejects(() => sendEarlyHints(life, transport, LINKS), /E_HINTS_AFTER_COMMIT/)
})

test('a transport with no 103 says so rather than reporting a send', async () => {
  const result = await sendEarlyHints(lifecycle(), { name: 'plain' }, LINKS)
  assert.equal(result.sent, false)
  assert.match(result.reason ?? '', /does not implement 103/)
})
