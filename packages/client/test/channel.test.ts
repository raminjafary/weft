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
