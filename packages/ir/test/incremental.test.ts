import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertValidTemplate,
  changedBindings,
  createSegmentMemo,
  derivedPlan,
  draftTemplate,
  render,
  renderIncremental,
  resolveDerived,
  resolveDerivedFrom,
  seal,
  segmentKey,
  type DerivedDecl,
  type Hole,
  type TemplateIR,
  type Values,
} from '../src/index.ts'

/**
 * The design's second and third memoisation levels. Every assertion about a saving is paired
 * with one about byte identity, because a faster render that produces different bytes is a
 * correctness bug with a performance justification.
 */
const decoder = new TextDecoder()

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

async function rowTemplate(): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'fragment/row',
        segments: ['<li>', ' × ', '</li>'],
        holes: [hole(0, 'label'), hole(1, 'qty', { path: [1] })],
      }),
    ),
  )
}

async function listTemplate(row: TemplateIR, derived: DerivedDecl[] = []): Promise<TemplateIR> {
  return assertValidTemplate(
    await seal(
      draftTemplate({
        id: 'fragment/list',
        segments: ['<h1>', '</h1><ul>', '</ul>'],
        holes: [hole(0, 'title'), hole(1, 'rows', { kind: 'list', path: [1], nested: row.version })],
        derived,
      }),
    ),
  )
}

const rows = (n: number): Values[] =>
  Array.from({ length: n }, (_, i) => ({ label: `item ${i}`, qty: i })) as unknown as Values[]

test('a cold incremental render is byte-identical to a full one', async () => {
  const row = await rowTemplate()
  const list = await listTemplate(row)
  const resolve = (v: string) => (v === row.version ? row : undefined)
  const values = { title: 'Cart', rows: rows(20) } as unknown as Values
  const memo = createSegmentMemo()

  const out = renderIncremental({ ir: list, values, memo, resolve })
  assert.deepEqual(out.bytes, render(list, values, resolve))
  assert.equal(out.stats.segments.rendered, 20)
  assert.equal(out.stats.segments.reused, 0)
})

test('a repeat render of the same list reuses every row', async () => {
  const row = await rowTemplate()
  const list = await listTemplate(row)
  const resolve = (v: string) => (v === row.version ? row : undefined)
  const values = { title: 'Cart', rows: rows(20) } as unknown as Values
  const memo = createSegmentMemo()

  renderIncremental({ ir: list, values, memo, resolve })
  const again = renderIncremental({ ir: list, values, memo, resolve })
  assert.equal(again.stats.segments.reused, 20)
  assert.equal(again.stats.segments.rendered, 0)
  assert.deepEqual(again.bytes, render(list, values, resolve))
})

test('one changed row costs one row render, and the other nineteen are reused', async () => {
  const row = await rowTemplate()
  const list = await listTemplate(row)
  const resolve = (v: string) => (v === row.version ? row : undefined)
  const before = rows(20)
  const memo = createSegmentMemo()
  renderIncremental({ ir: list, values: { title: 'Cart', rows: before } as unknown as Values, memo, resolve })

  const after = before.map((r, i) => (i === 7 ? { ...r, qty: 99 } : r))
  const next = { title: 'Cart', rows: after } as unknown as Values
  const out = renderIncremental({ ir: list, values: next, memo, resolve })
  assert.equal(out.stats.segments.rendered, 1)
  assert.equal(out.stats.segments.reused, 19)
  assert.deepEqual(out.bytes, render(list, next, resolve))
  assert.match(decoder.decode(out.bytes), /item 7 × 99/)
})

test('a reordered list reuses every row, because the memo is keyed by content', async () => {
  const row = await rowTemplate()
  const list = await listTemplate(row)
  const resolve = (v: string) => (v === row.version ? row : undefined)
  const before = rows(10)
  const memo = createSegmentMemo()
  renderIncremental({ ir: list, values: { title: 'x', rows: before } as unknown as Values, memo, resolve })

  const reversed = { title: 'x', rows: before.toReversed() } as unknown as Values
  const out = renderIncremental({ ir: list, values: reversed, memo, resolve })
  assert.equal(
    out.stats.segments.reused,
    10,
    'index would have invalidated all ten; content invalidates none',
  )
  assert.equal(out.stats.segments.rendered, 0)
  assert.deepEqual(out.bytes, render(list, reversed, resolve))
})

test('a hole whose shape changed is reported as structural rather than silently empty', async () => {
  const row = await rowTemplate()
  const list = await listTemplate(row)
  const resolve = (v: string) => (v === row.version ? row : undefined)
  const memo = createSegmentMemo()
  const out = renderIncremental({
    ir: list,
    values: { title: 'x', rows: 'not an array' } as unknown as Values,
    memo,
    resolve,
  })
  assert.deepEqual(out.stats.structural, ['rows'])
  assert.deepEqual(
    out.bytes,
    render(list, { title: 'x', rows: 'not an array' } as unknown as Values, resolve),
  )
})

test('a derived value a change cannot reach is carried over rather than recomputed', async () => {
  const decls: DerivedDecl[] = [
    { id: 'total', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'qty' }, b: { k: 'ref', id: 'price' } } },
    { id: 'shout', expr: { k: 'un', op: '!', a: { k: 'ref', id: 'title' } } },
  ]
  const plan = derivedPlan(decls)
  const prev = { qty: 2, price: 100, title: 'a' } as unknown as Values
  const prevResolved = resolveDerived(decls, prev)

  const next = { qty: 3, price: 100, title: 'a' } as unknown as Values
  const out = resolveDerivedFrom(plan, prevResolved, next, changedBindings(prev, next))
  assert.deepEqual(out.recomputed, ['total'])
  assert.deepEqual(out.reused, ['shout'])
  // The whole reason this is safe: it agrees with the unconditional version, exactly.
  assert.deepEqual(out.values, resolveDerived(decls, next))
})

test('a derived value reading another derived value is recomputed transitively', () => {
  const decls: DerivedDecl[] = [
    { id: 'sub', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'qty' }, b: { k: 'ref', id: 'price' } } },
    { id: 'withTax', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'sub' }, b: { k: 'lit', v: 1.15 } } },
    { id: 'unrelated', expr: { k: 'ref', id: 'title' } },
  ]
  const plan = derivedPlan(decls)
  assert.deepEqual(plan.affectedBy(new Set(['qty'])), ['sub', 'withTax'])
  assert.deepEqual(plan.affectedBy(new Set(['title'])), ['unrelated'])
  assert.deepEqual(plan.affectedBy(new Set(['nothing'])), [])
})

test('changed bindings ignore key order, because key order is not a change', () => {
  const a = { row: { x: 1, y: 2 } } as unknown as Values
  const b = { row: { y: 2, x: 1 } } as unknown as Values
  assert.deepEqual([...changedBindings(a, b)], [])
})

test('the memo is bounded, and evicts the least recently used', () => {
  const memo = createSegmentMemo({ maxBytes: 30 })
  memo.set('a', new Uint8Array(10))
  memo.set('b', new Uint8Array(10))
  memo.set('c', new Uint8Array(10))
  assert.ok(memo.get('a'))
  memo.set('d', new Uint8Array(10))
  assert.equal(memo.get('b'), undefined, 'b was the least recently used once a was touched')
  assert.ok(memo.get('a'))
  assert.equal(memo.size, 3)
})

test('a segment key is the template version and the content, and nothing else', () => {
  const one = segmentKey('v1', { a: 1 } as unknown as Values)
  assert.equal(one, segmentKey('v1', { a: 1 } as unknown as Values))
  assert.notEqual(one, segmentKey('v2', { a: 1 } as unknown as Values))
  assert.notEqual(one, segmentKey('v1', { a: 2 } as unknown as Values))
})
