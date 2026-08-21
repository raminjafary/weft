import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Adopted } from '../src/adopt.ts'
import { createChannelClient, type ChannelFrame, type Region } from '../src/channel.ts'
import { createEpochs } from '../src/epoch.ts'
import type { ClientTemplate, Json } from '../src/template.ts'

/**
 * Where an arriving frame lands. The properties worth having are all about what a frame
 * does *not* do: a staged delta writes nothing, a delta from a base this client is not
 * holding writes nothing, and a STALE writes nothing and is handed to the application.
 */
const template: ClientTemplate = { version: 'a'.repeat(32), holes: [], wiring: [] }

interface Stub extends Adopted {
  written: [string, Json][]
}

function stub(): Stub {
  const written: [string, Json][] = []
  return {
    template,
    instances: {},
    rows: [],
    written,
    target: () => undefined,
    targets: () => [],
    write: (binding, value) => {
      written.push([binding, value])
    },
  }
}

const utf8 = new TextEncoder()

function deltaFrame(slot: string, base: string, changed: Record<string, Json>, extra = {}): ChannelFrame {
  return {
    kind: 'DELTA',
    header: { s: slot, tpl: template.version, base, next: 'next-base', ...extra },
    body: utf8.encode(JSON.stringify(changed)),
  }
}

function setup(base = 'b1') {
  const adopted = stub()
  const region: Region = { slot: 'prices', adopted, base }
  const stale: string[] = []
  const epochs = createEpochs()
  const client = createChannelClient({
    epochs,
    regions: () => [region],
    onStale: (slot, reason) => stale.push(`${slot}:${reason}`),
  })
  return { adopted, region, stale, epochs, client }
}

test('a delta from the base this client holds becomes one write per changed value', async () => {
  const s = setup()
  const applied = await s.client.apply([deltaFrame('prices', 'b1', { first: '11.00' })])
  assert.equal(applied.writes, 1)
  assert.deepEqual(s.adopted.written, [['first', '11.00']])
  assert.equal(s.region.base, 'next-base', 'the client now holds what it was moved to')
})

test('a delta from a base this client is not holding is refused, not best-efforted', async () => {
  const s = setup('b1')
  const applied = await s.client.apply([deltaFrame('prices', 'somewhere-else', { first: '99.00' })])
  assert.equal(applied.writes, 0)
  assert.deepEqual(s.adopted.written, [], 'plausible values in the wrong render are worse than none')
  assert.match(applied.refused[0]?.reason ?? '', /holds b1, delta is from somewhere-else/)
  assert.equal(s.region.base, 'b1')
})

test('a frame carrying an epoch stages and paints nothing until the COMMIT arrives', async () => {
  const s = setup()
  const staged = await s.client.apply([deltaFrame('prices', 'b1', { first: '12.00' }, { epoch: 'e1' })])
  assert.equal(staged.writes, 0)
  assert.deepEqual(s.adopted.written, [], 'the data arrived, resolved, and did not disturb the page')
  assert.deepEqual(staged.staged, ['prices'])
  assert.equal(s.region.base, 'b1', 'the base is only true once it is painted')

  const committed = await s.client.apply([
    deltaFrame('prices', 'b1', { first: '12.00' }, { epoch: 'e1' }),
    { kind: 'COMMIT', header: { epoch: 'e1', transition: 'instant', slots: 'prices' } },
  ])
  assert.equal(committed.writes, 1)
  assert.deepEqual(s.adopted.written, [['first', '12.00']])
  assert.equal(s.region.base, 'next-base')
})

test('a STALE frame writes nothing and hands the decision to the application', async () => {
  const s = setup()
  const applied = await s.client.apply([{ kind: 'STALE', header: { s: 'prices', reason: 'price change' } }])
  assert.equal(applied.writes, 0)
  assert.deepEqual(applied.stale, ['prices'])
  assert.deepEqual(s.stale, ['prices:price change'])
})

test('the HELD header names the template and the base, which is all the server needs', () => {
  const s = setup('b7')
  assert.deepEqual(s.client.held(), { prices: `${template.version}-b7` })
})

test('a delta for a region this client does not have is named rather than thrown', async () => {
  const s = setup()
  const applied = await s.client.apply([deltaFrame('gone', 'b1', { x: 1 })])
  assert.equal(applied.writes, 0)
  assert.match(applied.refused[0]?.reason ?? '', /no such region/)
})

test('an ERROR frame is surfaced with its code intact', async () => {
  const s = setup()
  const applied = await s.client.apply([
    { kind: 'ERROR', header: { code: 'E_NO_INTENTS', detail: 'not yet dispatched' } },
  ])
  assert.deepEqual(applied.errors, [{ code: 'E_NO_INTENTS', detail: 'not yet dispatched' }])
})

test('a TPL frame joins the resident set through the callback that owns persistence', async () => {
  const seen: string[] = []
  const client = createChannelClient({
    epochs: createEpochs(),
    regions: () => [],
    onTemplate: (t) => void seen.push(t.version),
  })
  const applied = await client.apply([
    { kind: 'TPL', header: { tpl: template.version }, body: utf8.encode(JSON.stringify(template)) },
  ])
  assert.deepEqual(applied.templates, [template.version])
  assert.deepEqual(seen, [template.version])
})

test('a failed intent discards the epoch its optimistic update was staged in', async () => {
  const s = setup()
  const staged = await s.client.apply([deltaFrame('prices', 'b1', { first: '9.99' }, { epoch: 'o-1' })])
  assert.deepEqual(staged.staged, ['prices'])
  assert.deepEqual(s.adopted.written, [], 'the guess painted nothing, which is what makes it undoable')

  const acked = await s.client.apply([
    { kind: 'ACK', header: { i: 'p1', ok: 'false', epoch: 'o-1', code: 'E_INTENT_FAILED' } },
  ])
  assert.deepEqual(acked.discarded, ['o-1'])
  assert.deepEqual(s.epochs.open, [], 'nothing is left staged')
  assert.deepEqual(s.adopted.written, [], 'and nothing had to be un-painted')
  assert.equal(acked.acked[0]?.code, 'E_INTENT_FAILED')
})

test('a successful ACK leaves the epoch alone, because the COMMIT is what paints it', async () => {
  const s = setup()
  await s.client.apply([deltaFrame('prices', 'b1', { first: '9.99' }, { epoch: 'o-2' })])
  const acked = await s.client.apply([{ kind: 'ACK', header: { i: 'p1', ok: 'true', epoch: 'o-2' } }])
  assert.deepEqual(acked.discarded, [])
  assert.deepEqual(s.epochs.open, ['o-2'])
})

/**
 * The optimistic round trip, from the client's side. What makes it worth having is that the
 * failure path does nothing rather than undoing something: the guess was never painted.
 */
test('an optimistic intent stages a guess that paints nothing, and names it on the frame', () => {
  const s = setup()
  const frame = s.client.intent(
    'p1',
    { to: '55.00' },
    {
      epoch: 'o-9',
      optimistic: { prices: { second: '55.00' } },
    },
  )
  assert.equal(frame.kind, 'INTENT')
  assert.equal(frame.header.i, 'p1')
  assert.equal(frame.header.epoch, 'o-9')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frame.body)), { to: '55.00' })
  assert.deepEqual(s.adopted.written, [], 'the guess is staged, so the page is undisturbed')
  assert.deepEqual(s.epochs.staged('o-9'), ['prices'])
})

test('the server refusing it leaves nothing to undo', async () => {
  const s = setup()
  s.client.intent('p1', { to: 'boom' }, { epoch: 'o-9', optimistic: { prices: { second: 'boom' } } })
  const applied = await s.client.apply([
    { kind: 'ACK', header: { i: 'p1', ok: 'false', epoch: 'o-9', code: 'E_INTENT_FAILED' } },
  ])
  assert.deepEqual(applied.discarded, ['o-9'])
  assert.deepEqual(s.adopted.written, [], 'the rollback is a discarded epoch, not a reconstruction')
  assert.equal(s.region.base, 'b1', 'and the base never moved')
})

test('the server agreeing replaces the guess with the truth in one paint', async () => {
  const s = setup()
  s.client.intent('p1', { to: '55.00' }, { epoch: 'o-9', optimistic: { prices: { second: '55.00' } } })
  // The server stages the real values into the same epoch and commits. One slot, one staged
  // value per epoch, so the server's frame supersedes the guess rather than queueing behind it.
  const applied = await s.client.apply([
    { kind: 'ACK', header: { i: 'p1', ok: 'true', epoch: 'o-9' } },
    deltaFrame('prices', 'b1', { second: '55.10' }, { epoch: 'o-9' }),
    { kind: 'COMMIT', header: { epoch: 'o-9', transition: 'instant', slots: 'prices' } },
  ])
  assert.equal(applied.writes, 1, 'one paint, not two')
  assert.deepEqual(s.adopted.written, [['second', '55.10']], 'the truth, not the guess')
  assert.equal(s.region.base, 'next-base')
})

test('a staged guess for a region this client does not hold is dropped, not thrown', () => {
  const s = setup()
  s.client.stage('o-1', 'nowhere', { x: 1 })
  assert.deepEqual(s.epochs.open, [])
})
