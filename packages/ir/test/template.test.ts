import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyDelta,
  baseRenderId,
  byteLength,
  deltaPayload,
  draftTemplate,
  parse,
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

test('a slot hole makes the delta form unprovable', () => {
  const ir = draftTemplate({
    id: 't',
    segments: ['<div>', '</div>'],
    holes: [hole(0, 'children', { kind: 'slot' })],
  })
  assert.deepEqual(ir.forms, ['html', 'bundle', 'split', 'patch'])
  const lying = { ...ir, forms: [...ir.forms, 'delta' as const] }
  assert.equal(validateTemplate(lying).errors[0]?.code, 'E_FORM_UNPROVABLE')
})

test('html is always offered because it needs nothing resident', () => {
  const ir = draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] })
  assert.equal(
    validateTemplate({ ...ir, forms: ['delta'] }).errors.some((e) => e.code === 'E_FORM_FLOOR'),
    true,
  )
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
  assert.equal(
    validateTemplate(ir).errors.some((e) => e.code === 'E_WIRING_INTENT'),
    true,
  )
})

test('the content address addresses the content', async () => {
  const ir = await seal(draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] }))
  assert.match(ir.version, /^[0-9a-f]{32}$/)
  assert.equal((await verifySealed(ir)).ok, true)

  const tampered: TemplateIR = {
    ...ir,
    segments: [new TextEncoder().encode('<div>'), ir.segments[1] as Uint8Array],
  }
  const result = await verifySealed(tampered)
  assert.equal(result.ok, false)
  assert.equal(
    result.errors.some((e) => e.code === 'E_VERSION_MISMATCH'),
    true,
  )
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

test('values projected through a resident template give the same bytes as html', async () => {
  const rowIr = await row()
  const rootIr = await seal(
    draftTemplate({
      id: 'root',
      segments: ['<ul>', '</ul>'],
      holes: [
        hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: rowIr.version }),
      ],
    }),
  )
  const resolve = (v: string) => (v === rowIr.version ? rowIr : undefined)
  const values: Values = {
    rows: [
      { name: 'Dates & nuts', qty: 2 },
      { name: 'Sumac', qty: 1 },
    ],
  }

  const html = render(rootIr, values, resolve)
  const projected = render(rootIr, values, resolve)
  assert.deepEqual([...projected], [...html])
  assert.equal(decode(html), '<ul><li>Dates &amp; nuts x2</li><li>Sumac x1</li></ul>')
})

test('a delta names one path per changed value and reconstructs the render', async () => {
  const rowIr = await row()
  const rootIr = await seal(
    draftTemplate({
      id: 'root',
      segments: ['<ul>', '</ul>'],
      holes: [
        hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: rowIr.version }),
      ],
    }),
  )
  const resolve = (v: string) => (v === rowIr.version ? rowIr : undefined)
  const before: Values = {
    rows: [
      { name: 'Dates', qty: 2 },
      { name: 'Sumac', qty: 1 },
    ],
  }
  const after: Values = {
    rows: [
      { name: 'Dates', qty: 3 },
      { name: 'Sumac', qty: 1 },
    ],
  }

  const delta = deltaPayload(rootIr, baseRenderId(rootIr, before), before, after)
  assert.deepEqual(Object.keys(delta.changed), ['rows[0].qty'])
  assert.deepEqual(
    [...render(rootIr, applyDelta(before, delta), resolve)],
    [...render(rootIr, after, resolve)],
  )
})

test('a list whose length changes is structural and travels whole', async () => {
  const rowIr = await row()
  const rootIr = await seal(
    draftTemplate({
      id: 'root',
      segments: ['<ul>', '</ul>'],
      holes: [
        hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: rowIr.version }),
      ],
    }),
  )
  const before: Values = { rows: [{ name: 'a', qty: 1 }] }
  const after: Values = {
    rows: [
      { name: 'a', qty: 1 },
      { name: 'b', qty: 1 },
    ],
  }
  const delta = deltaPayload(rootIr, 'base', before, after)
  assert.deepEqual(Object.keys(delta.changed), ['rows'])
})

test('serialization round-trips and preserves fields a newer minor added', async () => {
  const ir = await seal(draftTemplate({ id: 't', segments: ['<p>', '</p>'], holes: [hole(0, 'a')] }))
  const withFuture = JSON.parse(stringify(ir)) as Record<string, unknown>
  withFuture.irVersion = '2.4.0'
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
    holes: [
      hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', provenance: 'row', nested: 'row-template' }),
    ],
  })
  assert.equal(validateTemplate(ir).errors[0]?.code, 'E_NESTED_SHAPE')
})

test('a derived value is resolved at render, not carried by the caller', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'derived',
      segments: ['<p>', '</p>'],
      holes: [hole(0, 'd0')],
      derived: [{ id: 'd0', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'a' }, b: { k: 'lit', v: 3 } } }],
    }),
  )
  assert.equal(decode(render(ir, { a: 7 })), '<p>21</p>')
  assert.equal(decode(render(ir, { a: 2 })), '<p>6</p>')
})

test('a stale derived value in the caller value set is recomputed, not trusted', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'stale',
      segments: ['<p>', '</p>'],
      holes: [hole(0, 'd0')],
      derived: [{ id: 'd0', expr: { k: 'bin', op: '+', a: { k: 'ref', id: 'a' }, b: { k: 'lit', v: 1 } } }],
    }),
  )
  assert.equal(decode(render(ir, { a: 1, d0: 999 })), '<p>2</p>')
})

test('a delta carries a server-owned derived value and never a client-owned one', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'split',
      segments: ['<p>', '', '</p>'],
      holes: [hole(0, 'd0'), hole(1, 'd1')],
      signals: [{ id: 'n', type: 'number', init: 1 }],
      derived: [
        { id: 'd0', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'a' }, b: { k: 'lit', v: 2 } } },
        { id: 'd1', expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'n' }, b: { k: 'lit', v: 2 } } },
      ],
    }),
  )
  const delta = deltaPayload(ir, 'base', { a: 1, n: 1 }, { a: 5, n: 9 })
  assert.equal(delta.changed.d0, 10, 'a is the server’s, so its derived value ships')
  assert.equal('d1' in delta.changed, false, 'n is the client’s, and so is what it derives')
})

test('a derived table that reads forward would never settle, so it is refused', () => {
  const ir = draftTemplate({
    id: 'cycle',
    segments: ['<p>', '</p>'],
    holes: [hole(0, 'd0')],
    derived: [
      { id: 'd0', expr: { k: 'ref', id: 'd1' } },
      { id: 'd1', expr: { k: 'lit', v: 1 } },
    ],
  })
  const result = validateTemplate(ir)
  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.code, 'E_DERIVED_FORWARD_READ')
})

test('an operator outside the closed set is refused rather than evaluated', () => {
  const ir = draftTemplate({
    id: 'open',
    segments: ['<p>', '</p>'],
    holes: [hole(0, 'd0')],
    derived: [
      { id: 'd0', expr: { k: 'bin', op: '>>>' as never, a: { k: 'lit', v: 1 }, b: { k: 'lit', v: 1 } } },
    ],
  })
  const result = validateTemplate(ir)
  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.code, 'E_DERIVED_EXPR')
})

test('the derived table survives the JSON round trip and is part of the version', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'round',
      segments: ['<p>', '</p>'],
      holes: [hole(0, 'd0')],
      derived: [{ id: 'd0', expr: { k: 'un', op: '-', a: { k: 'ref', id: 'a' } } }],
    }),
  )
  const back = parse(stringify(ir)).ir
  assert.deepEqual(back.derived, ir.derived)
  assert.equal((await verifySealed(back)).ok, true)

  const other = await seal({ ...ir, derived: [{ id: 'd0', expr: { k: 'ref', id: 'a' } }], version: '' })
  assert.notEqual(other.version, ir.version, 'changing the expression must move the version')
})

test('a delta carries nothing the client has no hole to write into', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'unaddressable',
      segments: ['<p>', '</p>'],
      holes: [hole(0, 'd0')],
      derived: [
        { id: 'd0', expr: { k: 'bin', op: '/', a: { k: 'ref', id: 'price' }, b: { k: 'lit', v: 100 } } },
      ],
    }),
  )
  const delta = deltaPayload(ir, 'base', { price: 100 }, { price: 250 })
  assert.deepEqual(Object.keys(delta.changed), ['d0'], 'price itself has no hole')
  assert.equal(delta.changed.d0, 2.5)
})

async function badge(): Promise<TemplateIR> {
  return seal(
    draftTemplate({
      id: 'badge',
      segments: ['<span class="', '">', '</span>'],
      holes: [
        { index: 0, kind: 'attr', escape: 'escape', binding: 'tone', path: [0], attr: 'class' },
        hole(1, 'label', { path: [0] }),
      ],
    }),
  )
}

test('a component hole renders a child template through a projection of the parent values', async () => {
  const child = await badge()
  const parent = await seal(
    draftTemplate({
      id: 'parent',
      segments: ['<p>', '</p>'],
      holes: [
        {
          index: 0,
          kind: 'component',
          escape: 'trusted-raw',
          binding: 'c0',
          path: [0, 0],
          nested: child.version,
          props: { tone: 't', label: 'l' },
          provenance: 'badge',
        },
      ],
    }),
  )
  const resolve = (v: string) => (v === child.version ? child : undefined)
  const html = decode(render(parent, { t: 'warn', l: 'new' }, resolve))
  assert.equal(html, '<p><span class="warn">new</span></p>')
  assert.equal(byteLength(parent, { t: 'warn', l: 'new' }, resolve), html.length)
})

test('a delta reaches inside an instance, addressed by name rather than by index', async () => {
  const child = await badge()
  const parent = await seal(
    draftTemplate({
      id: 'parent',
      segments: ['<p>', '</p>'],
      holes: [
        {
          index: 0,
          kind: 'component',
          escape: 'trusted-raw',
          binding: 'c0',
          path: [0, 0],
          nested: child.version,
          props: { tone: 't', label: 'l' },
          provenance: 'badge',
        },
      ],
    }),
  )
  const resolve = (v: string) => (v === child.version ? child : undefined)
  const delta = deltaPayload(parent, 'base', { t: 'warn', l: 'a' }, { t: 'warn', l: 'b' }, resolve)
  assert.deepEqual(delta.changed, { 'c0.label': 'b' }, 'only the prop that moved, under the instance')
})

test('a delta over a template with instances refuses to guess when it cannot resolve one', async () => {
  const child = await badge()
  const parent = await seal(
    draftTemplate({
      id: 'parent',
      segments: ['<p>', '</p>'],
      holes: [
        {
          index: 0,
          kind: 'component',
          escape: 'trusted-raw',
          binding: 'c0',
          path: [0, 0],
          nested: child.version,
          props: { tone: 't', label: 'l' },
          provenance: 'badge',
        },
      ],
    }),
  )
  assert.throws(() => deltaPayload(parent, 'base', { l: 'a' }, { l: 'b' }), /E_NESTED_UNRESOLVED/)
})

test('a component hole must name both the template it renders and what it passes', () => {
  const missing = validateTemplate(
    draftTemplate({
      id: 'x',
      segments: ['<p>', '</p>'],
      holes: [
        { index: 0, kind: 'component', escape: 'trusted-raw', binding: 'c0', path: [0], provenance: 'y' },
      ],
    }),
  )
  assert.equal(missing.ok, false)
  assert.deepEqual(missing.errors.map((e) => e.code).sort(), ['E_COMPONENT_NESTED', 'E_COMPONENT_PROPS'])

  const wrongKind = validateTemplate(
    draftTemplate({
      id: 'x',
      segments: ['<p>', '</p>'],
      holes: [hole(0, 'a', { props: { p: 'a' } })],
    }),
  )
  assert.equal(wrongKind.errors[0]?.code, 'E_PROPS_KIND')
})
