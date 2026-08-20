import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { TEMPLATE_IR_SPEC, accepts, clearMigrations, compareVersions, migrate, registerMigration } from '../src/version.ts'

test('accepts an exact match', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.0.0' })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.mode, 'exact')
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
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '1.4.0' })
  assert.equal(result.ok && result.mode, 'forward')
})

test('treats an older minor as upgradable', () => {
  const result = accepts({ spec: TEMPLATE_IR_SPEC, irVersion: '0.9.0' })
  assert.equal(result.ok === false && result.code, 'E_MAJOR_UNSUPPORTED')
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

after(clearMigrations)
