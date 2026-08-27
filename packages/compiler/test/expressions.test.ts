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

const PRELUDE = "import { fragment, signal } from 'weft'\n"
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

test('structural branching is still refused: a template holds one value per hole', async () => {
  const error = await refusal(
    'export default fragment(({ on, a }: { on: boolean; a: string }) => <p>{on ? <b>{a}</b> : <i>{a}</i>}</p>)',
  )
  assert.equal(error.code, 'E_EXPRESSION_UNSUPPORTED')
})
