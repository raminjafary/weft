import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { render, verifySealed, type TemplateIR, type Values } from '../../ir/src/index.ts'
import { compileFile, compileSource } from '../src/compile.ts'
import { CompileError } from '../src/errors.ts'
import { intentId } from '../src/intents.ts'

const decode = (b: Uint8Array) => new TextDecoder().decode(b)
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))

async function compile(source: string) {
  return compileSource(source, 'test.tsx')
}

const PRELUDE = "import { fragment, signal, raw } from 'weft'\nimport { save } from './intents.ts'\n"

async function only(source: string): Promise<TemplateIR> {
  const out = await compile(PRELUDE + source)
  const fragment = out.fragments[0]
  assert.ok(fragment, 'no fragment compiled')
  return fragment.entry
}

async function rejects(source: string, code: string): Promise<void> {
  await assert.rejects(
    () => compile(PRELUDE + source),
    (error: unknown) => {
      assert.ok(error instanceof CompileError, `expected a CompileError, got ${String(error)}`)
      assert.equal(error.code, code, error.message)
      return true
    },
  )
}

test('a template compiles to interleaved segments and holes', async () => {
  const ir = await only('export default fragment(({ name }) => <p class="a">{name}</p>)')
  assert.equal(ir.segments.length, ir.holes.length + 1)
  assert.equal(decode(ir.segments[0] as Uint8Array), '<p class="a">')
  assert.equal(decode(ir.segments[1] as Uint8Array), '</p>')
  assert.deepEqual(ir.holes[0]?.kind, 'text')
  assert.equal((await verifySealed(ir)).ok, true)
})

test('static attributes stay in the segment and dynamic ones become holes', async () => {
  const ir = await only('export default fragment(({ id }) => <p class="a" data-id={id}>x</p>)')
  assert.equal(decode(ir.segments[0] as Uint8Array), '<p class="a" data-id="')
  assert.equal(decode(ir.segments[1] as Uint8Array), '">x</p>')
  assert.equal(ir.holes[0]?.attr, 'data-id')
})

test('a boolean attribute lowers to presence rather than a value', async () => {
  const ir = await only('export default fragment(({ off }) => <button disabled={off}>go</button>)')
  assert.equal(ir.holes[0]?.kind, 'attr-bool')
  assert.equal(ir.holes[0]?.attr, 'disabled')
  assert.equal(decode(render(ir, { off: true })), '<button disabled>go</button>')
  assert.equal(decode(render(ir, { off: false })), '<button >go</button>')
})

test('void elements emit no closing tag and reject children', async () => {
  const ir = await only('export default fragment(({ src }) => <p><img src={src} /></p>)')
  assert.equal(decode(render(ir, { src: '/a.png' })), '<p><img src="/a.png"></p>')
  await rejects('export default fragment(() => <p><br>x</br></p>)', 'E_VOID_CHILDREN')
})

test('escaping is elided only where the syntax proves it safe', async () => {
  const unknown = await only('export default fragment(({ v }) => <p>{v}</p>)')
  assert.equal(unknown.holes[0]?.escape, 'escape')

  const arithmetic = await only('export default fragment(({ a }) => <p>{a * 2}</p>)')
  assert.equal(arithmetic.holes[0]?.escape, 'proven-safe')

  const signals = await only('export default fragment(() => { const n = signal(1); return <p>{n()}</p> })')
  assert.equal(signals.holes[0]?.escape, 'proven-safe')

  const vouched = await only("export default fragment(({ v }) => <p>{raw(v)}</p>)")
  assert.equal(vouched.holes[0]?.escape, 'trusted-raw')
  assert.equal(vouched.holes[0]?.provenance, 'v')
})

test('a constant folds into the segment instead of becoming a hole', async () => {
  const ir = await only("export default fragment(() => <p>{'and & then'}</p>)")
  assert.equal(ir.holes.length, 0)
  assert.equal(decode(ir.segments[0] as Uint8Array), '<p>and &amp; then</p>')

  const rawConstant = await only("export default fragment(() => <p>{raw('<b>bold</b>')}</p>)")
  assert.equal(rawConstant.holes.length, 0)
  assert.equal(decode(rawConstant.segments[0] as Uint8Array), '<p><b>bold</b></p>')
})

test('a dynamic text with siblings gets a marker so the text node is addressable', async () => {
  const ir = await only('export default fragment(() => { const n = signal(1); return <p>Total: {n()} IQD</p> })')
  assert.equal(decode(ir.segments[0] as Uint8Array), '<p>Total: <!>')
  assert.equal(decode(ir.segments[1] as Uint8Array), '<!> IQD</p>')
  assert.equal(ir.meta?.markers, 2)
  assert.equal(ir.wiring[0]?.anchor, 0)
})

test('a dynamic text that is an only child needs no marker', async () => {
  const ir = await only('export default fragment(() => { const n = signal(1); return <p>{n()}</p> })')
  assert.equal(decode(ir.segments[0] as Uint8Array), '<p>')
  assert.equal(ir.meta?.markers, 0)
  assert.equal(ir.wiring[0]?.anchor, undefined)
})

test('paths index element children from the container, so a text value cannot shift them', async () => {
  const ir = await only('export default fragment(({ a, b }) => <div>{a}<span><i>{b}</i></span></div>)')
  // container -> div [0] -> span [0,0] -> i [0,0,0]
  assert.deepEqual(ir.holes.find((h) => h.binding === 'b')?.path, [0, 0, 0])
  assert.deepEqual(ir.holes.find((h) => h.binding === 'a')?.path, [0])
})

test('a single root element and a fragment root address alike', async () => {
  const single = await only('export default fragment(({ a }) => <p>{a}</p>)')
  const fragment = await only('export default fragment(({ a }) => <><p>{a}</p></>)')
  assert.deepEqual(single.holes[0]?.path, [0])
  assert.deepEqual(fragment.holes[0]?.path, [0])
  assert.equal(single.version, fragment.version)
})

test('a text child of a fragment root is owned by the container itself', async () => {
  const ir = await only('export default fragment(({ a }) => <>{a}<p>x</p></>)')
  assert.deepEqual(ir.holes[0]?.path, [])
})

test('a handler compiles to an intent id, never to server code', async () => {
  const ir = await only('export default fragment(() => <form onSubmit={save}>x</form>)')
  const event = ir.wiring[0]
  assert.equal(event?.op, 'event')
  assert.equal(event?.event, 'submit')
  assert.equal(event?.intent, intentId('./intents.ts', 'save'))
  assert.equal(event?.binding, '')
  await rejects('export default fragment(() => <form onSubmit={() => 1}>x</form>)', 'E_HANDLER_NOT_AN_INTENT')
  await rejects('export default fragment(() => <form onSubmit={local}>x</form>)', 'E_HANDLER_NOT_IMPORTED')
})

test('a list becomes a nested template the parent names by version', async () => {
  const out = await compile(
    `${PRELUDE}export default fragment(({ rows }) => <ul>{rows.map((row) => <li>{row.name}</li>)}</ul>)`,
  )
  const fragment = out.fragments[0]
  assert.ok(fragment)
  assert.equal(fragment.templates.length, 2)
  const row = fragment.templates[0] as TemplateIR
  const root = fragment.entry
  assert.equal(root.holes[0]?.kind, 'list')
  assert.equal(root.holes[0]?.nested, row.version)

  const values: Values = { rows: [{ name: 'Dates & nuts' }, { name: 'Sumac' }] }
  const resolve = (v: string) => (v === row.version ? row : undefined)
  assert.equal(decode(render(root, values, resolve)), '<ul><li>Dates &amp; nuts</li><li>Sumac</li></ul>')
})

test('a list must be the only child of its element', async () => {
  await rejects(
    'export default fragment(({ rows }) => <ul>head{rows.map((row) => <li>{row.name}</li>)}</ul>)',
    'E_LIST_NOT_SOLE_CHILD',
  )
})

test('a row cannot close over the outer scope', async () => {
  await rejects(
    'export default fragment(({ rows }) => { const n = signal(1); return <ul>{rows.map((row) => <li>{n()}</li>)}</ul> })',
    'E_SIGNAL_IN_LIST',
  )
  await rejects(
    'export default fragment(({ rows, total }) => <ul>{rows.map((row) => <li>{total}</li>)}</ul>)',
    'E_OUT_OF_ROW_SCOPE',
  )
})

test('the compiler refuses what it cannot lower instead of guessing', async () => {
  await rejects('export default fragment(({ x }) => <Widget a={x} />)', 'E_COMPONENT_UNSUPPORTED')
  await rejects('export default fragment((p) => <p {...p}>x</p>)', 'E_SPREAD_UNSUPPORTED')
  await rejects('export default fragment(({ o }) => <p>{o["k"]}</p>)', 'E_COMPUTED_MEMBER')
  await rejects('export default fragment(() => <p>{missing}</p>)', 'E_UNKNOWN_BINDING')
  await rejects('export default fragment(() => { const n = signal(1); return <p>{n}</p> })', 'E_SIGNAL_NOT_READ')
  await rejects('export default fragment(() => { const n = signal(1); return <p>{n() * 2}</p> })', 'E_DERIVED_SIGNAL_UNSUPPORTED')
})

test('a slot hole renders nothing and costs the data and delta forms', async () => {
  const ir = await compileFile(fixture('shell.tsx'))
  const entry = ir.fragments[0]?.entry as TemplateIR
  const slots = entry.holes.filter((h) => h.kind === 'slot')
  assert.equal(slots.length, 2)
  assert.deepEqual(entry.forms, ['html', 'bundle', 'split', 'patch'])
  const html = decode(render(entry, { title: 'x', cartLines: 'ignored', recs: 'ignored', footer: 'f' }))
  assert.equal(html.includes('ignored'), false)
  assert.equal(html.startsWith('<!doctype html><html lang="en">'), true)
})

test('the fixtures used by the benchmark all compile and seal', async () => {
  for (const file of ['shell.tsx', 'lines.tsx', 'quantity.tsx']) {
    const out = await compileFile(fixture(file))
    assert.ok(out.fragments.length, `${file} produced no fragment`)
    for (const template of out.fragments[0]?.templates ?? []) {
      assert.equal((await verifySealed(template)).ok, true, `${file}: ${template.id} does not verify`)
    }
  }
})

test('the same source compiles to the same version, and a change moves it', async () => {
  const a = await only('export default fragment(({ v }) => <p>{v}</p>)')
  const b = await only('export default fragment(({ v }) => <p>{v}</p>)')
  const c = await only('export default fragment(({ v }) => <p class="x">{v}</p>)')
  assert.equal(a.version, b.version)
  assert.notEqual(a.version, c.version)
})

test('a template id is repository-relative, so a version does not depend on the checkout path', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const absolute = await compileFile(fixture('lines.tsx'), { root })
  const viaRelative = await compileFile('packages/compiler/fixtures/lines.tsx', { root })

  const id = absolute.fragments[0]?.entry.id as string
  assert.equal(id, 'packages/compiler/fixtures/lines.tsx#default')
  assert.equal(id.includes('/Users/'), false)
  assert.equal(absolute.fragments[0]?.entry.version, viaRelative.fragments[0]?.entry.version)
})
