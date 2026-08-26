import assert from 'node:assert/strict'
import { test } from 'node:test'
import { derivableForms, draftTemplate, seal, type Hole, type TemplateIR } from '../src/index.ts'
import { patchPayload } from '../src/patch.ts'
import { render } from '../src/render.ts'

const decoder = new TextDecoder()

function hole(index: number, binding: string, over: Partial<Hole> = {}): Hole {
  return { index, kind: 'text', escape: 'escape', binding, path: [0], ...over }
}

test('a patch carries the text a hole produced, unescaped, addressed by its marker', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'row',
      segments: ['<p><!>', ' of ', '</p>'],
      holes: [hole(0, 'qty', { anchor: 0, path: [] }), hole(1, 'total', { anchor: 1, path: [] })],
    }),
  )

  const patch = patchPayload(ir, 'base', { qty: 1, total: '3 & 4' }, { qty: 2, total: '3 & 4' })
  assert.equal(patch.form, 'patch')
  assert.deepEqual(patch.writes, [{ path: [], op: 'text', anchor: 0, value: '2' }])
})

test('a value that only differs in escaping is not a change', async () => {
  const ir = await seal(
    draftTemplate({ id: 'p', segments: ['<p>', '</p>'], holes: [hole(0, 'a', { path: [] })] }),
  )
  assert.deepEqual(patchPayload(ir, 'base', { a: '<b>' }, { a: '<b>' }).writes, [])
})

test('an attribute is written raw, because setAttribute does the escaping', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'a',
      segments: ['<a href="', '">x</a>'],
      holes: [hole(0, 'href', { kind: 'attr', attr: 'href', path: [] })],
    }),
  )
  const patch = patchPayload(ir, 'b', { href: '/a?x=1&y=2' }, { href: '/b?x=1&y=2' })
  assert.deepEqual(patch.writes, [{ path: [], op: 'attr', attr: 'href', value: '/b?x=1&y=2' }])
})

test('a boolean that goes false is a write with no value, which is a removal', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'input',
      segments: ['<input ', '>'],
      holes: [hole(0, 'on', { kind: 'attr-bool', attr: 'disabled', path: [] })],
    }),
  )
  assert.deepEqual(patchPayload(ir, 'b', { on: true }, { on: false }).writes, [
    { path: [], op: 'bool', attr: 'disabled' },
  ])
  assert.deepEqual(patchPayload(ir, 'b', { on: false }, { on: true }).writes, [
    { path: [], op: 'bool', attr: 'disabled', value: '' },
  ])
  assert.deepEqual(patchPayload(ir, 'b', { on: true }, { on: 'yes' }).writes, [])
})

test('a list changes row by row, because a patch bigger than its region is not a patch', async () => {
  const row = await seal(
    draftTemplate({ id: 'row', segments: ['<li>', '</li>'], holes: [hole(0, 'label', { path: [0] })] }),
  )
  const ir = await seal(
    draftTemplate({
      id: 'list',
      segments: ['<ul>', '</ul>'],
      holes: [hole(0, 'rows', { kind: 'list', escape: 'trusted-raw', path: [], nested: row.version })],
    }),
  )
  const resolve = (v: string): TemplateIR | undefined => (v === row.version ? row : undefined)

  // A row appended: the row that did not change is not sent.
  const grown = patchPayload(
    ir,
    'b',
    { rows: [{ label: 'a' }] },
    { rows: [{ label: 'a' }, { label: 'b' }] },
    resolve,
  )
  assert.deepEqual(grown.writes, [{ path: [], op: 'append', value: '<li>b</li>' }])
  // The host's own path is opaque, so a client with no template counts markers the way
  // adoption does.
  assert.deepEqual(grown.opaque, [[]])

  // One row edited among three: one write, addressed at that row.
  const edited = patchPayload(
    ir,
    'b',
    { rows: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { rows: [{ label: 'a' }, { label: 'B' }, { label: 'c' }] },
    resolve,
  )
  assert.deepEqual(edited.writes, [{ path: [1], op: 'replace', value: '<li>B</li>' }])

  // Rows removed: a count, because what goes is always the tail.
  const shrunk = patchPayload(
    ir,
    'b',
    { rows: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { rows: [{ label: 'a' }] },
    resolve,
  )
  assert.deepEqual(shrunk.writes, [{ path: [], op: 'truncate', value: '1' }])

  // Edited and shortened at once: the edit is addressed before the tail is dropped.
  const both = patchPayload(
    ir,
    'b',
    { rows: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    { rows: [{ label: 'A' }] },
    resolve,
  )
  assert.deepEqual(both.writes, [
    { path: [0], op: 'replace', value: '<li>A</li>' },
    { path: [], op: 'truncate', value: '1' },
  ])
})

test('a list of plain values has no rows to address, so its host is the boundary', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'tags',
      segments: ['<p>', '</p>'],
      holes: [hole(0, 'tags', { kind: 'list', escape: 'escape', path: [] })],
    }),
  )
  const patch = patchPayload(ir, 'b', { tags: ['a', 'b'] }, { tags: ['a', 'c'] })
  assert.deepEqual(patch.writes, [{ path: [], op: 'markup', value: 'ac' }])
})

test('a slot is never addressed, because those bytes are not this render’s', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'shell',
      segments: ['<div>', '', '</div>'],
      holes: [
        hole(0, 'title', { path: [] }),
        hole(1, 'main', { kind: 'slot', escape: 'proven-safe', path: [] }),
      ],
    }),
  )
  const patch = patchPayload(ir, 'b', { title: 'a', main: 'x' }, { title: 'b', main: 'y' })
  assert.deepEqual(patch.writes, [{ path: [], op: 'text', value: 'b' }])
})

test('a shell with a slot can serve patch, and cannot serve delta', () => {
  const holes = [
    hole(0, 'title', { path: [] }),
    hole(1, 'main', { index: 1, kind: 'slot', escape: 'proven-safe', path: [] }),
  ]
  const forms = derivableForms(holes)
  assert.ok(forms.includes('patch'))
  assert.ok(!forms.includes('delta'))
})

test('a raw value with no boundary cannot serve patch, and one that is sole can', () => {
  const anchored = [hole(0, 'body', { escape: 'trusted-raw', anchor: 0, path: [] })]
  const sole = [hole(0, 'body', { escape: 'trusted-raw', path: [] })]
  assert.ok(!derivableForms(anchored).includes('patch'))
  assert.ok(derivableForms(sole).includes('patch'))
  assert.ok(!derivableForms(sole).includes('delta'))
})

test('a raw value that is its element’s whole content is replaced as markup', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'note',
      segments: ['<div>', '</div>'],
      holes: [hole(0, 'body', { escape: 'trusted-raw', path: [] })],
    }),
  )
  const patch = patchPayload(ir, 'b', { body: '<em>a</em>' }, { body: '<em>b</em>' })
  assert.deepEqual(patch.writes, [{ path: [], op: 'markup', value: '<em>b</em>' }])
})

test('a template that declared patch it cannot serve is refused where it is declared', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'note',
      segments: ['<div>x<!>', '</div>'],
      holes: [hole(0, 'body', { escape: 'trusted-raw', anchor: 0, path: [], provenance: 'note' })],
      forms: ['html', 'bundle', 'split', 'patch'],
    }),
  )
  const { validateTemplate } = await import('../src/validate.ts')
  assert.deepEqual(
    validateTemplate(ir).errors.map((e) => e.code),
    ['E_FORM_UNPROVABLE'],
  )
  // And if one reaches the encoder anyway — an older document, restamped — it is named
  // rather than dropped.
  assert.throws(
    () => patchPayload(ir, 'b', { body: '<em>a</em>' }, { body: '<em>b</em>' }),
    /E_PATCH_UNADDRESSABLE/,
  )
})

test('a component instance is replaced whole, because it renders one root element', async () => {
  const child = await seal(
    draftTemplate({
      id: 'badge',
      segments: ['<span>', '</span>'],
      holes: [hole(0, 'tone', { path: [0] })],
    }),
  )
  const ir = await seal(
    draftTemplate({
      id: 'card',
      segments: ['<div>', '</div>'],
      holes: [
        hole(0, 'badge', {
          kind: 'component',
          escape: 'trusted-raw',
          path: [0],
          nested: child.version,
          props: { tone: 'level' },
        }),
      ],
    }),
  )
  const resolve = (v: string): TemplateIR | undefined => (v === child.version ? child : undefined)
  const patch = patchPayload(ir, 'b', { level: 'warn' }, { level: 'ok' }, resolve)
  assert.deepEqual(patch.writes, [{ path: [0], op: 'replace', value: '<span>ok</span>' }])
})

test('the markup a patch carries is the markup a fresh render would have produced', async () => {
  const ir = await seal(
    draftTemplate({
      id: 'p',
      segments: ['<p><!>', '</p>'],
      holes: [hole(0, 'a', { anchor: 0, path: [] })],
    }),
  )
  const next = { a: 'after' }
  const patch = patchPayload(ir, 'b', { a: 'before' }, next)
  const fresh = decoder.decode(render(ir, next))
  assert.ok(fresh.includes(patch.writes[0]?.value as string))
})
