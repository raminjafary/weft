import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  applyDelta,
  baseRenderId,
  cacheClassOf,
  createSegmentMemo,
  deltaPayload,
  render,
  renderIncremental,
  verifySealed,
  type TemplateIR,
  type Values,
} from '@weft/ir'
import { compileFile, compileFiles, compileSource, type CompiledFragment } from '../src/compile.ts'
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

function versions(templates: TemplateIR[]) {
  const byVersion = new Map(templates.map((t) => [t.version, t]))
  return (version: string) => byVersion.get(version)
}

/** The intent id the first fragment's first wiring entry names. */
function firstIntent(out: { fragments: CompiledFragment[] }): string | undefined {
  return out.fragments[0]?.entry.wiring[0]?.intent
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

  const vouched = await only('export default fragment(({ v }) => <p>{raw(v)}</p>)')
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
  const ir = await only(
    'export default fragment(() => { const n = signal(1); return <p>Total: {n()} IQD</p> })',
  )
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
  // The id names where the intent lives, not where the importer is standing: `./intents.ts` from
  // `test.tsx` is the module `intents.ts`.
  assert.equal(event?.intent, intentId('intents.ts', 'save'))
  assert.equal(event?.binding, '')
  await rejects('export default fragment(() => <form onSubmit={() => 1}>x</form>)', 'E_HANDLER_NOT_AN_INTENT')
  await rejects('export default fragment(() => <form onSubmit={local}>x</form>)', 'E_HANDLER_NOT_IMPORTED')
})

/**
 * One intent, one id, however deep the importer is.
 *
 * A relative specifier describes the importer's position, so hashing it gave two fragments at
 * two depths two ids for one export — and a build's manifest, which knows only where the intent
 * lives, could match neither. This is the property that was broken.
 */
test('an intent id does not depend on where it was imported from', async () => {
  const shallow = await compileSource(
    "import { fragment } from 'weft'\nimport { save } from './lib/intents.ts'\n" +
      'export default fragment(() => <form onSubmit={save}>x</form>)',
    'app/page.tsx',
  )
  const deep = await compileSource(
    "import { fragment } from 'weft'\nimport { save } from '../lib/intents.ts'\n" +
      'export default fragment(() => <form onSubmit={save}>x</form>)',
    'app/nested/page.tsx',
  )
  assert.equal(firstIntent(shallow), intentId('app/lib/intents.ts', 'save'))
  assert.equal(firstIntent(deep), firstIntent(shallow))
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
  await rejects('export default fragment(({ x }) => <Widget a={x} />)', 'E_COMPONENT_UNRESOLVED')
  await rejects('export default fragment((p) => <p {...p}>x</p>)', 'E_SPREAD_UNSUPPORTED')
  await rejects('export default fragment(({ o }) => <p>{o["k"]}</p>)', 'E_COMPUTED_MEMBER')
  await rejects('export default fragment(() => <p>{missing}</p>)', 'E_UNKNOWN_BINDING')
  await rejects(
    'export default fragment(() => { const n = signal(1); return <p>{n}</p> })',
    'E_SIGNAL_NOT_READ',
  )
})

test('a derived value is encoded as an expression, not compiled to code', async () => {
  const ir = await only('export default fragment(({ a }) => <p>{a * 2}</p>)')
  assert.equal(ir.derived.length, 1)
  assert.deepEqual(ir.derived[0], {
    id: 'd0',
    expr: { k: 'bin', op: '*', a: { k: 'ref', id: 'a' }, b: { k: 'lit', v: 2 } },
  })
  assert.equal(ir.holes[0]?.binding, 'd0')
  assert.equal(decode(render(ir, { a: 21 })), '<p>42</p>')
})

test('a derived value over a signal is wired, one over a prop is not', async () => {
  const reactive = await only(
    'export default fragment(() => { const n = signal(1); return <p>{n() * 2}</p> })',
  )
  assert.equal(reactive.wiring.length, 1)
  assert.equal(reactive.wiring[0]?.binding, 'd0')
  assert.equal(reactive.wiring[0]?.op, 'text')
  assert.equal(decode(render(reactive, { n: 3 })), '<p>6</p>')

  const fixed = await only('export default fragment(({ a }) => <p>{a * 2}</p>)')
  assert.deepEqual(fixed.wiring, [])
})

test('a derived value nests, and reads more than one binding', async () => {
  const ir = await only('export default fragment(({ a, b }) => <p>{(a + b) * 2}</p>)')
  assert.equal(ir.derived.length, 1)
  assert.equal(decode(render(ir, { a: 2, b: 3 })), '<p>10</p>')
})

test('a derived value in an attribute is wired like any other', async () => {
  const ir = await only(
    'export default fragment(() => { const n = signal(1); return <p data-n={n() + 1}>x</p> })',
  )
  assert.equal(ir.wiring[0]?.op, 'attr')
  assert.equal(ir.wiring[0]?.attr, 'data-n')
  assert.equal(decode(render(ir, { n: 4 })), '<p data-n="5">x</p>')
})

test('a comparison is proven safe; a concatenation is not', async () => {
  const compared = await only('export default fragment(({ a }) => <p>{a > 2}</p>)')
  assert.equal(compared.holes[0]?.escape, 'proven-safe')
  assert.equal(decode(render(compared, { a: 3 })), '<p>true</p>')

  const joined = await only('export default fragment(({ a }) => <p>{a + "!"}</p>)')
  assert.equal(joined.holes[0]?.escape, 'escape')
  assert.equal(decode(render(joined, { a: '<b>' })), '<p>&lt;b&gt;!</p>')
})

test('a signal read inside a derived value still cannot cross into a list row', async () => {
  await rejects(
    'export default fragment(({ rows }) => { const n = signal(1); return <ul>{rows.map((r) => <li>{r.qty * n()}</li>)}</ul> })',
    'E_SIGNAL_IN_LIST',
  )
})

const BADGE = 'const Badge = fragment(({ tone, label }) => <span class={tone}>{label}</span>)\n'

test('a component is a nested template plus a projection, never an inlined copy', async () => {
  const out = await compile(
    PRELUDE +
      BADGE +
      'export default fragment(({ t, n }) => <p><Badge tone={t} label="new" /><em>{n}</em></p>)',
  )
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  assert.deepEqual(
    templates.map((t) => t.id),
    ['test.tsx#Badge', 'test.tsx#default'],
  )

  const instance = entry.holes[0]
  assert.equal(instance?.kind, 'component')
  assert.equal(instance?.nested, templates[0]?.version)
  assert.deepEqual(instance?.props, { tone: 't', label: 'd0' })
  assert.equal(instance?.provenance, 'test.tsx#Badge')

  // The instance occupies one element position, so the sibling after it does not shift.
  assert.deepEqual(entry.holes[1]?.path, [0, 1])

  const resolve = versions(templates)
  assert.equal(
    decode(render(entry, { t: 'warn', n: 3 }, resolve)),
    '<p><span class="warn">new</span><em>3</em></p>',
  )
})

test('one component used twice is one sealed template', async () => {
  const out = await compile(
    PRELUDE +
      BADGE +
      'export default fragment(({ a, b }) => <p><Badge tone={a} label="x" /><Badge tone={b} label="y" /></p>)',
  )
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  assert.equal(templates.length, 2, 'the child is sealed once, because the version is the content')
  assert.equal(entry.holes[0]?.nested, entry.holes[1]?.nested)
  assert.equal(
    decode(render(entry, { a: 'warn', b: 'ok' }, versions(templates))),
    '<p><span class="warn">x</span><span class="ok">y</span></p>',
  )
})

test("a shared component's reads become its caller's reads", async () => {
  const out = await compile(
    PRELUDE +
      "const Money = fragment((ctx) => { const c = ctx.cookie('currency'); return <b>{c}</b> })\n" +
      'export default fragment(() => <p><Money /></p>)',
  )
  const { entry } = out.fragments[0] as { entry: TemplateIR }
  assert.deepEqual(entry.effects.reads, ['cookie:currency'])
  assert.equal(cacheClassOf(entry.effects), 'shared')
  assert.equal(entry.holes.find((h) => h.kind === 'component')?.isolated, undefined, 'inlined')
  assert.equal(entry.forms.includes('delta'), true)
})

test('a private component does not make its caller private; it becomes its own cache unit', async () => {
  const out = await compile(
    PRELUDE +
      'const Who = fragment(async (ctx) => { const who = await ctx.user(); return <b>{who}</b> })\n' +
      "export default fragment((ctx) => { const c = ctx.cookie('currency'); return <p>{c}<Who /></p> })",
  )
  const { entry } = out.fragments[0] as { entry: TemplateIR }
  assert.deepEqual(entry.effects.reads, ['cookie:currency'], 'identity is contained, not inherited')
  assert.equal(cacheClassOf(entry.effects), 'shared', 'the route stays shareable')
  assert.equal(entry.holes.find((h) => h.kind === 'component')?.isolated, true)
  assert.equal(entry.forms.includes('delta'), false, 'a hole this render does not fill is not projectable')
})

test('a caller that is already private inlines a private component rather than cutting it out', async () => {
  const out = await compile(
    PRELUDE +
      'const Who = fragment(async (ctx) => { const who = await ctx.user(); return <b>{who}</b> })\n' +
      'export default fragment(async (ctx) => { const me = await ctx.user(); return <p>{me}<Who /></p> })',
  )
  const { entry } = out.fragments[0] as { entry: TemplateIR }
  assert.equal(cacheClassOf(entry.effects), 'private')
  assert.equal(entry.holes.find((h) => h.kind === 'component')?.isolated, undefined, 'nothing to contain')
})

test('a component that renders itself is refused rather than expanded', async () => {
  await rejects(
    'const Node = fragment(({ n }) => <li><Node n={n} /></li>)\nexport default fragment(({ n }) => <ul><Node n={n} /></ul>)',
    'E_COMPONENT_CYCLE',
  )
})

test('the refusals around a component name what is missing', async () => {
  await rejects(
    BADGE + 'export default fragment(({ t }) => <p><Badge tone={t} /></p>)',
    'E_COMPONENT_PROP_MISSING',
  )
  await rejects(
    BADGE + 'export default fragment(({ t }) => <p><Badge tone={t} label="a" extra={t} /></p>)',
    'E_COMPONENT_PROP_UNKNOWN',
  )
  await rejects(
    BADGE + 'export default fragment(({ t }) => <p><Badge tone={t} label="a">child</Badge></p>)',
    'E_COMPONENT_CHILDREN_UNDECLARED',
  )
  await rejects(
    'const Two = fragment(() => <><p>a</p><p>b</p></>)\nexport default fragment(() => <div><Two /></div>)',
    'E_COMPONENT_NOT_SINGLE_ROOT',
  )
})

const CARD =
  'const Card = fragment(({ children }) => <section><div class="body">{children}</div></section>)\n'

test("a component takes children, and the call site's markup becomes a template of its own", async () => {
  const out = await compile(
    PRELUDE + CARD + 'export default fragment(({ n }) => <main><Card><p>{n}</p></Card></main>)',
  )
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  const instance = entry.holes[0]
  assert.equal(instance?.kind, 'component')

  const card = templates.find((t) => t.id === 'test.tsx#Card') as TemplateIR
  const content = templates.find((t) => t.id === 'test.tsx#default:c0<>') as TemplateIR
  assert.equal(instance?.nested, card.version, 'the fragment it renders')
  assert.equal(instance?.children, content.version, 'and the markup written between its tags')
  assert.equal(card.holes[0]?.kind, 'children', 'the child names the place, never the content')

  // The content stayed in the caller's namespace: no projection, no renaming.
  assert.equal(content.holes[0]?.binding, 'n')
  assert.equal(
    decode(render(entry, { n: 'hello' }, versions(templates))),
    '<main><section><div class="body"><p>hello</p></div></section></main>',
  )
})

test('one component with two different children is one sealed child and two contents', async () => {
  const out = await compile(
    PRELUDE +
      CARD +
      'export default fragment(({ a, b }) => <main><Card><p>{a}</p></Card><Card><i>{b}</i></Card></main>)',
  )
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  assert.equal(entry.holes[0]?.nested, entry.holes[1]?.nested, 'one template, used twice')
  assert.notEqual(entry.holes[0]?.children, entry.holes[1]?.children, 'two call sites, two contents')
  assert.equal(
    decode(render(entry, { a: 'x', b: 'y' }, versions(templates))),
    '<main><section><div class="body"><p>x</p></div></section>' +
      '<section><div class="body"><i>y</i></div></section></main>',
  )
})

test("a component may hand its own children on, and the inner one still means the caller's", async () => {
  const out = await compile(
    PRELUDE +
      CARD +
      'const Panel = fragment(({ children }) => <aside><Card>{children}</Card></aside>)\n' +
      'export default fragment(({ n }) => <main><Panel><b>{n}</b></Panel></main>)',
  )
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  assert.equal(
    decode(render(entry, { n: 'deep' }, versions(templates))),
    '<main><aside><section><div class="body"><b>deep</b></div></section></aside></main>',
  )
})

test('the refusals around children say where the markup goes and where it does not', async () => {
  await rejects(CARD + 'export default fragment(() => <main><Card /></main>)', 'E_COMPONENT_PROP_MISSING')
  await rejects(
    CARD + 'export default fragment(({ n }) => <main><Card children={n} /></main>)',
    'E_CHILDREN_AS_PROP',
  )
  await rejects(
    'export default fragment(({ children }) => <p class={children}>x</p>)',
    'E_CHILDREN_NOT_A_VALUE',
  )
  await rejects(
    'const C = fragment(({ children }) => <section><h2>t</h2>{children}</section>)\n' +
      'export default fragment(() => <main><C><p>x</p></C></main>)',
    'E_CHILDREN_NOT_SOLE_CHILD',
  )
})

test('a list row carries an instance, and the row template names the child', async () => {
  const out = await compile(
    PRELUDE +
      BADGE +
      'export default fragment(({ rows }) => <ul>{rows.map((r) => <li><Badge tone={r.tone} label={r.name} /></li>)}</ul>)',
  )
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  const row = templates.find((t) => t.id.endsWith(':rows[]')) as TemplateIR
  const instance = row.holes.find((h) => h.kind === 'component')
  assert.equal(instance?.provenance, 'test.tsx#Badge')
  assert.deepEqual(instance?.props, { tone: 'tone', label: 'name' }, 'row fields, not outer bindings')
  assert.equal(
    decode(
      render(
        entry,
        {
          rows: [
            { tone: 'ok', name: 'a' },
            { tone: 'warn', name: 'b' },
          ],
        } as never,
        versions(templates),
      ),
    ),
    '<ul><li><span class="ok">a</span></li><li><span class="warn">b</span></li></ul>',
  )
})

test("a component rendered inside a row still composes its reads into the caller's", async () => {
  const out = await compile(
    PRELUDE +
      "const Money = fragment((ctx) => { const c = ctx.cookie('currency'); return <b>{c}</b> })\n" +
      'export default fragment(({ rows }) => <ul>{rows.map((r) => <li><Money /></li>)}</ul>)',
  )
  const { entry } = out.fragments[0] as { entry: TemplateIR }
  assert.deepEqual(entry.effects.reads, ['cookie:currency'], 'a row is not a wall around a read')
  assert.equal(cacheClassOf(entry.effects), 'shared')
})

test('a private component inside a row is refused, because a row has no boundary to cut', async () => {
  await rejects(
    'const Who = fragment(async (ctx) => { const w = await ctx.user(); return <b>{w}</b> })\n' +
      'export default fragment(({ rows }) => <ul>{rows.map((r) => <li><Who /></li>)}</ul>)',
    'E_PRIVATE_COMPONENT_NESTED',
  )
  await rejects(
    'const Who = fragment(async (ctx) => { const w = await ctx.user(); return <b>{w}</b> })\n' +
      'const Card = fragment(({ children }) => <section><div>{children}</div></section>)\n' +
      'export default fragment(() => <main><Card><Who /></Card></main>)',
    'E_PRIVATE_COMPONENT_NESTED',
  )
})

test("an intent on a component binds to the instance's root element", async () => {
  const ir = await only(
    BADGE + 'export default fragment(({ t }) => <p><Badge tone={t} label="a" onClick={save} /></p>)',
  )
  assert.deepEqual(
    ir.wiring.map((w) => [w.op, w.event, w.path]),
    [['event', 'click', [0, 0]]],
    'the path is the hole the instance occupies, which is one element',
  )
})

test('a reordered list of rows carrying instances still costs no row render', async () => {
  const out = await compileFile(fixture('rows-of-components.tsx'))
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  const resolve = versions(templates)
  const rows = Array.from({ length: 10 }, (_, i) => ({
    sku: i,
    name: `item ${i}`,
    tone: i % 2 ? 'ok' : 'warn',
    label: 'in stock',
  }))
  const values = { epoch: 'e1', rows } as unknown as Values
  const memo = createSegmentMemo()

  const cold = renderIncremental({ ir: entry, values, memo, resolve })
  assert.deepEqual(cold.bytes, render(entry, values, resolve), 'incremental is byte-identical or it is a bug')

  const reversed = { epoch: 'e1', rows: rows.toReversed() } as unknown as Values
  const warm = renderIncremental({ ir: entry, values: reversed, memo, resolve })
  assert.equal(warm.stats.segments.rendered, 0, 'a row is content-addressed, instance and all')
  assert.equal(warm.stats.segments.reused, 10)
  assert.deepEqual(warm.bytes, render(entry, reversed, resolve))
})

test('a delta reaches a value that only the children markup reads', async () => {
  const out = await compileFile(fixture('children.tsx'))
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  const resolve = versions(templates)
  const before = { heading: 'Cart', note: 'two items', total: 12000 } as unknown as Values
  const after = { ...before, note: 'one item' } as unknown as Values

  const delta = deltaPayload(entry, baseRenderId(entry, before), before, after, resolve)
  assert.deepEqual(
    Object.keys(delta.changed),
    ['note'],
    "children are the caller's markup, so the caller's name for the value is the address",
  )
  assert.deepEqual(
    [...render(entry, applyDelta(before, delta, entry, resolve), resolve)],
    [...render(entry, after, resolve)],
  )
})

test('a delta into a row instance is addressed through the row, and inverts back', async () => {
  const out = await compileFile(fixture('rows-of-components.tsx'))
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  const resolve = versions(templates)
  const rows = [
    { sku: 1, name: 'a', tone: 'ok', label: 'in stock' },
    { sku: 2, name: 'b', tone: 'ok', label: 'in stock' },
  ]
  const before = { epoch: 'e1', rows } as unknown as Values
  const after = {
    epoch: 'e1',
    rows: [rows[0], { ...rows[1], label: 'low' }],
  } as unknown as Values

  const delta = deltaPayload(entry, baseRenderId(entry, before), before, after, resolve)
  assert.deepEqual(Object.keys(delta.changed), ['rows[1].c0.label'])
  assert.deepEqual(
    [...render(entry, applyDelta(before, delta, entry, resolve), resolve)],
    [...render(entry, after, resolve)],
  )
})

test('a value a component computes for itself cannot be inverted back, and says so', async () => {
  const out = await compileFile(fixture('composed.tsx'))
  const { entry, templates } = out.fragments[0] as { entry: TemplateIR; templates: TemplateIR[] }
  const resolve = versions(templates)
  const before = { sku: 1, price: 2599, qty: 1 } as unknown as Values
  const after = { sku: 1, price: 2999, qty: 1 } as unknown as Values

  const delta = deltaPayload(entry, baseRenderId(entry, before), before, after, resolve)
  // The child renders `amount / 100`; the caller's value set has no binding for the result,
  // so a delta that names it is applicable to a DOM and not to a set of values.
  assert.equal(
    Object.keys(delta.changed).some((k) => k.startsWith('c0.')),
    true,
  )
  assert.throws(
    () => applyDelta(before, delta, entry, resolve),
    /E_DELTA_NOT_INVERTIBLE/,
    'refused by name rather than reconstructed into a plausible wrong render',
  )
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

test('a fragment composes one from another module, compiled child first', async () => {
  // Listed parent first on purpose: the build has to find the order, not be handed it.
  const { modules } = await compileFiles([fixture('imported.tsx'), fixture('badge.tsx')], {
    types: false,
  })
  assert.deepEqual(
    modules.map((m) => m.file.endsWith('imported.tsx')),
    [true, false],
    'modules come back in the order the caller asked for',
  )

  const parent = modules[0]?.fragments[0] as CompiledFragment
  const badge = modules[1]?.fragments[0] as CompiledFragment
  const instance = parent.entry.holes.find((h) => h.kind === 'component')
  assert.equal(instance?.nested, badge.entry.version, 'the parent names the version it was sealed at')
  assert.equal(instance?.provenance?.endsWith('badge.tsx#Badge'), true)
  assert.ok(
    parent.templates.some((t) => t.version === badge.entry.version),
    'the child travels with the parent, so a resolver has it',
  )

  // Composed from another module, so its props are wired: the caller passed a signal.
  assert.deepEqual(
    badge.entry.wiring.map((w) => [w.op, w.binding]),
    [
      ['attr', 'tone'],
      ['text', 'label'],
    ],
  )

  const byVersion = new Map(parent.templates.map((t) => [t.version, t]))
  assert.equal(
    decode(render(parent.entry, { sku: 5, tone: 'warn' }, (v) => byVersion.get(v))),
    '<form data-sku="5"><span class="warn">in stock</span></form>',
  )
})

test('two modules that render each other are refused, not unrolled', async () => {
  await assert.rejects(
    () => compileFiles([fixture('cycle-a.tsx'), fixture('cycle-b.tsx')], { types: false }),
    (error: unknown) => {
      assert.ok(error instanceof CompileError)
      assert.equal(error.code, 'E_COMPONENT_CYCLE')
      assert.match(error.message, /cycle-a\.tsx.*cycle-b\.tsx/s)
      return true
    },
  )
})

test('a fragment nobody composes carries no wiring for its props', async () => {
  const { modules } = await compileFiles([fixture('badge.tsx')], { types: false })
  assert.deepEqual(modules[0]?.fragments[0]?.entry.wiring, [], 'compiled alone, it is not composable')
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

test("a control's live state binds to the property, not the attribute", async () => {
  const ir = await only(
    'export default fragment(() => { const n = signal(1); return <p><input type="text" value={n()} /></p> })',
  )
  assert.equal(ir.holes[0]?.kind, 'attr', 'the server still renders the attribute')
  assert.equal(decode(render(ir, { n: 5 })), '<p><input type="text" value="5"></p>')
  assert.equal(ir.wiring[0]?.op, 'prop', 'the client writes the property behind it')
  assert.equal(ir.wiring[0]?.attr, 'value')
})

test('a checkbox binds checked as a property while still rendering the attribute', async () => {
  const ir = await only(
    'export default fragment(() => { const on = signal(true); return <p><input type="checkbox" checked={on()} /></p> })',
  )
  assert.equal(ir.holes[0]?.kind, 'attr-bool')
  assert.equal(decode(render(ir, { on: true })), '<p><input type="checkbox" checked></p>')
  assert.equal(decode(render(ir, { on: false })), '<p><input type="checkbox" ></p>')
  assert.equal(ir.wiring[0]?.op, 'prop')
})

test('the same attribute on an element that is not a control stays an attribute', async () => {
  const ir = await only(
    'export default fragment(() => { const n = signal(1); return <p><li value={n()}>x</li></p> })',
  )
  assert.equal(ir.wiring[0]?.op, 'attr')
})
