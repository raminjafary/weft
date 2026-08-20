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

test('a document from the previous major is refused, not migrated', () => {
  resetMigrations()
  const previous = accepts({ spec: 'weft.template-ir/1', irVersion: '1.1.0' })
  assert.equal(previous.ok, false)
  assert.equal(previous.ok === false && previous.code, 'E_SPEC_MISMATCH')
  // Even with the current spec id, the major gate holds.
  const wrongMajor = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.1.0' })
  assert.equal(wrongMajor.ok === false && wrongMajor.code, 'E_MAJOR_UNSUPPORTED')
})

test('rejects a different major as a wire break', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '3.0.0' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'E_MAJOR_UNSUPPORTED')
})

test('rejects a different spec id outright', () => {
  const result = accepts({ spec: 'weft.plan/1', irVersion: TEMPLATE_IR_VERSION })
  assert.equal(result.ok === false && result.code, 'E_SPEC_MISMATCH')
})

test('accepts a newer minor as forward-compatible', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '2.9.0' })
  assert.equal(result.ok && result.mode, 'forward')
})

test('an older minor of this major is upgradable', () => {
  clearMigrations()
  registerMigration('2.0.0', '2.1.0', (doc) => ({ ...doc, added: true }))
  const reader = { spec: TEMPLATE_IR_SPEC, version: '2.1.0' }
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '2.0.0' }, reader)
  assert.equal(result.ok && result.mode, 'upgrade')
  const { doc } = migrate({ spec: TEMPLATE_IR_SPEC, irVersion: '2.0.0' }, '2.1.0')
  assert.equal(doc.added, true)
  assert.equal(compareVersions('2.0.0', '2.0.1') < 0, true)
  resetMigrations()
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
  assert.throws(() => registerMigration('2.0.0', '3.0.0', (d) => d), /E_MIGRATION_MAJOR/)
})

test('reports a missing migration instead of guessing', () => {
  clearMigrations()
  assert.throws(() => migrate({ spec: TEMPLATE_IR_SPEC, irVersion: '2.0.0' }, '2.2.0'), /E_MIGRATION_MISSING/)
  resetMigrations()
})

after(resetMigrations)
