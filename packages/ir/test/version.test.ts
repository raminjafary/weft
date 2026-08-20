import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  TEMPLATE_IR_SPEC,
  TEMPLATE_IR_VERSION,
  accepts,
  clearMigrations,
  compareVersions,
  migrate,
  registerMigration,
  resetMigrations,
} from '../src/version.ts'

test('accepts an exact match', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: TEMPLATE_IR_VERSION })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.mode, 'exact')
})

test('the built-in chain upgrades a 1.0.0 document to the reader version', () => {
  resetMigrations()
  const { doc, applied } = migrate({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' })
  assert.equal(doc.irVersion, TEMPLATE_IR_VERSION)
  assert.deepEqual(applied, ['1.0.0 -> 1.1.0'])
})

test('rejects a different major as a wire break', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '2.0.0' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'E_MAJOR_UNSUPPORTED')
})

test('rejects a different spec id outright', () => {
  const result = accepts({ spec: 'weft.plan/1', irVersion: '1.0.0' })
  assert.equal(result.ok === false && result.code, 'E_SPEC_MISMATCH')
})

test('accepts a newer minor as forward-compatible', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.9.0' })
  assert.equal(result.ok && result.mode, 'forward')
})

test('treats an older minor as upgradable and a different major as a break', () => {
  assert.equal(accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' }).ok, true)
  assert.equal(accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' }).ok && accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' }).mode, 'upgrade')
  const older = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '0.9.0' })
  assert.equal(older.ok === false && older.code, 'E_MAJOR_UNSUPPORTED')
  assert.equal(compareVersions('1.0.0', '1.0.1') < 0, true)
})

test('chains registered migrations up to the reader version', () => {
  clearMigrations()
  registerMigration('1.0.0', '1.0.1', (doc) => ({ ...doc, added: 'a' }))
  registerMigration('1.0.1', '1.0.2', (doc) => ({ ...doc, added2: 'b' }))
  const { doc, applied } = migrate({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' }, '1.0.2')
  assert.deepEqual(applied, ['1.0.0 -> 1.0.1', '1.0.1 -> 1.0.2'])
  assert.equal(doc.added, 'a')
  assert.equal(doc.added2, 'b')
})

test('refuses a migration that crosses a major', () => {
  assert.throws(() => registerMigration('1.0.0', '2.0.0', (d) => d), /E_MIGRATION_MAJOR/)
})

test('reports a missing migration instead of guessing', () => {
  clearMigrations()
  assert.throws(() => migrate({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' }, '1.2.0'), /E_MIGRATION_MISSING/)
})

after(resetMigrations)
