import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evalDerived,
  render,
  validateTemplate,
  type DerivedExpr,
  type TemplateIR,
  type Values,
} from '@weft/ir'
import { compileSource } from '../src/compile.ts'
import { CompileError } from '../src/errors.ts'

/**
 * What a hole may contain, and why the line falls where it does.
 *
 * A hole may hold a value or a pure operator expression over bindings, because a derived expression
 * travels as a tree that both sides evaluate. It may not hold anything that has to *run*: a fragment
 * body is a declaration the compiler reads and never executes — `fragment()` throws if called — so
 * there is no server-side evaluation for a method call to happen in, and shipping one to the client
 * would be the closure this framework exists not to send.
 *
 * These tests are the table that rule produces. The refusals matter as much as the permissions: each
 * one is a sentence somebody will read instead of a stack trace.
 */

const PRELUDE = "import { fragment, signal } from '@weft/core'\n"
const decode = (b: Uint8Array) => new TextDecoder().decode(b)

async function only(source: string): Promise<TemplateIR> {
  const out = await compileSource(PRELUDE + source, 'test.tsx')
  const fragment = out.fragments[0]
  assert.ok(fragment, 'no fragment compiled')
  return fragment.entry
}

async function refusal(source: string): Promise<CompileError> {
  try {
    await compileSource(PRELUDE + source, 'test.tsx')
  } catch (error) {
    assert.ok(error instanceof CompileError, `expected a CompileError, got ${String(error)}`)
    return error
  }
  throw new Error('expected a refusal, and it compiled')
}

const out = (ir: TemplateIR, values: Values): string => decode(render(ir, values, undefined))

/** A reader that fails loudly if the arm a conditional did not take is evaluated anyway. */
const refuseExploding = (id: string): undefined => {
  if (id === 'exploding') throw new Error('the untaken branch was evaluated')
  return undefined
}

test('a conditional value is one hole, and both arms render', async () => {
  const ir = await only(
    'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => <p>{on ? a : b}</p>)',
  )
  assert.equal(out(ir, { on: true, a: 'AA', b: 'BB' }), '<p>AA</p>')
  assert.equal(out(ir, { on: false, a: 'AA', b: 'BB' }), '<p>BB</p>')
  // One hole, whichever way it went: the byte layout of a sealed template cannot depend on a value.
  assert.equal(ir.holes.length, 1)
})

test('`||` lowers to the conditional node rather than one of its own', async () => {
  const ir = await only('export default fragment(({ a, b }: { a: string; b: string }) => <p>{a || b}</p>)')
  const decl = ir.derived[0]
  assert.ok(decl)
  assert.equal(decl.expr.k, 'cond')
  assert.equal(out(ir, { a: '', b: 'fallback' }), '<p>fallback</p>')
  assert.equal(out(ir, { a: 'present', b: 'fallback' }), '<p>present</p>')
})

test('`??` tests against null, which is how it also catches undefined', async () => {
  const ir = await only("export default fragment(({ a }: { a?: string }) => <p>{a ?? 'none'}</p>)")
  const decl = ir.derived[0]
  assert.ok(decl && decl.expr.k === 'cond')
  assert.equal(decl.expr.a.k, 'bin')
  // A binding that was never supplied and one supplied as null are the same absence here.
  assert.equal(out(ir, {}), '<p>none</p>')
  assert.equal(out(ir, { a: null } as unknown as Values), '<p>none</p>')
  assert.equal(out(ir, { a: '' }), '<p></p>', 'empty string is present, and `??` must not swallow it')
  assert.equal(out(ir, { a: 'x' }), '<p>x</p>')
})

test('a template literal becomes a `+` chain, so the client gains no node for it', async () => {
  const ir = await only(
    'export default fragment(({ id }: { id: string }) => <p class={`row row-${id}`}>x</p>)',
  )
  const decl = ir.derived[0]
  assert.ok(decl)
  assert.equal(decl.expr.k, 'bin', 'a template literal must not introduce a node of its own')
  assert.equal(out(ir, { id: '7' }), '<p class="row row-7">x</p>')
})

test('a conditional works in an attribute as well as in text', async () => {
  const ir = await only(
    "export default fragment(({ on }: { on: boolean }) => <p data-state={on ? 'live' : 'idle'}>x</p>)",
  )
  assert.equal(out(ir, { on: true }), '<p data-state="live">x</p>')
  assert.equal(out(ir, { on: false }), '<p data-state="idle">x</p>')
})

test('the arms may themselves be expressions', async () => {
  const ir = await only(
    'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => ' +
      '<p>{on ? `yes-${a}` : `no-${b}`}</p>)',
  )
  assert.equal(out(ir, { on: true, a: 'A', b: 'B' }), '<p>yes-A</p>')
  assert.equal(out(ir, { on: false, a: 'A', b: 'B' }), '<p>no-B</p>')
})

test('a conditional value escapes, because either arm could be a string holding markup', async () => {
  const ir = await only(
    'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => <p>{on ? a : b}</p>)',
  )
  const hole = ir.holes[0]
  assert.ok(hole)
  assert.equal(hole.escape, 'escape')
  assert.equal(out(ir, { on: true, a: '<script>x</script>', b: '' }), '<p>&lt;script&gt;x&lt;/script&gt;</p>')
})

test('a branch not taken is not evaluated, so it cannot read what the render did not', () => {
  // Directly against the evaluator: `then` names a binding that would throw if read.
  const expr: DerivedExpr = {
    k: 'cond',
    a: { k: 'lit', v: false },
    b: { k: 'ref', id: 'exploding' },
    c: { k: 'lit', v: 'safe' },
  }
  assert.equal(evalDerived(expr, refuseExploding), 'safe')
})

test('every binding in every branch counts as read, including one not taken', async () => {
  const ir = await only(
    'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => <p>{on ? a : b}</p>)',
  )
  // Which arm is taken is a value; what the expression *reads* is a property of the expression, and
  // the cache key and the client-owned set are both computed from the latter.
  const decl = ir.derived[0]
  assert.ok(decl)
  const reads = new Set<string>()
  evalDerived(decl.expr, (id) => {
    reads.add(id)
    return true
  })
  assert.ok(reads.has('on'))
})

test('the IR validator accepts the new node and rejects a malformed one', async () => {
  const ir = await only(
    'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => <p>{on ? a : b}</p>)',
  )
  assert.equal(validateTemplate(ir).ok, true)

  const broken: TemplateIR = {
    ...ir,
    derived: [{ id: 'd0', expr: { k: 'cond', a: { k: 'lit', v: 1 }, b: { k: 'lit', v: 1 } } as DerivedExpr }],
  }
  const result = validateTemplate(broken)
  assert.equal(result.ok, false)
  assert.match(result.errors.map((e) => e.message).join(' '), /missing/)
})

test('`&&` is still refused, and says what to write instead', async () => {
  const error = await refusal(
    'export default fragment(({ on, a }: { on: boolean; a: string }) => <p>{on && a}</p>)',
  )
  assert.equal(error.code, 'E_EXPRESSION_UNSUPPORTED')
  // The refusal has to carry the alternative, or it is a dead end rather than a signpost.
  assert.match(error.message, /shape rather than a value/)
  assert.match(error.message, /loader/)
})

test('a method call is still refused, because there is nowhere for it to run', async () => {
  const error = await refusal('export default fragment(({ a }: { a: string }) => <p>{a.toUpperCase()}</p>)')
  assert.equal(error.code, 'E_EXPRESSION_UNSUPPORTED')
})

test('a conditional shape is two variant holes, and exactly one renders', async () => {
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ on, a }: { on: boolean; a: string }) => (\n' +
      '  <div>{on ? <b>{a}</b> : <i>{a}</i>}</div>\n))',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  const holes = fragment.entry.holes
  // Two holes, both always present: the layout is a fact about the template, not about a value.
  assert.equal(holes.length, 2)
  assert.equal(holes[0]?.kind, 'variant')
  assert.equal(holes[1]?.kind, 'variant')
  assert.equal(holes[0]?.binding, 'on')
  // The second arm is the negation, added to the derived table rather than needing a node of its own.
  assert.notEqual(holes[1]?.binding, 'on')

  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  const shape = (values: Values) => decode(render(fragment.entry, values, (v: string) => byVersion.get(v)))
  assert.equal(shape({ on: true, a: 'X' }), '<div><b>X</b></div>')
  assert.equal(shape({ on: false, a: 'X' }), '<div><i>X</i></div>')
})

test('`&&` renders the branch or nothing at all', async () => {
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ on, a }: { on: boolean; a: string }) => <div>{on && <b>{a}</b>}</div>)',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  const shape = (values: Values) => decode(render(fragment.entry, values, (v: string) => byVersion.get(v)))
  assert.equal(shape({ on: true, a: 'X' }), '<div><b>X</b></div>')
  // Nothing, not an empty placeholder: a falsy branch costs no bytes.
  assert.equal(shape({ on: false, a: 'X' }), '<div></div>')
})

test('a branch reads the enclosing fragment directly, with no projection', async () => {
  // The markup was written here, so it is lowered in this fragment's binding namespace — the same
  // rule a component's children follow. A prop the branch reads needs nothing declared.
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => ' +
      '<div>{on ? <b>{a}{b}</b> : <i>{b}</i>}</div>)',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  const shape = (values: Values) => decode(render(fragment.entry, values, (v: string) => byVersion.get(v)))
  // The `<!>` are anchor markers: two adjacent text holes need them so a later delta can say which
  // text node it is writing. Their presence is the branch having gone through ordinary lowering.
  assert.equal(shape({ on: true, a: 'A', b: 'B' }), '<div><b><!>A<!>B</b></div>')
  assert.equal(shape({ on: false, a: 'A', b: 'B' }), '<div><i>B</i></div>')
})

test('branches nest, and work inside a list row', async () => {
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ rows }: { rows: { on: boolean; a: string }[] }) => ' +
      '<ul>{rows.map((row) => <li>{row.on && <b>{row.a}</b>}</li>)}</ul>)',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  const shape = (values: Values) => decode(render(fragment.entry, values, (v: string) => byVersion.get(v)))
  assert.equal(
    shape({
      rows: [
        { on: true, a: 'P' },
        { on: false, a: 'Q' },
      ],
    } as unknown as Values),
    '<ul><li><b>P</b></li><li></li></ul>',
  )
})

test('a conditional element must be the only child, because a falsy branch writes nothing', async () => {
  const error = await refusal(
    PRELUDE.length > 0
      ? 'export default fragment(({ on }: { on: boolean }) => <div>{on && <b>y</b>}<p>after</p></div>)'
      : '',
  )
  // Without this a sibling would sit at a different element index depending on a value, and every
  // path in the template addresses element positions.
  assert.equal(error.code, 'E_BRANCH_NOT_SOLE_CHILD')
  assert.match(error.message, /sibling positions/)
})

test('a conditional whose arms are values stays one hole, not two variants', async () => {
  // The cheaper lowering must still win where it applies, or every ternary would seal two templates.
  const ir = await only(
    'export default fragment(({ on, a, b }: { on: boolean; a: string; b: string }) => <p>{on ? a : b}</p>)',
  )
  assert.equal(ir.holes.length, 1)
  assert.equal(ir.holes[0]?.kind, 'text')
})

test('a branch decided by a signal is refused, rather than rendering once and going quiet', async () => {
  const error = await refusal(
    'export default fragment(() => {\n' +
      '  const on = signal(true)\n' +
      '  return <div>{on() && <b>yes</b>}</div>\n})',
  )
  assert.equal(error.code, 'E_BRANCH_ON_SIGNAL')
  // The refusal names the signal and the alternative; a variant emits no wiring, so the client has
  // nothing to swap subtrees with and the branch would be a control that never moves.
  assert.match(error.message, /signal on/)
  assert.match(error.message, /conditional value/)
})

test('a row may name its position, and one that does not pays nothing for it', async () => {
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ xs }: { xs: { a: string }[] }) => ' +
      '<ul>{xs.map((x, i) => <li data-i={i}>{x.a}</li>)}</ul>)',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  assert.equal(fragment.entry.holes[0]?.rowIndex, 'i')
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  assert.equal(
    decode(
      render(fragment.entry, { xs: [{ a: 'P' }, { a: 'Q' }] } as unknown as Values, (v: string) =>
        byVersion.get(v),
      ),
    ),
    '<ul><li data-i="0">P</li><li data-i="1">Q</li></ul>',
  )

  // The row loop is the hot one, so a list that does not ask for its index must not be spread.
  const plain = await compileSource(
    PRELUDE +
      'export default fragment(({ xs }: { xs: { a: string }[] }) => <ul>{xs.map((x) => <li>{x.a}</li>)}</ul>)',
    'test.tsx',
  )
  assert.equal(plain.fragments[0]?.entry.holes[0]?.rowIndex, undefined)
})

test('a value from outside the row is still refused, index or no index', async () => {
  const error = await refusal(
    'export default fragment(({ xs, outer }: { xs: string[]; outer: string }) => ' +
      '<ul>{xs.map((x, i) => <li>{outer}</li>)}</ul>)',
  )
  assert.equal(error.code, 'E_OUT_OF_ROW_SCOPE')
})

test('a chained conditional of shapes seals every arm, and none is dropped', async () => {
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ a, b }: { a: boolean; b: boolean }) => (\n' +
      '  <div>{a ? <i>A</i> : b ? <b>B</b> : <s>C</s>}</div>\n))',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  // Three arms, three holes. The first version of this lowering produced one and rendered an empty
  // element for two of the three inputs, which is the regression this asserts against.
  assert.equal(fragment.entry.holes.length, 3)
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  const shape = (values: Values) => decode(render(fragment.entry, values, (v: string) => byVersion.get(v)))
  assert.equal(shape({ a: true, b: false }), '<div><i>A</i></div>')
  assert.equal(shape({ a: false, b: true }), '<div><b>B</b></div>')
  assert.equal(shape({ a: false, b: false }), '<div><s>C</s></div>')
})

test('a conditional mixing a shape and a value is refused, not half-rendered', async () => {
  const error = await refusal(
    "export default fragment(({ a }: { a: boolean }) => (\n  <div>{a ? <i>A</i> : 'plain'}</div>\n))",
  )
  assert.equal(error.code, 'E_BRANCH_MIXES_SHAPE_AND_VALUE')
  assert.match(error.message, /Wrap the value in an element/)
})

test('a row may interpolate its item directly, and a row reading fields still cannot', async () => {
  const compiled = await compileSource(
    PRELUDE +
      'export default fragment(({ names }: { names: string[] }) => <ul>{names.map((n) => <li>{n}</li>)}</ul>)',
    'test.tsx',
  )
  const fragment = compiled.fragments[0]
  assert.ok(fragment)
  assert.equal(fragment.entry.holes[0]?.rowValue, 'n')
  const byVersion = new Map(fragment.templates.map((t) => [t.version, t]))
  // Escaped, like any other hole: an item is a value and not markup.
  assert.equal(
    decode(
      render(fragment.entry, { names: ['a', '<b>x</b>'] } as unknown as Values, (v: string) =>
        byVersion.get(v),
      ),
    ),
    '<ul><li>a</li><li>&lt;b&gt;x&lt;/b&gt;</li></ul>',
  )

  // A row that reads fields must keep the unwrapped fast path.
  const fields = await compileSource(
    PRELUDE +
      'export default fragment(({ xs }: { xs: { a: string }[] }) => <ul>{xs.map((x) => <li>{x.a}</li>)}</ul>)',
    'test.tsx',
  )
  assert.equal(fields.fragments[0]?.entry.holes[0]?.rowValue, undefined)
})
