import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertValidTemplate, baseRenderId, draftTemplate, seal, type Hole, type TemplateIR } from '@weft/ir'
import { str } from '@weft/warp'
import {
  createEpochs,
  createStaleRegistry,
  deltaKey,
  heldFrame,
  parseHeld,
  recordBase,
  recoverBase,
  selectForm,
  surgicalRefresh,
} from '../src/index.ts'
import { memoryStore } from '@weft/adapters'

const decoder = new TextDecoder()

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

/** `<li>{name}</li><b>{total}</b>` — every hole value-projectable, so `delta` is derivable. */
async function prices(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'prices',
        segments: ['<li>', '</li><b>', '</b>'],
        holes: [hole(0, 'name', { path: [0] }), hole(1, 'total', { path: [1] })],
      }),
    ),
  )
}

const ALL = ['html', 'bundle', 'split', 'patch', 'delta'] as const

test('the ladder: resident plus a recovered base is a delta', () => {
  const choice = selectForm({ available: ALL, accepted: ALL, resident: true, baseRecovered: true })
  assert.equal(choice.form, 'delta')
})

test('resident but no base is html, because the data form was cut on measurement', () => {
  const choice = selectForm({ available: ALL, accepted: ALL, resident: true, baseRecovered: false })
  assert.equal(choice.form, 'html')
  assert.match(choice.reason, /base render was not in the store/)
})

test('a template the client does not hold arrives whole, and RTT picks how', () => {
  const far = selectForm({ available: ALL, accepted: ALL, resident: false, baseRecovered: false, rttMs: 220 })
  assert.equal(far.form, 'bundle')
  const near = selectForm({ available: ALL, accepted: ALL, resident: false, baseRecovered: false, rttMs: 10 })
  assert.equal(near.form, 'split')
})

test('a form the client did not accept is never selected', () => {
  const choice = selectForm({
    available: ALL,
    accepted: ['html'],
    resident: true,
    baseRecovered: true,
    prefer: 'delta',
  })
  assert.equal(choice.form, 'html')
})

test('a template that cannot serve delta falls to the floor even when everything else lines up', () => {
  const choice = selectForm({
    available: ['html', 'bundle', 'split', 'patch'],
    accepted: ALL,
    resident: true,
    baseRecovered: true,
  })
  assert.equal(choice.form, 'html')
})

test('HELD round-trips through a frame', () => {
  const held = [{ slot: 's12', tpl: 'a91f', base: 'abc123' }]
  assert.deepEqual(parseHeld(heldFrame(held)), held)
})

test('a base render is recorded under its content address and recovered by it', async () => {
  const store = memoryStore()
  const ir = await prices()
  const values = { name: 'Basmati 5kg', total: '12,000 IQD' }
  const id = await recordBase(store, ir, values)
  assert.equal(id, baseRenderId(ir, values))
  assert.deepEqual(await recoverBase(store, ir.version, id), values)
  assert.equal(await recoverBase(store, ir.version, 'nosuchbase'), null)
})

test('a stateless surgical refresh sends only what changed', async () => {
  const store = memoryStore()
  const ir = await prices()
  const before = { name: 'Basmati 5kg', total: '12,000 IQD' }
  const base = await recordBase(store, ir, before)

  const result = await surgicalRefresh({
    slot: 's12',
    ir,
    next: { name: 'Basmati 5kg', total: '12,400 IQD' },
    held: { slot: 's12', tpl: ir.version, base },
    store,
    accepted: ALL,
  })

  assert.equal(result.choice.form, 'delta')
  assert.equal(result.frame.kind, 'DELTA')
  assert.deepEqual(result.delta?.changed, { total: '12,400 IQD' })
  assert.equal(str(result.frame, 'base'), base)
  assert.equal(str(result.frame, 'next'), result.nextBase)
  assert.equal(result.memoized, false)
})

test('the second client making the same transition is served the memoized delta', async () => {
  const store = memoryStore()
  const ir = await prices()
  const before = { name: 'Basmati 5kg', total: '12,000 IQD' }
  const after = { name: 'Basmati 5kg', total: '12,400 IQD' }
  const base = await recordBase(store, ir, before)

  const first = await surgicalRefresh({
    slot: 's12',
    ir,
    next: after,
    held: { slot: 's12', tpl: ir.version, base },
    store,
    accepted: ALL,
  })
  const second = await surgicalRefresh({
    slot: 's12',
    ir,
    next: after,
    held: { slot: 's12', tpl: ir.version, base },
    store,
    accepted: ALL,
  })

  assert.equal(first.memoized, false)
  assert.equal(second.memoized, true)
  assert.deepEqual(second.delta, first.delta)
  // The delta is named by the transition, not by the connection, which is what makes it shared.
  assert.notEqual(await store.get(deltaKey(ir.version, base, first.nextBase)), null)
})

test('a base the store has lost degrades to markup rather than failing', async () => {
  const store = memoryStore()
  const ir = await prices()
  const result = await surgicalRefresh({
    slot: 's12',
    ir,
    next: { name: 'Basmati 5kg', total: '12,400 IQD' },
    held: { slot: 's12', tpl: ir.version, base: 'gone' },
    store,
    accepted: ALL,
  })
  assert.equal(result.choice.form, 'html')
  assert.equal(result.frame.kind, 'HTML')
  assert.match(decoder.decode(result.frame.body), /<b>12,400 IQD<\/b>/)
})

test('a template version the client does not hold degrades to markup too', async () => {
  const store = memoryStore()
  const ir = await prices()
  const result = await surgicalRefresh({
    slot: 's12',
    ir,
    next: { name: 'Rice', total: '1' },
    held: { slot: 's12', tpl: 'someothertemplate', base: 'abc' },
    store,
    accepted: ALL,
  })
  assert.equal(result.frame.kind, 'HTML')
})

test('invalidation travels the other way: dropped keys become STALE for the holders', async () => {
  const store = memoryStore()
  const registry = createStaleRegistry()
  await store.set('k-cart', new Uint8Array([1]), { class: 'shared', tags: ['cart:42'] })
  await store.set('k-other', new Uint8Array([1]), { class: 'shared', tags: ['other'] })
  registry.hold('conn-a', 's12', 'k-cart')
  registry.hold('conn-b', 's14', 'k-other')

  const dropped = await store.invalidate(['cart:42'])
  assert.deepEqual(dropped, ['k-cart'])

  const pushes = registry.staleFor(dropped, 'tag:cart:42')
  assert.deepEqual([...pushes.keys()], ['conn-a'])
  const frame = pushes.get('conn-a')?.[0]
  assert.equal(frame?.kind, 'STALE')
  assert.equal(str(frame!, 'reason'), 'tag:cart:42')
})

test('a staged epoch paints nothing until it is committed, and commits atomically', () => {
  const epochs = createEpochs()
  epochs.stage('e7', 's12', { kind: 'DELTA', header: {} })
  epochs.stage('e7', 's14', { kind: 'DELTA', header: {} })
  assert.deepEqual(epochs.slots('e7'), ['s12', 's14'])
  assert.deepEqual(
    epochs.staged('e7').map((f) => str(f, 'epoch')),
    ['e7', 'e7'],
  )

  const frames = epochs.commit('e7')
  assert.equal(frames.length, 3)
  assert.equal(frames[2]?.kind, 'COMMIT')
  assert.equal(str(frames[2]!, 'slots'), 's12,s14')
  assert.equal(str(frames[2]!, 'transition'), 'view')
  assert.deepEqual(epochs.open, [])
})

test('staging into the live epoch would defeat the point, so it is refused', () => {
  assert.throws(() => createEpochs().stage('live', 's1', { kind: 'DATA', header: {} }), /E_STAGE_LIVE/)
})

test('a discarded epoch is a rollback with nothing to reconstruct', () => {
  const epochs = createEpochs()
  epochs.stage('optimistic', 's1', { kind: 'DELTA', header: {} })
  assert.equal(epochs.discard('optimistic'), 1)
  assert.throws(() => epochs.commit('optimistic'), /E_NO_SUCH_EPOCH/)
})

test('open epochs are bounded', () => {
  const epochs = createEpochs(2)
  epochs.stage('a', 's', { kind: 'DELTA', header: {} })
  epochs.stage('b', 's', { kind: 'DELTA', header: {} })
  assert.throws(() => epochs.stage('c', 's', { kind: 'DELTA', header: {} }), /E_TOO_MANY_EPOCHS/)
})
