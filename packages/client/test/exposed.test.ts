import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computed, createExposure, exposedFrames } from '../src/index.ts'

/**
 * The one channel between a shell and the regions inside it, on the client.
 *
 * The build check — a region consuming a name the shell does not expose — is the plan layer's and is
 * tested there. What is tested here is the half a build check cannot reach: a region is deployed
 * independently, so it can be a version ahead of the shell composing it, and nothing on the wire may
 * widen the set it was granted.
 */
const utf8 = new TextEncoder()

function declaration(values: Record<string, string>) {
  return { kind: 'SIGNAL', header: {}, body: utf8.encode(JSON.stringify(values)) }
}

test('a name the shell does not expose is refused rather than quietly empty', () => {
  const exposure = createExposure({ locale: 'ar' })
  assert.equal(exposure.read('locale')(), 'ar')
  assert.throws(() => exposure.read('cartCount'), /E_NOT_EXPOSED.*cartCount/s)
})

test('the refusal names the set it was checked against, because that is what a reader has to act on', () => {
  const exposure = createExposure({ locale: 'ar', currency: 'IQD' })
  assert.throws(() => exposure.read('cart'), /this page exposes locale,currency/)
})

test('an exposed value is in the signal graph, so a region reading it recomputes when it changes', () => {
  const exposure = createExposure({ currency: 'IQD' })
  const currency = exposure.read('currency')
  let runs = 0
  const label = computed(() => {
    runs++
    return `priced in ${currency()}`
  })

  assert.equal(label(), 'priced in IQD')
  assert.equal(runs, 1)
  exposure.set('currency', 'USD')
  assert.equal(label(), 'priced in USD', 'the region did not have to be told to read again')
  assert.equal(runs, 2, 'and exactly the node that read it recomputed')
})

test('the declaration is the set: a SIGNAL naming something outside it cannot add one', () => {
  // The security property. A region is a separate deployment and its frames reach this client, so a
  // table anything could write to would be a global with extra steps.
  const exposure = createExposure()
  const route = exposedFrames(exposure)
  route(declaration({ currency: 'IQD' }))

  assert.deepEqual(exposure.names, ['currency'])
  route({ kind: 'SIGNAL', header: { name: 'identity', v: 'user-7' } })
  assert.deepEqual(exposure.names, ['currency'], 'the name was refused, not created')
  assert.throws(() => exposure.read('identity'), /E_NOT_EXPOSED/)
})

test('a name the shell has stopped exposing stops being readable rather than keeping its last value', () => {
  const exposure = createExposure()
  const route = exposedFrames(exposure)
  route(declaration({ currency: 'IQD', locale: 'ar' }))
  route(declaration({ currency: 'IQD' }))

  assert.deepEqual(exposure.names, ['currency'])
  assert.throws(() => exposure.read('locale'), /E_NOT_EXPOSED/)
})

test('a declaration for a name already held updates it rather than replacing the signal', () => {
  // Otherwise a reconnection would hand every region a new signal and silently orphan every
  // subscription taken against the old one.
  const exposure = createExposure()
  const route = exposedFrames(exposure)
  route(declaration({ currency: 'IQD' }))
  const currency = exposure.read('currency')
  route(declaration({ currency: 'USD' }))

  assert.equal(currency(), 'USD', 'the same readable, a new value')
  assert.equal(exposure.read('currency'), currency, 'and it is the same object')
})

test('a SIGNAL is the only frame this router acts on, so composing it with others is safe', () => {
  const exposure = createExposure({ currency: 'IQD' })
  const route = exposedFrames(exposure)
  route({ kind: 'DELTA', header: { s: 'search', name: 'currency', v: 'USD' } })
  assert.equal(exposure.read('currency')(), 'IQD')
})

test('there is no write side, so a region cannot set a shell signal', () => {
  const exposure = createExposure({ currency: 'IQD' })
  const currency = exposure.read('currency') as unknown as Record<string, unknown>
  assert.equal(
    typeof currency.set,
    'undefined',
    'a Readable and not a Signal: the exposed set is a shell offering values, not a shared bus',
  )
})

test('a refused signal is reported, because a dropped one looks like one that never arrived', () => {
  const lines: string[] = []
  const exposure = createExposure()
  const route = exposedFrames(exposure, (line) => lines.push(line))
  route(declaration({ currency: 'IQD' }))
  route({ kind: 'SIGNAL', header: { name: 'currency', v: 'USD' } })
  route({ kind: 'SIGNAL', header: { name: 'identity', v: 'user-7' } })

  assert.deepEqual(lines, [
    'SIGNAL declared currency',
    'SIGNAL currency=USD',
    'SIGNAL identity refused: not exposed',
  ])
})
