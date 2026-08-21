import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intentId } from '../../compiler/src/intents.ts'
import { defineIntent, type Intent } from '../../kernel/src/intent.ts'
import { manifestRegistry } from '../src/registry.ts'

const noop = defineIntent({ name: 'noop', writes: [], run: () => {} }) as Intent<never>

test('the registry derives ids with the same function that wrote them into the wiring', async () => {
  const registry = manifestRegistry([{ module: 'src/cart.ts', export: 'addLine', intent: noop }])
  const id = intentId('src/cart.ts', 'addLine')
  assert.equal(await registry.intent(id), noop)
  assert.deepEqual(registry.intents(), [id])
  assert.equal(registry.idFor('src/cart.ts', 'addLine'), id)
})

test('an id nothing registered resolves to nothing rather than to something else', async () => {
  const registry = manifestRegistry([{ module: 'src/cart.ts', export: 'addLine', intent: noop }])
  assert.equal(await registry.intent('ffffff'), undefined)
})

test('renaming the export changes the id, and moving the module changes it too', () => {
  const a = intentId('src/cart.ts', 'addLine')
  assert.notEqual(a, intentId('src/cart.ts', 'addItem'))
  assert.notEqual(a, intentId('src/basket.ts', 'addLine'))
})

test('two entries hashing to one id fail the build rather than shadowing each other', () => {
  assert.throws(
    () =>
      manifestRegistry([
        { module: 'src/cart.ts', export: 'addLine', intent: noop },
        { module: 'src/cart.ts', export: 'addLine', intent: noop },
      ]),
    /E_INTENT_ID_COLLISION/,
  )
})
