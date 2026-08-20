import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Adopted } from '../src/adopt.ts'
import { applyDelta, baseMatches } from '../src/delta.ts'
import type { ClientTemplate, Json } from '../src/template.ts'

const template: ClientTemplate = { version: 'a'.repeat(32), holes: [], wiring: [] }

interface Stub extends Adopted {
  written: [string, Json][]
  rows: Stub[]
}

function stub(rows = 0): Stub {
  const written: [string, Json][] = []
  const node: Stub = {
    template,
    instances: {},
    rows: Array.from({ length: rows }, () => stub()),
    written,
    target: () => undefined,
    targets: () => [],
    write: (binding, value) => {
      written.push([binding, value])
    },
  }
  return node
}

test('a root path writes on the region itself', () => {
  const adopted = stub()
  const writes = applyDelta(adopted, { tpl: template.version, base: 'b', changed: { total: 12 } })
  assert.equal(writes, 1)
  assert.deepEqual(adopted.written, [['total', 12]])
})

test('an indexed path writes on that row alone', () => {
  const adopted = stub(3)
  applyDelta(adopted, { tpl: template.version, base: 'b', changed: { 'rows[1].qty': 4 } })
  assert.deepEqual(adopted.written, [])
  assert.deepEqual(adopted.rows[0]?.written, [])
  assert.deepEqual(adopted.rows[1]?.written, [['qty', 4]])
  assert.deepEqual(adopted.rows[2]?.written, [])
})

test('a path naming a row that is not there is skipped, not guessed', () => {
  const adopted = stub(1)
  const writes = applyDelta(adopted, { tpl: template.version, base: 'b', changed: { 'rows[9].qty': 4 } })
  assert.equal(writes, 0)
})

test('a path that names a row without a field writes nothing', () => {
  const adopted = stub(2)
  const writes = applyDelta(adopted, { tpl: template.version, base: 'b', changed: { 'rows[0]': 4 } })
  assert.equal(writes, 0)
})

test('every changed path is one write', () => {
  const adopted = stub(4)
  const writes = applyDelta(adopted, {
    tpl: template.version,
    base: 'b',
    changed: { total: 1, 'rows[0].qty': 2, 'rows[3].price': 3 },
  })
  assert.equal(writes, 3)
})

test('a base that is not the render in hand is refused before it is applied', () => {
  assert.equal(baseMatches('abc', { tpl: template.version, base: 'abc', changed: {} }), true)
  assert.equal(baseMatches('abc', { tpl: template.version, base: 'def', changed: {} }), false)
})
