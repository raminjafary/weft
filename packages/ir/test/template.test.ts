import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyDelta,
  baseRenderId,
  dataPayload,
  deltaPayload,
  draftTemplate,
  parse,
  projectData,
  render,
  seal,
  stringify,
  validateTemplate,
  verifySealed,
  type Hole,
  type TemplateIR,
  type Values,
} from '../src/index.ts'

const decode = (b: Uint8Array) => new TextDecoder().decode(b)

function hole(index: number, binding: string, extra: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [index], ...extra }
}

async function row(): Promise<TemplateIR> {
  return seal(
    draftTemplate({
      id: 'row',
      segments: ['<li>', ' x', '</li>'],
      holes: [hole(0, 'name'), hole(1, 'qty', { escape: 'proven-safe' })],
    }),
  )
}

test('rejects a segment count that cannot interleave with the holes', () => {
  const ir = draftTemplate({ id: 't', segments: ['<p>'], holes: [hole(0, 'a')] })
  const result = validateTemplate(ir)
  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.code, 'E_SEGMENT_COUNT')
})

test('a slot hole makes the data and delta forms unprovable', () => {
  const ir = draftTemplate({
    id: 't',
    segments: ['<div>', '</div>'],
    holes: [hole(0, 'children', { kind: 'slot' })],
  })
  assert.deepEqual(ir.forms, ['html', 'bundle', 'split', 'patch'])
  const lying = { ...ir, forms: [...ir.forms, 'data' as const] }
  assert.equal(validateTemplate(lying).errors[0]?.code, 'E_FORM_UNPROVABLE')
})

test('html is always offered because it needs nothing resident', () => {
  const ir = draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] })
  assert.equal(validateTemplate({ ...ir, forms: ['data'] }).errors.some((e) => e.code === 'E_FORM_FLOOR'), true)
})

test('raw interpolation must name who vouched for it', () => {
  const ir = draftTemplate({
    id: 't',
    segments: ['<p>', '</p>'],
    holes: [hole(0, 'a', { escape: 'trusted-raw' })],
  })
  assert.equal(validateTemplate(ir).errors[0]?.code, 'E_RAW_UNVOUCHED')
})

test('the client cannot be wired to a binding it has no way to resolve', () => {
  const ir = draftTemplate({
    id: 't',
    segments: ['<p>', '</p>'],
    holes: [hole(0, 'a')],
    wiring: [{ path: [0], op: 'text', binding: 'ghost' }],
  })
  assert.equal(validateTemplate(ir).errors[0]?.code, 'E_WIRING_UNKNOWN_BINDING')
})

test('an event may only name an intent, never server code', () => {
  const ir = draftTemplate({
    id: 't',
    segments: ['<button>', '</button>'],
    holes: [hole(0, 'label')],
    wiring: [{ path: [0], op: 'event', binding: 'label', event: 'click' }],
  })
  assert.equal(validateTemplate(ir).errors.some((e) => e.code === 'E_WIRING_INTENT'), true)
})

test('the content address addresses the content', async () => {
  const ir = await seal(draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] }))
  assert.match(ir.version, /^[0-9a-f]{32}$/)
  assert.equal((await verifySealed(ir)).ok, true)

  const tampered: TemplateIR = { ...ir, segments: [new TextEncoder().encode('<div>'), ir.segments[1] as Uint8Array] }
  const result = await verifySealed(tampered)
  assert.equal(result.ok, false)
  assert.equal(result.errors.some((e) => e.code === 'E_VERSION_MISMATCH'), true)
})

test('a documentation edit does not invalidate a resident template', async () => {
  const base = draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] })
  const a = await seal(base)
  const b = await seal({ ...base, meta: { note: 'renamed in review' } })
  assert.equal(a.version, b.version)
})

test('escaping happens where it must and is elided where it cannot matter', async () => {
  const ir = await seal(
    draftTemplate({
      id: 't',
      segments: ['<p title="', '">', '</p>'],
      holes: [hole(0, 'title', { kind: 'attr' }), hole(1, 'body')],
    }),
  )
  const html = decode(render(ir, { title: 'a "quote" & <tag>', body: 'x < y & z' }))
  assert.equal(html, '<p title="a &quot;quote&quot; &amp; &lt;tag&gt;">x &lt; y &amp; z</p>')
})

test('a boolean attribute renders as presence, not as a value', async () => {
  const ir = await seal(
    draftTemplate({
      id: 't',
      segments: ['<button ', '>go</button>'],
      holes: [hole(0, 'disabled', { kind: 'attr-bool', attr: 'disabled', escape: 'proven-safe' })],
    }),
  )
  assert.equal(decode(render(ir, { disabled: true })), '<button disabled>go</button>')
  assert.equal(decode(render(ir, { disabled: false })), '<button >go</button>')
})

test('the data form projects to the same bytes as the html form', async () => {
  const rowIr = await row()
  const rootIr = await seal(
    draftTemplate({
      id: 'root',
      segments: ['<ul>', '</ul>'],
      holes: [hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: rowIr.version })],
    }),
  )
  const resolve = (v: string) => (v === rowIr.version ? rowIr : undefined)
  const values: Values = { rows: [{ name: 'Dates & nuts', qty: 2 }, { name: 'Sumac', qty: 1 }] }

  const html = render(rootIr, values, resolve)
  const projected = projectData(rootIr, dataPayload(rootIr, values), resolve)
  assert.deepEqual([...projected], [...html])
  assert.equal(decode(html), '<ul><li>Dates &amp; nuts x2</li><li>Sumac x1</li></ul>')
})

test('a delta names one path per changed value and reconstructs the render', async () => {
  const rowIr = await row()
  const rootIr = await seal(
    draftTemplate({
      id: 'root',
      segments: ['<ul>', '</ul>'],
      holes: [hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: rowIr.version })],
    }),
  )
  const resolve = (v: string) => (v === rowIr.version ? rowIr : undefined)
  const before: Values = { rows: [{ name: 'Dates', qty: 2 }, { name: 'Sumac', qty: 1 }] }
  const after: Values = { rows: [{ name: 'Dates', qty: 3 }, { name: 'Sumac', qty: 1 }] }

  const delta = deltaPayload(rootIr, baseRenderId(rootIr, before), before, after)
  assert.deepEqual(Object.keys(delta.changed), ['rows[0].qty'])
  assert.deepEqual([...render(rootIr, applyDelta(before, delta), resolve)], [...render(rootIr, after, resolve)])
})

test('a list whose length changes is structural and travels whole', async () => {
  const rowIr = await row()
  const rootIr = await seal(
    draftTemplate({
      id: 'root',
      segments: ['<ul>', '</ul>'],
      holes: [hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: rowIr.version })],
    }),
  )
  const before: Values = { rows: [{ name: 'a', qty: 1 }] }
  const after: Values = { rows: [{ name: 'a', qty: 1 }, { name: 'b', qty: 1 }] }
  const delta = deltaPayload(rootIr, 'base', before, after)
  assert.deepEqual(Object.keys(delta.changed), ['rows'])
})

test('serialization round-trips and preserves fields a newer minor added', async () => {
  const ir = await seal(draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] }))
  const withFuture = JSON.parse(stringify(ir)) as Record<string, unknown>
  withFuture.irVersion = '1.3.0'
  withFuture.budget = { js: 8192 }

  const parsed = parse(JSON.stringify(withFuture))
  assert.equal(parsed.mode, 'forward')
  assert.deepEqual(parsed.forward, { budget: { js: 8192 } })
  assert.equal(parsed.ir.version, ir.version)

  const reemitted = JSON.parse(stringify(parsed.ir, parsed.forward)) as Record<string, unknown>
  assert.deepEqual(reemitted.budget, { js: 8192 })
})

test('a nested template version must be a sealed hash', () => {
  const ir = draftTemplate({
    id: 't',
    segments: ['<ul>', '</ul>'],
    holes: [hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: 'row-template' })],
  })
  assert.equal(validateTemplate(ir).errors[0]?.code, 'E_NESTED_SHAPE')
})
